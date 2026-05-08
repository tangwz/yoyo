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
const translationStyle = "default";

export type TranslationTaskOrchestratorDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  provider: Pick<OpenAiCompatibleProvider, "generateText">;
  sendToContent: (tabId: number, message: ContentRequest) => Promise<ContentResponse>;
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
    this.cancelTasksForTab(input.tabId, "superseded");

    const taskId = this.dependencies.createTaskId();
    const task = this.createTask(taskId, input.tabId);

    try {
      const collectResponse = await this.dependencies.sendToContent(input.tabId, {
        type: "collectSegments",
        taskId,
      });

      if (
        collectResponse.type !== "collectSegmentsResult" ||
        collectResponse.taskId !== taskId
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
        return this.cancelTask(taskId, "userCancelled");
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
    try {
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
        return;
      }

      const expectedSegmentIds = input.segments.map((segment) => segment.id);
      const parsed = parseTranslationBatchResult(response.text, expectedSegmentIds);

      if (this.isTaskCancelled(input.task)) {
        return;
      }

      if (parsed.items.length > 0) {
        const applied = await this.applyTranslations(input.task, parsed.items);

        if (applied) {
          await this.cacheAppliedItems(input, parsed.items);
        }
      }

      if (this.isTaskCancelled(input.task)) {
        return;
      }

      this.incrementProgress(input.task, {
        failed: parsed.missingSegmentIds.length,
      });
    } catch {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      this.incrementProgress(input.task, {
        failed: input.segments.length,
      });
    }
  }

  private async applyTranslations(
    task: RunningTask,
    items: TranslationResultItem[],
  ): Promise<boolean> {
    if (this.isTaskCancelled(task)) {
      return false;
    }

    try {
      const response = await this.dependencies.sendToContent(task.tabId, {
        type: "applyTranslations",
        taskId: task.progress.taskId,
        items,
      });

      if (this.isTaskCancelled(task)) {
        return false;
      }

      if (response.type === "contentActionResult" && response.success) {
        this.incrementProgress(task, { translated: items.length });
        return true;
      }

      this.incrementProgress(task, {
        failed: items.length,
      });
      return false;
    } catch {
      if (this.isTaskCancelled(task)) {
        return false;
      }

      this.incrementProgress(task, { failed: items.length });
      return false;
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
