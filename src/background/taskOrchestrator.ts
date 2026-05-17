import type {
  ContentRequest,
  ContentResponse,
  LazySegmentRecoverySnapshot,
} from "@/messaging/contracts";
import { ProviderError } from "@/provider/errors";
import type { TranslationProvider } from "@/provider/translationProvider";
import {
  isOpenAiCompatibleProviderProfile,
  type ProviderProfile,
} from "@/provider/types";
import { splitSegmentsIntoBatches } from "@/translation/batch";
import { SessionTranslationCache } from "@/translation/cache";
import { createCacheKey, serializeCacheKey } from "@/translation/hash";
import { translationPromptVersion } from "@/translation/prompt";
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
  getProviderProfile: (providerId: string) => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  detectSourceLanguage?: (text: string, signal: AbortSignal) => Promise<string | undefined>;
  sendToContent: (tabId: number, message: ContentRequest) => Promise<ContentResponse>;
  emitProgress?: (progress: TranslationProgress, tabId: number) => void | Promise<void>;
  now: () => number;
  createTaskId: () => string;
};

export type TranslatePageInput = {
  tabId: number;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode?: TranslationMode;
};

export type EnqueueTranslationBatchInput = {
  tabId: number;
  taskId: string;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
  segments: PageSegment[];
  collectionComplete?: boolean;
  failedSegmentIds?: string[];
  recovery?: LazySegmentRecoverySnapshot;
};

type TaskTranslationContext = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
};

type PendingTranslationContext = Omit<TaskTranslationContext, "profile">;

type RunningTask = {
  tabId: number;
  sequence: number;
  controller: AbortController;
  progress: TranslationProgress;
  createdAt: number;
  updatedAt: number;
  segmentsById: Map<string, PageSegment>;
  processedSegmentIds: Set<string>;
  inFlightSegmentIds: Set<string>;
  context?: TaskTranslationContext;
  pendingContext?: PendingTranslationContext;
  pendingContextSource?: "translatePage" | "runtime";
  contextWaiters: Array<() => void>;
  currentConcurrency: number;
  consecutiveSuccessfulBatches: number;
  activeProviderRequests: number;
  providerSlotWaiters: Array<() => void>;
  pendingRuntimeBatchCount: number;
  runtimeBatchWaiters: Array<() => void>;
  collectionComplete: boolean;
};

type TranslationBatchInput = TaskTranslationContext & {
  task: RunningTask;
  segments: PageSegment[];
  fanOutGroups: Map<string, PageSegment[]>;
};

type TranslationBatchResult = {
  missingSegments: PageSegment[];
  error?: unknown;
};

type ApplyTranslationsOptions = {
  countFailures?: boolean;
};

export class TranslationTaskOrchestrator {
  private readonly tasks = new Map<string, RunningTask>();
  private readonly cache = new SessionTranslationCache();
  private nextTaskSequence = 0;

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
    failedSegmentIds: readonly string[] = [],
    recovery?: LazySegmentRecoverySnapshot & { tabId: number },
  ): Promise<TranslationProgress> {
    const task = this.tasks.get(taskId) ?? (await this.recoverLazyTask(taskId, recovery));
    if (task && recovery) {
      this.mergeLazyRecoverySnapshot(task, recovery);
    }

    if (!task || !task.context || this.isTaskStopped(task)) {
      return task ? this.cloneProgress(task.progress) : this.missingTaskProgress(taskId);
    }

    this.markSegmentsFailed(task, failedSegmentIds, segmentIds);

    const segmentIdsToProcess = new Set(segmentIds);
    if (recovery) {
      for (const segment of task.segmentsById.values()) {
        if (
          segment.priority !== "normal" &&
          !task.processedSegmentIds.has(segment.id) &&
          !task.inFlightSegmentIds.has(segment.id)
        ) {
          segmentIdsToProcess.add(segment.id);
        }
      }
    }

    const segments = [...segmentIdsToProcess]
      .map((segmentId) => task.segmentsById.get(segmentId))
      .filter((segment): segment is PageSegment => segment !== undefined);

    await this.processSegmentsForTask(task, segments);
    this.finishOrWaitForLazySegments(task);
    return this.cloneProgress(task.progress);
  }

  async enqueueTranslationBatch(
    input: EnqueueTranslationBatchInput,
  ): Promise<TranslationProgress> {
    const collectionComplete =
      input.collectionComplete ?? input.translationMode !== "lazyViewport";
    const existingTask = this.tasks.get(input.taskId);
    let task = existingTask;
    let shouldRemoveTaskAfterDrain = false;

    if (!task && input.recovery && input.translationMode === "lazyViewport") {
      task = await this.recoverLazyTask(input.taskId, {
        ...input.recovery,
        tabId: input.tabId,
      });
    }

    const isNewRuntimeTask = !task;

    if (task && task.tabId !== input.tabId) {
      return this.missingTaskProgress(input.taskId);
    }
    if (task && this.isTaskStopped(task)) {
      return this.cloneProgress(task.progress);
    }
    if (!task && this.hasTaskForTab(input.tabId)) {
      return this.missingTaskProgress(input.taskId);
    }

    if (!task) {
      task = this.createTask(input.taskId, input.tabId);
      task.collectionComplete = collectionComplete;
      task.pendingContext = {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translationMode: input.translationMode,
      };
      task.pendingContextSource = "runtime";
    }

    this.enterRuntimeBatch(task);

    try {
      if (input.recovery && input.translationMode === "lazyViewport") {
        this.mergeLazyRecoverySnapshot(task, input.recovery);
      }

      const segmentsToProcess = this.mergeTranslationBatchSegments(task, input.segments);
      if (collectionComplete) {
        task.collectionComplete = true;
      }
      this.updateProgress(task, {
        total: task.segmentsById.size,
      });
      this.markSegmentsFailed(task, input.failedSegmentIds ?? []);

      if (!task.context && task.pendingContext && !isNewRuntimeTask) {
        if (task.pendingContextSource === "runtime") {
          await this.waitForContext(task);
          if (this.isTaskStopped(task) || !task.context) {
            return this.cloneProgress(task.progress);
          }

          await this.processSegmentsForTask(
            task,
            this.processableSegmentsForTask(task, segmentsToProcess),
          );
        } else {
          return this.cloneProgress(task.progress);
        }
      }

      if (!task.context) {
        const profile = await this.dependencies.getActiveProfile();

        if (this.isTaskStopped(task)) {
          return this.cloneProgress(task.progress);
        }

        if (!profile) {
          shouldRemoveTaskAfterDrain = !existingTask;
          this.failTask(task, "No active provider profile.");
        } else if (!task.context) {
          const context = task.pendingContext ?? {
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            translationMode: input.translationMode,
          };

          if (!task.pendingContext) {
            task.collectionComplete = collectionComplete;
          }

          task.context = {
            profile,
            ...context,
          };
          task.pendingContext = undefined;
          task.pendingContextSource = undefined;
          this.wakeContextWaiters(task);
        }
      }

      if (this.isTaskStopped(task)) {
        return this.cloneProgress(task.progress);
      }

      await this.processSegmentsForTask(
        task,
        this.processableSegmentsForTask(task, segmentsToProcess),
      );
    } finally {
      this.leaveRuntimeBatch(task);
      if (task.pendingRuntimeBatchCount > 0) {
        await this.waitForRuntimeBatchesToDrain(task);
      }
      if (!this.isTaskStopped(task)) {
        this.finishOrWaitForLazySegments(task);
      }
      if (shouldRemoveTaskAfterDrain && task.pendingRuntimeBatchCount === 0) {
        this.tasks.delete(task.progress.taskId);
      }
    }

    return this.cloneProgress(task.progress);
  }

  private mergeTranslationBatchSegments(
    task: RunningTask,
    segments: readonly PageSegment[],
  ): PageSegment[] {
    const segmentsToProcess: PageSegment[] = [];
    const queuedIds = new Set<string>();

    for (const segment of segments) {
      const existingSegment = task.segmentsById.get(segment.id);
      const candidate = existingSegment ?? segment;
      if (!existingSegment) {
        task.segmentsById.set(segment.id, segment);
      }

      if (!queuedIds.has(candidate.id)) {
        segmentsToProcess.push(candidate);
        queuedIds.add(candidate.id);
      }
    }

    return segmentsToProcess;
  }

  private processableSegmentsForTask(
    task: RunningTask,
    segments: readonly PageSegment[],
  ): PageSegment[] {
    return segments.filter(
      (segment) =>
        !task.processedSegmentIds.has(segment.id) &&
        !task.inFlightSegmentIds.has(segment.id),
    );
  }

  private async recoverLazyTask(
    taskId: string,
    recovery: (LazySegmentRecoverySnapshot & { tabId: number }) | undefined,
  ): Promise<RunningTask | undefined> {
    if (!recovery || recovery.segments.length === 0) {
      return undefined;
    }

    if (this.hasTaskForTab(recovery.tabId)) {
      return undefined;
    }

    const profile = await this.getRecoveryProfile(recovery);
    if (!profile) {
      return undefined;
    }

    const existingTask = this.tasks.get(taskId);
    if (existingTask) {
      return existingTask;
    }

    if (this.hasTaskForTab(recovery.tabId)) {
      return undefined;
    }

    const task = this.createTask(taskId, recovery.tabId);
    task.segmentsById = new Map(recovery.segments.map((segment) => [segment.id, segment]));
    task.collectionComplete = recovery.collectionComplete ?? true;
    task.context = {
      profile,
      sourceLanguage: recovery.sourceLanguage,
      targetLanguage: recovery.targetLanguage,
      translationMode: recovery.translationMode,
    };

    const failedIds = [...new Set(recovery.failedSegmentIds ?? [])].filter((segmentId) =>
      task.segmentsById.has(segmentId),
    );
    const failedIdSet = new Set(failedIds);
    const processedIds = [...new Set(recovery.processedSegmentIds)].filter(
      (segmentId) => task.segmentsById.has(segmentId) && !failedIdSet.has(segmentId),
    );
    for (const segmentId of processedIds) {
      task.processedSegmentIds.add(segmentId);
    }
    for (const segmentId of failedIds) {
      task.processedSegmentIds.add(segmentId);
    }

    this.updateProgress(task, {
      state: "translating",
      total: recovery.segments.length,
      translated: processedIds.length,
      failed: failedIds.length,
    });

    return task;
  }

  private async getRecoveryProfile(
    recovery: LazySegmentRecoverySnapshot,
  ): Promise<ProviderProfile | undefined> {
    if (!recovery.providerId) {
      return this.dependencies.getActiveProfile();
    }

    const profile = await this.dependencies.getProviderProfile(recovery.providerId);
    if (!profile) {
      return undefined;
    }

    return isOpenAiCompatibleProviderProfile(profile)
      ? {
          ...profile,
          textModel: recovery.textModel ?? profile.textModel,
        }
      : profile;
  }

  private mergeLazyRecoverySnapshot(
    task: RunningTask,
    recovery: LazySegmentRecoverySnapshot,
  ): void {
    const previousTotal = task.segmentsById.size;

    for (const segment of recovery.segments) {
      task.segmentsById.set(segment.id, segment);
    }

    const recoveryFailedIdSet = new Set(recovery.failedSegmentIds ?? []);
    let translatedDelta = 0;
    for (const segmentId of recovery.processedSegmentIds) {
      if (
        task.segmentsById.has(segmentId) &&
        !recoveryFailedIdSet.has(segmentId) &&
        !task.inFlightSegmentIds.has(segmentId) &&
        !task.processedSegmentIds.has(segmentId)
      ) {
        task.processedSegmentIds.add(segmentId);
        translatedDelta += 1;
      }
    }

    const failedIds = [...new Set(recovery.failedSegmentIds ?? [])].filter(
      (segmentId) =>
        task.segmentsById.has(segmentId) &&
        !task.processedSegmentIds.has(segmentId),
    );
    for (const segmentId of failedIds) {
      task.processedSegmentIds.add(segmentId);
    }

    if (recovery.collectionComplete === true) {
      task.collectionComplete = true;
    }

    const progress: Partial<TranslationProgress> = {};
    if (task.segmentsById.size !== previousTotal) {
      progress.total = task.segmentsById.size;
    }
    if (translatedDelta > 0) {
      progress.translated = task.progress.translated + translatedDelta;
    }
    if (failedIds.length > 0) {
      progress.failed = task.progress.failed + failedIds.length;
    }
    if (Object.keys(progress).length > 0) {
      this.updateProgress(task, progress);
    }
  }

  private markSegmentsFailed(
    task: RunningTask,
    segmentIds: readonly string[],
    excludedSegmentIds: readonly string[] = [],
  ): void {
    const excludedIds = new Set(excludedSegmentIds);
    const failedIds = [...new Set(segmentIds)].filter(
      (segmentId) =>
        task.segmentsById.has(segmentId) &&
        !excludedIds.has(segmentId) &&
        !task.processedSegmentIds.has(segmentId) &&
        !task.inFlightSegmentIds.has(segmentId),
    );

    if (failedIds.length === 0) {
      return;
    }

    for (const segmentId of failedIds) {
      task.processedSegmentIds.add(segmentId);
    }
    this.incrementProgress(task, { failed: failedIds.length });
  }

  private createTranslatePageTask(input: TranslatePageInput): RunningTask {
    this.cancelTasksForTab(input.tabId, "superseded");

    const taskId = this.dependencies.createTaskId();
    const task = this.createTask(taskId, input.tabId);
    task.collectionComplete = false;
    task.pendingContext = {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      translationMode: input.translationMode ?? "lazyViewport",
    };
    task.pendingContextSource = "translatePage";
    return task;
  }

  private async executeTranslatePage(
    task: RunningTask,
    input: TranslatePageInput,
  ): Promise<TranslationProgress> {
    try {
      const profile = await this.dependencies.getActiveProfile();
      if (this.isTaskStopped(task)) {
        return this.cloneProgress(task.progress);
      }
      if (!profile) {
        return this.failTask(task, "No active provider profile.");
      }

      const context = task.pendingContext ?? {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translationMode: input.translationMode ?? "lazyViewport",
      };
      task.context = task.context ?? {
        profile,
        ...context,
      };
      task.pendingContext = undefined;
      task.pendingContextSource = undefined;
      this.wakeContextWaiters(task);

      const collectResponse = await this.dependencies.sendToContent(input.tabId, {
        type: "collectSegments",
        taskId: task.progress.taskId,
        translationMode: context.translationMode,
        sourceLanguage: context.sourceLanguage,
        deferLazyCollection:
          profile.type === "chrome-built-in-ai" &&
          context.sourceLanguage === "auto" &&
          context.translationMode === "lazyViewport",
        targetLanguage: context.targetLanguage,
        providerId: profile.id,
        textModel: isOpenAiCompatibleProviderProfile(profile) ? profile.textModel : undefined,
      });

      if (this.isTaskStopped(task)) {
        return this.cloneProgress(task.progress);
      }

      if (
        collectResponse.type !== "collectSegmentsResult" ||
        collectResponse.taskId !== task.progress.taskId
      ) {
        return this.failTask(task, "Content script did not return page segments.");
      }

      const collectedSegments = collectResponse.segments;
      this.mergeTranslationBatchSegments(task, collectedSegments);
      const collectionComplete = collectResponse.collectionComplete ?? true;
      const sourceLanguage = await this.resolveSourceLanguageForProfile(
        profile,
        context.sourceLanguage,
        collectedSegments,
        task.controller.signal,
        context.translationMode === "lazyViewport",
      );

      if (this.isTaskStopped(task)) {
        return this.cloneProgress(task.progress);
      }

      if (collectionComplete) {
        task.collectionComplete = true;
      }

      task.context = {
        profile,
        sourceLanguage,
        targetLanguage: context.targetLanguage,
        translationMode: context.translationMode,
      };

      this.updateProgress(task, {
        state: "translating",
        total: task.segmentsById.size,
      });

      if (
        context.translationMode === "lazyViewport" &&
        profile.type === "chrome-built-in-ai" &&
        context.sourceLanguage === "auto"
      ) {
        if (!(await this.finalizeLazyRecoverySourceLanguage(task, sourceLanguage))) {
          return this.failTask(
            task,
            "Content script could not finalize Chrome Built-in AI language detection.",
            task.segmentsById.size,
          );
        }
      }

      await this.processSegmentsForTask(
        task,
        context.translationMode === "lazyViewport"
          ? [...task.segmentsById.values()].filter((segment) => segment.priority !== "normal")
          : [...task.segmentsById.values()],
      );

      if (task.progress.state === "cancelled") {
        return this.cloneProgress(task.progress);
      }

      this.finishOrWaitForLazySegments(task);
      return this.cloneProgress(task.progress);
    } catch (error) {
      if (isTerminalTaskState(task.progress.state)) {
        return this.cloneProgress(task.progress);
      }

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
    this.wakeContextWaiters(task);
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
      .sort((left, right) => {
        const leftTerminal = isTerminalTaskState(left.progress.state);
        const rightTerminal = isTerminalTaskState(right.progress.state);
        if (leftTerminal !== rightTerminal) {
          return leftTerminal ? 1 : -1;
        }

        return right.createdAt - left.createdAt || right.sequence - left.sequence;
      })[0];

    return task ? this.cloneProgress(task.progress) : undefined;
  }

  private createTask(taskId: string, tabId: number): RunningTask {
    const timestamp = this.dependencies.now();
    const task: RunningTask = {
      tabId,
      sequence: ++this.nextTaskSequence,
      controller: new AbortController(),
      createdAt: timestamp,
      updatedAt: timestamp,
      segmentsById: new Map(),
      processedSegmentIds: new Set(),
      inFlightSegmentIds: new Set(),
      currentConcurrency: defaultConcurrency,
      consecutiveSuccessfulBatches: 0,
      activeProviderRequests: 0,
      providerSlotWaiters: [],
      contextWaiters: [],
      pendingRuntimeBatchCount: 0,
      runtimeBatchWaiters: [],
      collectionComplete: true,
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

  private async resolveSourceLanguageForProfile(
    profile: ProviderProfile,
    sourceLanguage: string,
    segments: readonly PageSegment[],
    signal: AbortSignal,
    allowPendingAuto = false,
  ): Promise<string> {
    if (profile.type !== "chrome-built-in-ai" || sourceLanguage !== "auto") {
      return sourceLanguage;
    }

    const sample = this.createLanguageDetectionSample(segments);
    if (!sample && allowPendingAuto) {
      return "auto";
    }
    if (!sample || !this.dependencies.detectSourceLanguage) {
      throw new Error(
        "Chrome Built-in AI could not detect the page language. No remote provider was used.",
      );
    }

    const detectedLanguage = await this.dependencies.detectSourceLanguage(sample, signal);
    if (!detectedLanguage) {
      throw new Error(
        "Chrome Built-in AI could not detect the page language. No remote provider was used.",
      );
    }

    return detectedLanguage;
  }

  private createLanguageDetectionSample(segments: readonly PageSegment[]): string {
    return segments
      .map((segment) => segment.sourceText.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
  }

  private cancelTasksForTab(tabId: number, reason: CancelReason): void {
    for (const task of this.tasks.values()) {
      if (task.tabId === tabId && !isTerminalTaskState(task.progress.state)) {
        this.cancelTask(task.progress.taskId, reason);
      }
    }
  }

  private hasTaskForTab(tabId: number): boolean {
    return [...this.tasks.values()].some(
      (task) => task.tabId === tabId,
    );
  }

  private enterRuntimeBatch(task: RunningTask): void {
    task.pendingRuntimeBatchCount += 1;
  }

  private leaveRuntimeBatch(task: RunningTask): void {
    task.pendingRuntimeBatchCount = Math.max(0, task.pendingRuntimeBatchCount - 1);
    if (task.pendingRuntimeBatchCount === 0) {
      for (const wake of task.runtimeBatchWaiters.splice(0)) {
        wake();
      }
    }
  }

  private async waitForRuntimeBatchesToDrain(task: RunningTask): Promise<void> {
    if (task.pendingRuntimeBatchCount === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      task.runtimeBatchWaiters.push(resolve);
    });
  }

  private async waitForContext(task: RunningTask): Promise<void> {
    if (task.context || this.isTaskStopped(task)) {
      return;
    }

    await new Promise<void>((resolve) => {
      task.contextWaiters.push(resolve);
    });
  }

  private wakeContextWaiters(task: RunningTask): void {
    for (const wake of task.contextWaiters.splice(0)) {
      wake();
    }
  }

  private async processSegmentsForTask(
    task: RunningTask,
    segments: readonly PageSegment[],
  ): Promise<void> {
    if (!task.context || this.isTaskStopped(task)) {
      return;
    }

    const candidates = segments.filter(
      (segment) =>
        !task.processedSegmentIds.has(segment.id) && !task.inFlightSegmentIds.has(segment.id),
    );

    if (candidates.length === 0) {
      return;
    }

    if (!(await this.resolveTaskSourceLanguageForSegments(task, candidates))) {
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
        if (!this.isTaskStopped(task)) {
          task.processedSegmentIds.add(segment.id);
        }
      }
    }
  }

  private async resolveTaskSourceLanguageForSegments(
    task: RunningTask,
    segments: readonly PageSegment[],
  ): Promise<boolean> {
    if (!task.context || task.context.sourceLanguage !== "auto") {
      return true;
    }

    try {
      const sourceLanguage = await this.resolveSourceLanguageForProfile(
        task.context.profile,
        task.context.sourceLanguage,
        segments,
        task.controller.signal,
      );
      const shouldSyncContentSourceLanguage =
        task.context.profile.type === "chrome-built-in-ai" &&
        task.context.translationMode === "lazyViewport" &&
        task.context.sourceLanguage === "auto" &&
        sourceLanguage !== "auto";
      task.context = {
        ...task.context,
        sourceLanguage,
      };
      if (
        shouldSyncContentSourceLanguage &&
        !(await this.finalizeLazyRecoverySourceLanguage(task, sourceLanguage))
      ) {
        this.failTask(
          task,
          "Content script could not finalize Chrome Built-in AI language detection.",
          task.progress.total,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.failTask(
        task,
        error instanceof Error ? error.message : "Translation task failed.",
        task.progress.total,
      );
      return false;
    }
  }

  private async finalizeLazyRecoverySourceLanguage(
    task: RunningTask,
    sourceLanguage: string,
  ): Promise<boolean> {
    const response = await this.dependencies.sendToContent(task.tabId, {
      type: "finalizeLazyRecoverySourceLanguage",
      taskId: task.progress.taskId,
      sourceLanguage,
    });

    return response.type === "contentActionResult" && response.success;
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
      if (this.isTaskStopped(input.task)) {
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
      const result = await this.requestAndApplyBatch(input);

      if (this.isTaskStopped(input.task)) {
        return;
      }

      if (result.error) {
        await this.handleBatchError(input.task, result.error);
      } else {
        this.recordSuccessfulBatch(input.task);
      }

      if (result.missingSegments.length === 0) {
        return;
      }

      await this.retryOrDegradeBatch({ ...input, segments: result.missingSegments }, attempt);
    } catch (error) {
      if (this.isTaskStopped(input.task)) {
        return;
      }

      await this.handleBatchError(input.task, error);
      await this.retryOrDegradeBatch(input, attempt);
    }
  }

  private async requestAndApplyBatch(
    input: TranslationBatchInput,
  ): Promise<TranslationBatchResult> {
    const streamingResult = await this.requestAndApplyStreamingBatch(input);
    if (streamingResult) {
      return streamingResult;
    }

    return this.requestAndApplyBufferedBatch(input);
  }

  private async requestAndApplyStreamingBatch(
    input: TranslationBatchInput,
  ): Promise<TranslationBatchResult | undefined> {
    const provider = this.dependencies.getTranslationProvider(input.profile);
    if (!provider.streamBatch) {
      return undefined;
    }

    const appliedRepresentativeIds = new Set<string>();
    let sawValidItem = false;
    let acquiredProviderSlot = false;

    try {
      if (!(await this.acquireProviderRequestSlot(input.task))) {
        return { missingSegments: [] };
      }
      acquiredProviderSlot = true;

      for await (const response of provider.streamBatch({
        profile: input.profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        segments: input.segments,
        abortSignal: input.task.controller.signal,
      })) {
        if (this.isTaskStopped(input.task)) {
          return { missingSegments: [] };
        }

        for (const item of this.filterBatchItems(response.items, input.segments)) {
          if (this.isTaskStopped(input.task)) {
            return { missingSegments: [] };
          }

          sawValidItem = true;
          if (await this.applyAndCacheRepresentativeItem(input, item)) {
            appliedRepresentativeIds.add(item.segmentId);
          }
        }
      }

      if (this.isTaskStopped(input.task)) {
        return { missingSegments: [] };
      }

      if (!sawValidItem) {
        return undefined;
      }

      return {
        missingSegments: input.segments.filter(
          (segment) => !appliedRepresentativeIds.has(segment.id),
        ),
      };
    } catch (error) {
      if (this.isTaskStopped(input.task)) {
        return { missingSegments: [] };
      }

      if (!sawValidItem) {
        await this.handleBatchError(input.task, error);
        return undefined;
      }

      return {
        missingSegments: input.segments.filter(
          (segment) => !appliedRepresentativeIds.has(segment.id),
        ),
        error,
      };
    } finally {
      if (acquiredProviderSlot) {
        this.releaseProviderRequestSlot(input.task);
      }
    }
  }

  private async requestAndApplyBufferedBatch(
    input: TranslationBatchInput,
  ): Promise<TranslationBatchResult> {
    if (!(await this.acquireProviderRequestSlot(input.task))) {
      return { missingSegments: [] };
    }

    let response: Awaited<ReturnType<TranslationProvider["translateBatch"]>>;
    try {
      const provider = this.dependencies.getTranslationProvider(input.profile);
      response = await provider.translateBatch({
        profile: input.profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        segments: input.segments,
        abortSignal: input.task.controller.signal,
      });
    } finally {
      this.releaseProviderRequestSlot(input.task);
    }

    if (this.isTaskStopped(input.task)) {
      return { missingSegments: [] };
    }

    const validItems = this.filterBatchItems(response.items, input.segments);

    if (validItems.length > 0) {
      const fanOutItems = validItems.flatMap((item) =>
        this.fanOutTranslationItem(item, input.fanOutGroups),
      );
      const appliedItems = await this.applyTranslations(input.task, fanOutItems);

      if (this.isTaskStopped(input.task)) {
        return { missingSegments: [] };
      }

      if (appliedItems.length > 0) {
        await this.cacheAppliedGroups(input, validItems, appliedItems);
      }
    }

    const translatedIds = new Set(validItems.map((item) => item.segmentId));
    return {
      missingSegments: input.segments.filter((segment) => !translatedIds.has(segment.id)),
    };
  }

  private filterBatchItems(
    items: TranslationResultItem[],
    segments: PageSegment[],
  ): TranslationResultItem[] {
    const expectedSegmentIds = new Set(segments.map((segment) => segment.id));
    return items.filter((item) => expectedSegmentIds.has(item.segmentId));
  }

  private async applyAndCacheRepresentativeItem(
    input: TranslationBatchInput,
    item: TranslationResultItem,
  ): Promise<boolean> {
    const group = input.fanOutGroups.get(item.segmentId) ?? [];
    const fanOutItems = this.fanOutTranslationItem(item, input.fanOutGroups);
    const appliedItems = await this.applyTranslations(input.task, fanOutItems, {
      countFailures: false,
    });
    if (appliedItems.length === 0 || this.isTaskStopped(input.task)) {
      return false;
    }

    const appliedIds = new Set(appliedItems.map((appliedItem) => appliedItem.segmentId));
    const pendingGroup = group.filter((segment) => !appliedIds.has(segment.id));
    if (pendingGroup.length > 0) {
      input.fanOutGroups.set(item.segmentId, pendingGroup);
      return false;
    }

    await this.cacheAppliedGroups(input, [item], appliedItems);
    return group.length > 0;
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
    if (this.isTaskStopped(input.task) || input.segments.length === 0) {
      return;
    }

    if (attempt + 1 < maxBatchAttempts) {
      await this.translateBatchWithFallback(input, attempt + 1);
      return;
    }

    if (input.segments.length === 1) {
      if (this.isTaskStopped(input.task)) {
        return;
      }

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
    options: ApplyTranslationsOptions = {},
  ): Promise<TranslationResultItem[]> {
    if (items.length === 0 || this.isTaskStopped(task)) {
      return [];
    }

    try {
      const response = await this.dependencies.sendToContent(task.tabId, {
        type: "applyTranslations",
        taskId: task.progress.taskId,
        items,
      });

      if (this.isTaskStopped(task)) {
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
          failed:
            options.countFailures === false
              ? 0
              : explicitFailures.length + implicitFailures.length,
        });
        return appliedItems;
      }

      if (options.countFailures !== false) {
        this.incrementProgress(task, { failed: items.length });
      }
      return [];
    } catch {
      if (this.isTaskStopped(task)) {
        return [];
      }

      if (options.countFailures !== false) {
        this.incrementProgress(task, { failed: items.length });
      }
      return [];
    }
  }

  private async runBatchesWithConcurrency(
    task: RunningTask,
    batches: PageSegment[][],
    worker: (batch: PageSegment[]) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    let activeCount = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        resolve();
      };
      const fail = (error: unknown) => {
        settled = true;
        reject(error);
      };

      const schedule = () => {
        if (settled) {
          return;
        }

        if (this.isTaskStopped(task)) {
          if (activeCount === 0) {
            finish();
          }
          return;
        }

        while (activeCount < task.currentConcurrency && nextIndex < batches.length) {
          const batch = batches[nextIndex];
          nextIndex += 1;
          activeCount += 1;

          Promise.resolve(worker(batch))
            .catch(fail)
            .finally(() => {
              activeCount -= 1;
              schedule();
            });
        }

        if (activeCount === 0 && nextIndex >= batches.length) {
          finish();
        }
      };

      schedule();
    });
  }

  private async handleBatchError(task: RunningTask, error: unknown): Promise<void> {
    if (this.isTaskStopped(task)) {
      return;
    }

    if (error instanceof ProviderError && error.code === "rateLimited") {
      task.currentConcurrency = minConcurrency;
      task.consecutiveSuccessfulBatches = 0;
      this.wakeProviderRequestWaiters(task);
      await new Promise((resolve) => globalThis.setTimeout(resolve, rateLimitBackoffMs));

      if (this.isTaskStopped(task)) {
        return;
      }
    }
  }

  private async acquireProviderRequestSlot(task: RunningTask): Promise<boolean> {
    while (!this.isTaskStopped(task) && task.activeProviderRequests >= task.currentConcurrency) {
      await new Promise<void>((resolve) => {
        task.providerSlotWaiters.push(resolve);
      });
    }

    if (this.isTaskStopped(task)) {
      return false;
    }

    task.activeProviderRequests += 1;
    return true;
  }

  private releaseProviderRequestSlot(task: RunningTask): void {
    task.activeProviderRequests = Math.max(0, task.activeProviderRequests - 1);
    this.wakeProviderRequestWaiters(task);
  }

  private wakeProviderRequestWaiters(task: RunningTask): void {
    for (const wake of task.providerSlotWaiters.splice(0)) {
      wake();
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
    if (this.isTaskStopped(task)) {
      return;
    }

    if (!task.context) {
      return;
    }

    if (task.inFlightSegmentIds.size > 0) {
      this.updateProgress(task, { state: "translating" });
      return;
    }

    if (task.pendingRuntimeBatchCount > 0) {
      this.updateProgress(task, { state: "translating" });
      return;
    }

    if (!task.collectionComplete) {
      this.updateProgress(task, { state: "waitingForViewport" });
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
      (segmentId) => !task.processedSegmentIds.has(segmentId),
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
    const providerIdentity = this.providerCacheIdentity(input.profile);

    return createCacheKey({
      sourceText: segment.sourceText,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      providerId: providerIdentity.providerId,
      textModel: providerIdentity.textModel,
      translationStyle,
      promptVersion: translationPromptVersion,
    });
  }

  private providerCacheIdentity(profile: ProviderProfile): Pick<TranslationCacheKey, "providerId" | "textModel"> {
    if (isOpenAiCompatibleProviderProfile(profile)) {
      return {
        providerId: profile.id,
        textModel: profile.textModel,
      };
    }

    return {
      providerId: profile.id,
      textModel: profile.type,
    };
  }

  private failTask(
    task: RunningTask,
    errorMessage: string,
    failed = task.progress.total,
  ): TranslationProgress {
    const remaining = Math.max(0, task.progress.total - task.progress.translated);

    this.updateProgress(task, {
      state: "failed",
      failed: Math.min(failed, remaining),
      errorMessage,
    });
    this.wakeContextWaiters(task);
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
    void this.dependencies.emitProgress?.(this.cloneProgress(task.progress), task.tabId);
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

  private isTaskStopped(task: RunningTask): boolean {
    return this.isTaskCancelled(task) || isTerminalTaskState(task.progress.state);
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

  private missingTaskProgress(taskId: string): TranslationProgress {
    return {
      ...this.emptyProgress(taskId, "cancelled"),
      errorMessage: "Translation task is no longer available. Start translation again.",
    };
  }

  private cloneProgress(progress: TranslationProgress): TranslationProgress {
    return { ...progress };
  }
}
