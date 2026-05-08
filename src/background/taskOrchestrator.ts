import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import type { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import type { ProviderProfile } from "@/provider/types";
import { splitSegmentsIntoBatches } from "@/translation/batch";
import { SessionTranslationCache } from "@/translation/cache";
import { createCacheKey } from "@/translation/hash";
import { parseTranslationBatchResult } from "@/translation/jsonResult";
import { buildTranslationPrompt, translationPromptVersion } from "@/translation/prompt";
import { isTerminalTaskState } from "@/translation/types";
import type {
  CancelReason,
  PageSegment,
  TranslationCacheKey,
  TranslationProgress,
  TranslationResultItem,
} from "@/translation/types";

const maxCharsPerBatch = 6000;
const maxSegmentsPerBatch = 12;
const maxBatchAttempts = 2;
const translationStyle = "default";

export type TranslationTaskOrchestratorDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  provider: Pick<OpenAiCompatibleProvider, "generateText">;
  sendToContent: (tabId: number, message: ContentRequest) => Promise<ContentResponse>;
  emitProgress?: (progress: TranslationProgress) => void | Promise<void>;
  now: () => number;
  createTaskId: () => string;
};

export type TranslatePageInput = {
  tabId: number;
  sourceLanguage: string;
  targetLanguage: string;
};

type RunningTask = {
  tabId: number;
  controller: AbortController;
  progress: TranslationProgress;
  createdAt: number;
  updatedAt: number;
};

export class TranslationTaskOrchestrator {
  private readonly tasks = new Map<string, RunningTask>();
  private readonly cache = new SessionTranslationCache();

  constructor(private readonly dependencies: TranslationTaskOrchestratorDependencies) {}

  async translatePage(input: TranslatePageInput): Promise<TranslationProgress> {
    const task = this.createTranslatePageTask(input);
    return this.executeTranslatePage(task, input);
  }

  startTranslatePage(input: TranslatePageInput): TranslationProgress {
    const task = this.createTranslatePageTask(input);
    void this.executeTranslatePage(task, input);
    return this.cloneProgress(task.progress);
  }

  private createTranslatePageTask(input: TranslatePageInput): RunningTask {
    this.cancelTasksForTab(input.tabId, "superseded");

    const taskId = this.dependencies.createTaskId();
    return this.createTask(taskId, input.tabId);
  }

  private async executeTranslatePage(
    task: RunningTask,
    input: TranslatePageInput,
  ): Promise<TranslationProgress> {
    try {
      const collectResponse = await this.dependencies.sendToContent(input.tabId, {
        type: "collectSegments",
        taskId: task.progress.taskId,
      });

      if (
        collectResponse.type !== "collectSegmentsResult" ||
        collectResponse.taskId !== task.progress.taskId
      ) {
        return this.failTask(task, "Content script did not return page segments.");
      }

      const segments = collectResponse.segments;
      const profile = await this.dependencies.getActiveProfile();
      if (!profile) {
        this.updateProgress(task, { total: segments.length });
        return this.failTask(task, "No active provider profile.", segments.length);
      }

      this.updateProgress(task, {
        state: "translating",
        total: segments.length,
      });

      await this.translateSegments({
        task,
        segments,
        profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      });

      if (task.progress.state === "cancelled") {
        return this.cloneProgress(task.progress);
      }

      this.updateProgress(task, {
        state: task.progress.failed === 0 ? "completed" : "completedWithErrors",
      });
      return this.cloneProgress(task.progress);
    } catch (error) {
      if (task.controller.signal.aborted || task.progress.state === "cancelled") {
        return this.cancelTask(task.progress.taskId, "userCancelled");
      }

      return this.failTask(
        task,
        error instanceof Error ? error.message : "Translation task failed.",
        task.progress.total,
      );
    }
  }

  cancelTask(taskId: string, reason: CancelReason): TranslationProgress {
    void reason;

    const task = this.tasks.get(taskId);
    if (!task) {
      return {
        taskId,
        state: "cancelled",
        total: 0,
        translated: 0,
        failed: 0,
      };
    }

    task.controller.abort();
    this.updateProgress(task, { state: "cancelled" });
    return this.cloneProgress(task.progress);
  }

  getTask(taskId: string): TranslationProgress | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.cloneProgress(task.progress) : undefined;
  }

  getTaskForTab(tabId: number): TranslationProgress | undefined {
    const task = [...this.tasks.values()]
      .filter((candidate) => candidate.tabId === tabId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];

    return task ? this.cloneProgress(task.progress) : undefined;
  }

  private createTask(taskId: string, tabId: number): RunningTask {
    const timestamp = this.dependencies.now();
    const task: RunningTask = {
      tabId,
      controller: new AbortController(),
      createdAt: timestamp,
      updatedAt: timestamp,
      progress: {
        taskId,
        state: "collecting",
        total: 0,
        translated: 0,
        failed: 0,
      },
    };

    this.tasks.set(taskId, task);
    return task;
  }

  private cancelTasksForTab(tabId: number, reason: CancelReason): void {
    for (const task of this.tasks.values()) {
      if (task.tabId === tabId && !isTerminalTaskState(task.progress.state)) {
        this.cancelTask(task.progress.taskId, reason);
      }
    }
  }

  private async translateSegments(input: {
    task: RunningTask;
    segments: PageSegment[];
    profile: ProviderProfile;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<void> {
    const uncachedSegments: PageSegment[] = [];

    for (const segment of input.segments) {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      const key = await this.cacheKeyForSegment(segment, input);
      const cachedItem = this.cache.get(key);
      if (cachedItem) {
        await this.applyTranslations(input.task, [
          {
            segmentId: segment.id,
            translatedText: cachedItem.translatedText,
          },
        ]);
      } else {
        uncachedSegments.push(segment);
      }
    }

    for (const batch of splitSegmentsIntoBatches(uncachedSegments, {
      maxCharsPerBatch,
      maxSegmentsPerBatch,
    })) {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      await this.translateBatch({ ...input, segments: batch });
    }
  }

  private async translateBatch(input: {
    task: RunningTask;
    segments: PageSegment[];
    profile: ProviderProfile;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<void> {
    await this.translateBatchWithFallback(input, 0);
  }

  private async translateBatchWithFallback(
    input: {
      task: RunningTask;
      segments: PageSegment[];
      profile: ProviderProfile;
      sourceLanguage: string;
      targetLanguage: string;
    },
    attempt: number,
  ): Promise<void> {
    try {
      const missingSegments = await this.requestAndApplyBatch(input);

      if (this.isTaskCancelled(input.task)) {
        return;
      }

      if (missingSegments.length === 0) {
        return;
      }

      await this.retryOrDegradeBatch({ ...input, segments: missingSegments }, attempt);
    } catch {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      await this.retryOrDegradeBatch(input, attempt);
    }
  }

  private async requestAndApplyBatch(input: {
    task: RunningTask;
    segments: PageSegment[];
    profile: ProviderProfile;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<PageSegment[]> {
    const response = await this.dependencies.provider.generateText({
      profile: input.profile,
      prompt: buildTranslationPrompt({
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        segments: input.segments,
      }),
      abortSignal: input.task.controller.signal,
    });

    if (this.isTaskCancelled(input.task)) {
      return [];
    }

    const expectedSegmentIds = input.segments.map((segment) => segment.id);
    const parsed = parseTranslationBatchResult(response.text, expectedSegmentIds);

    if (this.isTaskCancelled(input.task)) {
      return [];
    }

    if (parsed.items.length > 0) {
      const appliedItems = await this.applyTranslations(input.task, parsed.items);

      if (appliedItems.length > 0) {
        await this.cacheAppliedItems(input, appliedItems);
      }
    }

    const missingIds = new Set(parsed.missingSegmentIds);
    return input.segments.filter((segment) => missingIds.has(segment.id));
  }

  private async retryOrDegradeBatch(
    input: {
      task: RunningTask;
      segments: PageSegment[];
      profile: ProviderProfile;
      sourceLanguage: string;
      targetLanguage: string;
    },
    attempt: number,
  ): Promise<void> {
    if (this.isTaskCancelled(input.task) || input.segments.length === 0) {
      return;
    }

    if (attempt + 1 < maxBatchAttempts) {
      await this.translateBatchWithFallback(input, attempt + 1);
      return;
    }

    if (input.segments.length === 1) {
      this.incrementProgress(input.task, {
        failed: 1,
      });
      return;
    }

    const midpoint = Math.ceil(input.segments.length / 2);
    const batches = [
      input.segments.slice(0, midpoint),
      input.segments.slice(midpoint),
    ];

    for (const segments of batches) {
      await this.translateBatchWithFallback({ ...input, segments }, 0);
    }
  }

  private async applyTranslations(
    task: RunningTask,
    items: TranslationResultItem[],
  ): Promise<TranslationResultItem[]> {
    if (this.isTaskCancelled(task)) {
      return [];
    }

    try {
      const response = await this.dependencies.sendToContent(task.tabId, {
        type: "applyTranslations",
        taskId: task.progress.taskId,
        items,
      });

      if (this.isTaskCancelled(task)) {
        return [];
      }

      if (response.type === "contentActionResult") {
        const appliedIds = new Set(
          response.appliedSegmentIds ??
            (response.success ? items.map((item) => item.segmentId) : []),
        );
        const failedIds = new Set(response.failedSegmentIds ?? []);
        const appliedItems = items.filter((item) => appliedIds.has(item.segmentId));
        const explicitFailures = items.filter((item) => failedIds.has(item.segmentId));
        const implicitFailures = response.success
          ? []
          : items.filter(
              (item) => !appliedIds.has(item.segmentId) && !failedIds.has(item.segmentId),
            );

        this.incrementProgress(task, {
          translated: appliedItems.length,
          failed: explicitFailures.length + implicitFailures.length,
        });
        return appliedItems;
      }

      this.incrementProgress(task, {
        failed: items.length,
      });
      return [];
    } catch {
      if (this.isTaskCancelled(task)) {
        return [];
      }

      this.incrementProgress(task, { failed: items.length });
      return [];
    }
  }

  private async cacheAppliedItems(
    input: {
      segments: PageSegment[];
      profile: ProviderProfile;
      sourceLanguage: string;
      targetLanguage: string;
    },
    items: TranslationResultItem[],
  ): Promise<void> {
    const itemsBySegmentId = new Map(items.map((item) => [item.segmentId, item]));

    for (const segment of input.segments) {
      const item = itemsBySegmentId.get(segment.id);
      if (!item) {
        continue;
      }

      this.cache.set(await this.cacheKeyForSegment(segment, input), item);
    }
  }

  private async cacheKeyForSegment(
    segment: PageSegment,
    input: {
      profile: ProviderProfile;
      sourceLanguage: string;
      targetLanguage: string;
    },
  ): Promise<TranslationCacheKey> {
    return createCacheKey({
      sourceText: segment.sourceText,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      providerId: input.profile.id,
      textModel: input.profile.textModel,
      translationStyle,
      promptVersion: translationPromptVersion,
    });
  }

  private failTask(
    task: RunningTask,
    errorMessage: string,
    failed = task.progress.total,
  ): TranslationProgress {
    this.updateProgress(task, {
      state: "failed",
      failed,
      errorMessage,
    });
    return this.cloneProgress(task.progress);
  }

  private updateProgress(
    task: RunningTask,
    progress: Partial<TranslationProgress>,
  ): void {
    task.progress = {
      ...task.progress,
      ...progress,
    };
    task.updatedAt = this.dependencies.now();
    void this.dependencies.emitProgress?.(this.cloneProgress(task.progress));
  }

  private incrementProgress(
    task: RunningTask,
    delta: Pick<Partial<TranslationProgress>, "translated" | "failed">,
  ): void {
    this.updateProgress(task, {
      translated: task.progress.translated + (delta.translated ?? 0),
      failed: task.progress.failed + (delta.failed ?? 0),
    });
  }

  private isTaskCancelled(task: RunningTask): boolean {
    if (task.controller.signal.aborted || task.progress.state === "cancelled") {
      this.updateProgress(task, { state: "cancelled" });
      return true;
    }

    return false;
  }

  private cloneProgress(progress: TranslationProgress): TranslationProgress {
    return { ...progress };
  }
}
