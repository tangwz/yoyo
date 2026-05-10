import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { ProviderError } from "@/provider/errors";
import type { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import type { ProviderProfile } from "@/provider/types";
import { splitSegmentsIntoBatches } from "@/translation/batch";
import { SessionTranslationCache } from "@/translation/cache";
import { createCacheKey, serializeCacheKey } from "@/translation/hash";
import { parseTranslationBatchResult } from "@/translation/jsonResult";
import { buildTranslationPrompt, translationPromptVersion } from "@/translation/prompt";
import { isTerminalTaskState } from "@/translation/types";
import type {
  CancelReason,
  PageSegment,
  TranslationCacheKey,
  TranslationMode,
  TranslationProgress,
  TranslationResultItem,
} from "@/translation/types";

const maxCharsPerBatch = 3500;
const maxSegmentsPerBatch = 10;
const maxBatchAttempts = 2;
const defaultConcurrency = 2;
const minConcurrency = 1;
const translationStyle = "default";
const rateLimitBackoffMs = 250;

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
  translationMode?: TranslationMode;
};

type TaskTranslationContext = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
};

type RunningTask = {
  tabId: number;
  controller: AbortController;
  progress: TranslationProgress;
  createdAt: number;
  updatedAt: number;
  segmentsById: Map<string, PageSegment>;
  processedSegmentIds: Set<string>;
  inFlightSegmentIds: Set<string>;
  context?: TaskTranslationContext;
  currentConcurrency: number;
  consecutiveSuccessfulBatches: number;
};

type TranslationBatchInput = TaskTranslationContext & {
  task: RunningTask;
  segments: PageSegment[];
  fanOutGroups: Map<string, PageSegment[]>;
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

  async enqueueLazySegments(
    taskId: string,
    segmentIds: readonly string[],
  ): Promise<TranslationProgress> {
    const task = this.tasks.get(taskId);
    if (!task || !task.context || this.isTaskCancelled(task) || isTerminalTaskState(task.progress.state)) {
      return task ? this.cloneProgress(task.progress) : this.emptyProgress(taskId, "completed");
    }

    const segments = [...new Set(segmentIds)]
      .map((segmentId) => task.segmentsById.get(segmentId))
      .filter((segment): segment is PageSegment => segment !== undefined);

    await this.processSegmentsForTask(task, segments);
    this.finishOrWaitForLazySegments(task);
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
      const profile = await this.dependencies.getActiveProfile();
      if (!profile) {
        return this.failTask(task, "No active provider profile.");
      }

      const translationMode = input.translationMode ?? "lazyViewport";
      const collectResponse = await this.dependencies.sendToContent(input.tabId, {
        type: "collectSegments",
        taskId: task.progress.taskId,
        translationMode,
      });

      if (
        collectResponse.type !== "collectSegmentsResult" ||
        collectResponse.taskId !== task.progress.taskId
      ) {
        return this.failTask(task, "Content script did not return page segments.");
      }

      const segments = collectResponse.segments;
      task.segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
      task.context = {
        profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translationMode,
      };

      this.updateProgress(task, {
        state: "translating",
        total: segments.length,
      });

      await this.processSegmentsForTask(
        task,
        translationMode === "lazyViewport"
          ? segments.filter((segment) => segment.priority !== "normal")
          : segments,
      );

      if (task.progress.state === "cancelled") {
        return this.cloneProgress(task.progress);
      }

      this.finishOrWaitForLazySegments(task);
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
      return this.emptyProgress(taskId, "cancelled");
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
      segmentsById: new Map(),
      processedSegmentIds: new Set(),
      inFlightSegmentIds: new Set(),
      currentConcurrency: defaultConcurrency,
      consecutiveSuccessfulBatches: 0,
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

  private async processSegmentsForTask(
    task: RunningTask,
    segments: readonly PageSegment[],
  ): Promise<void> {
    if (!task.context || this.isTaskCancelled(task)) {
      return;
    }

    const candidates = segments.filter(
      (segment) =>
        !task.processedSegmentIds.has(segment.id) && !task.inFlightSegmentIds.has(segment.id),
    );

    if (candidates.length === 0) {
      return;
    }

    for (const segment of candidates) {
      task.inFlightSegmentIds.add(segment.id);
    }

    this.updateProgress(task, { state: "translating" });

    try {
      await this.translateSegments({
        ...task.context,
        task,
        segments: candidates,
      });
    } finally {
      for (const segment of candidates) {
        task.inFlightSegmentIds.delete(segment.id);
        if (!this.isTaskCancelled(task)) {
          task.processedSegmentIds.add(segment.id);
        }
      }
    }
  }

  private async translateSegments(
    input: TaskTranslationContext & {
      task: RunningTask;
      segments: PageSegment[];
    },
  ): Promise<void> {
    const uncachedGroups = new Map<string, PageSegment[]>();
    const uncachedRepresentatives: PageSegment[] = [];
    const representativeGroups = new Map<string, PageSegment[]>();

    for (const segment of input.segments) {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      const key = await this.cacheKeyForSegment(segment, input);
      const cachedText = this.cache.get(key);
      if (cachedText !== undefined) {
        await this.applyTranslations(input.task, [
          {
            segmentId: segment.id,
            translatedText: cachedText,
          },
        ]);
        continue;
      }

      const serializedKey = serializeCacheKey(key);
      const existingGroup = uncachedGroups.get(serializedKey);
      if (existingGroup) {
        existingGroup.push(segment);
      } else {
        const group = [segment];
        uncachedGroups.set(serializedKey, group);
        representativeGroups.set(segment.id, group);
        uncachedRepresentatives.push(segment);
      }
    }

    const fanOutGroups = new Map(
      uncachedRepresentatives.map((segment) => [
        segment.id,
        representativeGroups.get(segment.id) ?? [segment],
      ]),
    );

    const batches = splitSegmentsIntoBatches(uncachedRepresentatives, {
      maxCharsPerBatch,
      maxSegmentsPerBatch,
    });

    await this.runBatchesWithConcurrency(input.task, batches, (batch) =>
      this.translateBatchWithFallback(
        {
          ...input,
          segments: batch,
          fanOutGroups,
        },
        0,
      ),
    );
  }

  private async translateBatchWithFallback(
    input: TranslationBatchInput,
    attempt: number,
  ): Promise<void> {
    try {
      const missingSegments = await this.requestAndApplyBatch(input);

      if (this.isTaskCancelled(input.task)) {
        return;
      }

      this.recordSuccessfulBatch(input.task);

      if (missingSegments.length === 0) {
        return;
      }

      await this.retryOrDegradeBatch({ ...input, segments: missingSegments }, attempt);
    } catch (error) {
      if (this.isTaskCancelled(input.task)) {
        return;
      }

      await this.handleBatchError(input.task, error);
      await this.retryOrDegradeBatch(input, attempt);
    }
  }

  private async requestAndApplyBatch(input: TranslationBatchInput): Promise<PageSegment[]> {
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
      const fanOutItems = parsed.items.flatMap((item) =>
        this.fanOutTranslationItem(item, input.fanOutGroups),
      );
      const appliedItems = await this.applyTranslations(input.task, fanOutItems);

      if (appliedItems.length > 0) {
        await this.cacheAppliedGroups(input, parsed.items, appliedItems);
      }
    }

    const missingIds = new Set(parsed.missingSegmentIds);
    return input.segments.filter((segment) => missingIds.has(segment.id));
  }

  private fanOutTranslationItem(
    item: TranslationResultItem,
    fanOutGroups: Map<string, PageSegment[]>,
  ): TranslationResultItem[] {
    return (fanOutGroups.get(item.segmentId) ?? []).map((segment) => ({
      segmentId: segment.id,
      translatedText: item.translatedText,
    }));
  }

  private async cacheAppliedGroups(
    input: TranslationBatchInput,
    representativeItems: TranslationResultItem[],
    appliedItems: TranslationResultItem[],
  ): Promise<void> {
    const appliedIds = new Set(appliedItems.map((item) => item.segmentId));

    for (const item of representativeItems) {
      const group = input.fanOutGroups.get(item.segmentId) ?? [];
      if (group.length === 0 || !group.every((segment) => appliedIds.has(segment.id))) {
        continue;
      }

      this.cache.set(await this.cacheKeyForSegment(group[0], input), item.translatedText);
    }
  }

  private async retryOrDegradeBatch(
    input: TranslationBatchInput,
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
      const failedCount = input.fanOutGroups.get(input.segments[0].id)?.length ?? 1;
      this.incrementProgress(input.task, { failed: failedCount });
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
    if (items.length === 0 || this.isTaskCancelled(task)) {
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

      this.incrementProgress(task, { failed: items.length });
      return [];
    } catch {
      if (this.isTaskCancelled(task)) {
        return [];
      }

      this.incrementProgress(task, { failed: items.length });
      return [];
    }
  }

  private async runBatchesWithConcurrency(
    task: RunningTask,
    batches: PageSegment[][],
    worker: (batch: PageSegment[]) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (!this.isTaskCancelled(task)) {
        const index = nextIndex;
        nextIndex += 1;
        const batch = batches[index];

        if (!batch) {
          return;
        }

        await worker(batch);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(task.currentConcurrency, batches.length) }, () => runNext()),
    );
  }

  private async handleBatchError(task: RunningTask, error: unknown): Promise<void> {
    if (error instanceof ProviderError && error.code === "rateLimited") {
      task.currentConcurrency = minConcurrency;
      task.consecutiveSuccessfulBatches = 0;
      await new Promise((resolve) => globalThis.setTimeout(resolve, rateLimitBackoffMs));
    }
  }

  private recordSuccessfulBatch(task: RunningTask): void {
    task.consecutiveSuccessfulBatches += 1;
    if (task.currentConcurrency < defaultConcurrency && task.consecutiveSuccessfulBatches >= 2) {
      task.currentConcurrency = defaultConcurrency;
      task.consecutiveSuccessfulBatches = 0;
    }
  }

  private finishOrWaitForLazySegments(task: RunningTask): void {
    if (this.isTaskCancelled(task)) {
      return;
    }

    if (this.hasUnprocessedSegments(task)) {
      this.updateProgress(task, { state: "waitingForViewport" });
      return;
    }

    this.updateProgress(task, {
      state: task.progress.failed === 0 ? "completed" : "completedWithErrors",
    });
  }

  private hasUnprocessedSegments(task: RunningTask): boolean {
    return [...task.segmentsById.keys()].some(
      (segmentId) =>
        !task.processedSegmentIds.has(segmentId) && !task.inFlightSegmentIds.has(segmentId),
    );
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

  private emptyProgress(
    taskId: string,
    state: TranslationProgress["state"],
  ): TranslationProgress {
    return {
      taskId,
      state,
      total: 0,
      translated: 0,
      failed: 0,
    };
  }

  private cloneProgress(progress: TranslationProgress): TranslationProgress {
    return { ...progress };
  }
}
