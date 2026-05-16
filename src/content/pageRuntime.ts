import { AnchorRegistry } from "@/content/anchors";
import {
  type SegmentCollection,
  collectPageSegments,
  priorityForElement,
} from "@/content/domExtraction";
import { isPageUrlSupported } from "@/content/domEligibility";
import {
  applyTranslations,
  getTranslationDomState,
  hideTranslations,
  insertPendingTranslations,
  removeTranslations,
  showTranslations,
} from "@/content/injection";
import {
  defaultTranslationQueueOptions,
  TranslationQueue,
} from "@/content/translationQueue";
import type {
  BackgroundRequest,
  BackgroundResponse,
  LazySegmentRecoverySnapshot,
  PageTranslationEstimate,
} from "@/messaging/contracts";
import { sendRuntimeMessage } from "@/messaging/runtime";
import {
  isTerminalTaskState,
  type PageSegment,
  type TranslationMode,
  type TranslationProgress,
  type TranslationResultItem,
} from "@/translation/types";

let currentAnchors = new AnchorRegistry();
let activeTaskId: string | undefined;
let lazyReportTaskId: string | undefined;
let lazyRecoverySnapshot:
  | Omit<LazySegmentRecoverySnapshot, "processedSegmentIds">
  | undefined;
let lazyReportTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let lazyDeferredCollectionTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let lazyForcedRecoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let reportedLazySegmentIds = new Set<string>();
let failedLazySegmentIds = new Set<string>();
let currentSegmentsById = new Map<string, PageSegment>();
let lazyCollectionComplete = true;
const translationQueue = new TranslationQueue(defaultTranslationQueueOptions);
let translationQueueFlushTimer:
  | ReturnType<typeof globalThis.setTimeout>
  | undefined;
let translationQueueContext:
  | {
      taskId: string;
      sourceLanguage: string;
      targetLanguage: string;
      translationMode: TranslationMode;
    }
  | undefined;
let pendingFailedRuntimeBatchSegments = new Map<string, PageSegment>();
let visibilityObserver: IntersectionObserver | undefined;
let observedSegmentIdsByElement = new WeakMap<Element, string>();
let mutationObserver: MutationObserver | undefined;
let mutationRescanTimer:
  | ReturnType<typeof globalThis.setTimeout>
  | undefined;
let dirtyMutationRoots = new Set<Element>();

export async function estimatePage(): Promise<PageTranslationEstimate> {
  if (!isPageUrlSupported(location.href)) {
    return {
      canTranslate: false,
      estimatedSegments: 0,
      estimatedChars: 0,
      reason: "Unsupported page URL.",
    };
  }

  const { segments } = await collectPageSegments("estimate");

  return {
    canTranslate: segments.length > 0,
    estimatedSegments: segments.length,
    estimatedChars: segments.reduce(
      (total, segment) => total + segment.sourceText.length,
      0,
    ),
  };
}

function stopLazySegmentReporting(): void {
  stopMutationObserver();
  stopVisibilityObserver();

  if (lazyReportTimer !== undefined) {
    globalThis.clearTimeout(lazyReportTimer);
    lazyReportTimer = undefined;
  }

  if (lazyDeferredCollectionTimer !== undefined) {
    globalThis.clearTimeout(lazyDeferredCollectionTimer);
    lazyDeferredCollectionTimer = undefined;
  }

  if (lazyForcedRecoveryTimer !== undefined) {
    globalThis.clearTimeout(lazyForcedRecoveryTimer);
    lazyForcedRecoveryTimer = undefined;
  }

  window.removeEventListener("scroll", scheduleLazySegmentReport);
  window.removeEventListener("resize", scheduleLazySegmentReport);
  lazyReportTaskId = undefined;
  lazyRecoverySnapshot = undefined;
  lazyCollectionComplete = true;
  reportedLazySegmentIds = new Set();
  failedLazySegmentIds = new Set();
  resetTranslationQueue();
}

function stopTranslationQueueFlushTimer(): void {
  if (translationQueueFlushTimer !== undefined) {
    globalThis.clearTimeout(translationQueueFlushTimer);
    translationQueueFlushTimer = undefined;
  }
}

function resetTranslationQueue(): void {
  stopTranslationQueueFlushTimer();
  translationQueue.clear();
  translationQueueContext = undefined;
  pendingFailedRuntimeBatchSegments = new Map();
}

function stopVisibilityObserver(): void {
  visibilityObserver?.disconnect();
  visibilityObserver = undefined;
  observedSegmentIdsByElement = new WeakMap();
}

function stopMutationObserver(): void {
  mutationObserver?.disconnect();
  mutationObserver = undefined;

  if (mutationRescanTimer !== undefined) {
    globalThis.clearTimeout(mutationRescanTimer);
    mutationRescanTimer = undefined;
  }

  dirtyMutationRoots = new Set();
}

function observeCurrentSegments(taskId: string): void {
  if (!visibilityObserver) {
    return;
  }

  for (const anchor of currentAnchors.listByTask(taskId)) {
    observedSegmentIdsByElement.set(anchor.sourceNode, anchor.segmentId);
    visibilityObserver.observe(anchor.sourceNode);
  }
}

function startVisibilityObserver(taskId: string): void {
  stopVisibilityObserver();

  if (typeof IntersectionObserver === "undefined") {
    return;
  }

  visibilityObserver = new IntersectionObserver(
    (entries) => {
      const newlyVisible: PageSegment[] = [];

      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        const segmentId = observedSegmentIdsByElement.get(entry.target);
        const segment = segmentId ? currentSegmentsById.get(segmentId) : undefined;
        if (!segment) {
          continue;
        }

        newlyVisible.push({
          ...segment,
          priority: priorityForElement(entry.target as Element),
        });
      }

      if (newlyVisible.length === 0) {
        return;
      }

      translationQueue.enqueue(newlyVisible);
      for (const segment of newlyVisible) {
        reportedLazySegmentIds.add(segment.id);
      }
      scheduleTranslationQueueFlush();
    },
    { threshold: 0.01, rootMargin: "500px 0px 500px 0px" },
  );

  observeCurrentSegments(taskId);
}

function scheduleTranslationQueueFlush(): void {
  if (
    !translationQueueContext ||
    (!translationQueue.hasPending() &&
      pendingFailedRuntimeBatchSegments.size === 0)
  ) {
    return;
  }

  stopTranslationQueueFlushTimer();
  translationQueueFlushTimer = globalThis.setTimeout(() => {
    translationQueueFlushTimer = undefined;
    void flushTranslationQueue();
  }, translationQueue.nextDelayMs());
}

async function flushTranslationQueue(): Promise<void> {
  const context = translationQueueContext;
  if (!context) {
    return;
  }

  const segments = translationQueue.takeNextBatch();
  const queuedSegmentIds = new Set(segments.map((segment) => segment.id));
  const failedSegments = [...pendingFailedRuntimeBatchSegments.values()].filter(
    (segment) => !queuedSegmentIds.has(segment.id),
  );
  const failedSegmentIds = failedSegments.map((segment) => segment.id);
  if (segments.length === 0 && failedSegmentIds.length === 0) {
    return;
  }

  const segmentIds = segments.map((segment) => segment.id);
  const collectionComplete =
    context.translationMode !== "lazyViewport" && !translationQueue.hasPending();
  const request: BackgroundRequest = {
    type: "enqueueTranslationBatch",
    taskId: context.taskId,
    sourceLanguage: context.sourceLanguage,
    targetLanguage: context.targetLanguage,
    translationMode: context.translationMode,
    segments: [...segments, ...failedSegments],
    collectionComplete,
  };
  if (failedSegmentIds.length > 0) {
    request.failedSegmentIds = failedSegmentIds;
  }

  const response = await Promise.resolve(
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request),
  ).catch(() => undefined);

  if (translationQueueContext !== context) {
    return;
  }

  if (!response || response.type !== "taskProgress") {
    translationQueue.markFailed(segmentIds);
    for (const segment of segments) {
      pendingFailedRuntimeBatchSegments.set(segment.id, segment);
    }
    scheduleTranslationQueueFlush();
    return;
  }

  for (const segmentId of failedSegmentIds) {
    pendingFailedRuntimeBatchSegments.delete(segmentId);
  }

  if (isTerminalTaskState(response.progress.state)) {
    if (context.translationMode === "lazyViewport") {
      stopLazySegmentReporting();
      return;
    }

    stopMutationObserver();
    resetTranslationQueue();
    return;
  }

  translationQueue.markTranslated(segmentIds);
  scheduleTranslationQueueFlush();
}

function scheduleMutationRescan(root: Element): void {
  if (!translationQueueContext) {
    return;
  }

  dirtyMutationRoots.add(root);
  if (mutationRescanTimer !== undefined) {
    return;
  }

  mutationRescanTimer = globalThis.setTimeout(() => {
    mutationRescanTimer = undefined;
    void rescanDirtyMutationRoots();
  }, 200);
}

async function rescanDirtyMutationRoots(): Promise<void> {
  const context = translationQueueContext;
  if (!context) {
    dirtyMutationRoots.clear();
    return;
  }

  const roots = [...dirtyMutationRoots];
  dirtyMutationRoots.clear();

  for (const root of roots) {
    if (!root.isConnected) {
      continue;
    }

    const collection = await collectPageSegments(context.taskId, {
      visibleRangeOnly: context.translationMode === "lazyViewport",
      root,
    });
    if (translationQueueContext !== context) {
      return;
    }

    const newSegments = mergeLazySegmentCollection(context.taskId, collection);
    if (newSegments.length === 0) {
      continue;
    }

    const newSegmentIds = new Set(newSegments.map((segment) => segment.id));
    insertPendingTranslations(currentAnchors, context.taskId, newSegmentIds);
    translationQueue.enqueue(newSegments);
    if (context.translationMode === "lazyViewport") {
      for (const segment of newSegments) {
        reportedLazySegmentIds.add(segment.id);
      }
    }
  }

  scheduleTranslationQueueFlush();
}

function startMutationObserver(): void {
  stopMutationObserver();

  if (typeof MutationObserver === "undefined") {
    return;
  }

  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        if (mutation.target.parentElement) {
          scheduleMutationRescan(mutation.target.parentElement);
        }
        continue;
      }

      if (mutation.type !== "childList") {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleMutationRescan(node as Element);
        } else if (
          node.nodeType === Node.TEXT_NODE &&
          mutation.target instanceof Element
        ) {
          scheduleMutationRescan(mutation.target);
        }
      }
    }
  });
  mutationObserver.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function scheduleLazySegmentReport(): void {
  if (!lazyReportTaskId) {
    return;
  }

  if (lazyReportTimer !== undefined) {
    globalThis.clearTimeout(lazyReportTimer);
  }

  lazyReportTimer = globalThis.setTimeout(() => {
    lazyReportTimer = undefined;
    void reportVisibleLazySegments();
  }, 100);
}

function scheduleForcedRecoveryRetry(taskId: string): void {
  if (lazyForcedRecoveryTimer !== undefined) {
    globalThis.clearTimeout(lazyForcedRecoveryTimer);
  }

  lazyForcedRecoveryTimer = globalThis.setTimeout(() => {
    lazyForcedRecoveryTimer = undefined;
    if (lazyReportTaskId === taskId) {
      void reportVisibleLazySegments({ forceRecovery: true });
    }
  }, 100);
}

async function reportVisibleLazySegments(
  options: { forceRecovery?: boolean } = {},
): Promise<void> {
  const taskId = lazyReportTaskId;
  if (!taskId) {
    return;
  }

  const reportableAnchors = currentAnchors
    .listByTask(taskId)
    .filter((anchor) => {
      if (reportedLazySegmentIds.has(anchor.segmentId)) {
        return false;
      }

      return !anchor.sourceNode.isConnected || priorityForElement(anchor.sourceNode) !== "normal";
    });
  const segmentIds = reportableAnchors
    .filter((anchor) => anchor.sourceNode.isConnected)
    .map((anchor) => anchor.segmentId);
  const failedSegmentIds = reportableAnchors
    .filter((anchor) => !anchor.sourceNode.isConnected)
    .map((anchor) => anchor.segmentId);

  const recovery = buildLazyRecoverySnapshot(taskId);
  if (
    segmentIds.length === 0 &&
    failedSegmentIds.length === 0 &&
    !(options.forceRecovery && recovery)
  ) {
    return;
  }

  const request: BackgroundRequest = {
    type: "enqueueLazySegments",
    taskId,
    segmentIds,
  };
  if (failedSegmentIds.length > 0) {
    request.failedSegmentIds = failedSegmentIds;
  }
  if (recovery) {
    request.recovery = recovery;
  }

  const response = await Promise.resolve(
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request),
  ).catch(() => undefined);

  if (lazyReportTaskId !== taskId) {
    return;
  }

  if (!response || response.type !== "taskProgress") {
    if (options.forceRecovery) {
      scheduleForcedRecoveryRetry(taskId);
    }
    return;
  }

  if (isTerminalTaskState(response.progress.state)) {
    stopLazySegmentReporting();
    return;
  }

  for (const segmentId of [...segmentIds, ...failedSegmentIds]) {
    reportedLazySegmentIds.add(segmentId);
  }
  for (const segmentId of failedSegmentIds) {
    failedLazySegmentIds.add(segmentId);
  }
}

function buildLazyRecoverySnapshot(taskId: string): LazySegmentRecoverySnapshot | undefined {
  if (!lazyRecoverySnapshot) {
    return undefined;
  }

  const processedSegmentIds = currentAnchors
    .listByTask(taskId)
    .filter((anchor) => {
      const insertedNode = anchor.insertedNode;
      return Boolean(insertedNode?.isConnected) && insertedNode?.dataset.yoyoPending !== "true";
    })
    .map((anchor) => anchor.segmentId);

  return {
    ...lazyRecoverySnapshot,
    collectionComplete: lazyCollectionComplete,
    segments: [...currentSegmentsById.values()],
    processedSegmentIds,
    failedSegmentIds: [...failedLazySegmentIds],
  };
}

function startLazySegmentReporting(
  taskId: string,
  recoverySnapshot: Omit<LazySegmentRecoverySnapshot, "processedSegmentIds">,
): void {
  lazyReportTaskId = taskId;
  lazyRecoverySnapshot = recoverySnapshot;
  lazyCollectionComplete = false;
  reportedLazySegmentIds = new Set(
    currentAnchors
      .listByTask(taskId)
      .filter((anchor) => priorityForElement(anchor.sourceNode) !== "normal")
      .map((anchor) => anchor.segmentId),
  );
  window.addEventListener("scroll", scheduleLazySegmentReport, { passive: true });
  window.addEventListener("resize", scheduleLazySegmentReport, { passive: true });
}

function scheduleDeferredLazyCollection(taskId: string): void {
  if (lazyDeferredCollectionTimer !== undefined) {
    globalThis.clearTimeout(lazyDeferredCollectionTimer);
  }

  lazyDeferredCollectionTimer = globalThis.setTimeout(() => {
    lazyDeferredCollectionTimer = undefined;
    void collectDeferredLazySegments(taskId);
  }, 0);
}

async function collectDeferredLazySegments(taskId: string): Promise<void> {
  if (activeTaskId !== taskId || lazyReportTaskId !== taskId) {
    return;
  }

  const collection = await collectPageSegments(taskId);
  if (activeTaskId !== taskId || lazyReportTaskId !== taskId) {
    return;
  }

  mergeLazySegmentCollection(taskId, collection);
  lazyCollectionComplete = true;
  await reportVisibleLazySegments({ forceRecovery: true });
}

function mergeLazySegmentCollection(
  taskId: string,
  collection: SegmentCollection,
): PageSegment[] {
  const existingAnchorsByNode = new Map(
    currentAnchors
      .listByTask(taskId)
      .map((anchor) => [anchor.sourceNode, anchor]),
  );
  const nextSegmentsById = new Map(currentSegmentsById);
  const existingSegmentIds = new Set(nextSegmentsById.keys());
  const newSegmentIds: string[] = [];
  const usedSegmentIds = new Set(nextSegmentsById.keys());
  let nextSegmentOrdinal = nextAvailableSegmentOrdinal(usedSegmentIds);

  const allocateSegmentId = (preferredSegmentId: string): string => {
    if (!usedSegmentIds.has(preferredSegmentId)) {
      usedSegmentIds.add(preferredSegmentId);
      return preferredSegmentId;
    }

    let segmentId = `seg_${nextSegmentOrdinal}`;
    nextSegmentOrdinal += 1;
    while (usedSegmentIds.has(segmentId)) {
      segmentId = `seg_${nextSegmentOrdinal}`;
      nextSegmentOrdinal += 1;
    }
    usedSegmentIds.add(segmentId);
    return segmentId;
  };

  for (const segment of collection.segments) {
    const anchor = collection.anchors.get(segment.id);
    if (!anchor) {
      continue;
    }

    const existingAnchor = existingAnchorsByNode.get(anchor.sourceNode);
    if (existingAnchor) {
      nextSegmentsById.set(existingAnchor.segmentId, {
        ...segment,
        id: existingAnchor.segmentId,
      });
      usedSegmentIds.add(existingAnchor.segmentId);
      continue;
    }

    const segmentId = allocateSegmentId(segment.id);
    currentAnchors.set({
      ...anchor,
      segmentId,
    });
    nextSegmentsById.set(segmentId, {
      ...segment,
      id: segmentId,
    });
    if (!existingSegmentIds.has(segmentId)) {
      newSegmentIds.push(segmentId);
    }
  }

  currentSegmentsById = nextSegmentsById;
  observeCurrentSegments(taskId);
  return newSegmentIds
    .map((segmentId) => currentSegmentsById.get(segmentId))
    .filter((segment): segment is PageSegment => Boolean(segment));
}

function nextAvailableSegmentOrdinal(segmentIds: ReadonlySet<string>): number {
  let maxOrdinal = 0;
  for (const segmentId of segmentIds) {
    const match = /^seg_(\d+)$/.exec(segmentId);
    if (!match) {
      continue;
    }
    maxOrdinal = Math.max(maxOrdinal, Number(match[1]));
  }

  return maxOrdinal + 1;
}

export async function collectSegments(
  taskId: string,
  translationMode: TranslationMode = "fullPage",
  sourceLanguage = "auto",
  targetLanguage = "zh-CN",
  providerId?: string,
  textModel?: string,
) {
  if (!isPageUrlSupported(location.href)) {
    throw new Error("Unsupported page URL.");
  }

  stopLazySegmentReporting();
  removeTranslations();

  const { segments, anchors } = await collectPageSegments(
    taskId,
    translationMode === "lazyViewport" ? { visibleRangeOnly: true } : undefined,
  );
  currentSegmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  currentAnchors = anchors;
  activeTaskId = taskId;

  const initialPendingSegmentIds =
    translationMode === "lazyViewport"
      ? new Set(
          segments
            .filter((segment) => segment.priority !== "normal")
            .map((segment) => segment.id),
        )
      : undefined;
  insertPendingTranslations(currentAnchors, taskId, initialPendingSegmentIds);

  translationQueueContext = {
    taskId,
    sourceLanguage,
    targetLanguage,
    translationMode,
  };
  translationQueue.enqueue(
    translationMode === "lazyViewport"
      ? segments.filter((segment) => segment.priority !== "normal")
      : segments,
  );
  scheduleTranslationQueueFlush();

  if (translationMode === "lazyViewport") {
    startVisibilityObserver(taskId);
    startLazySegmentReporting(taskId, {
      sourceLanguage,
      targetLanguage,
      translationMode,
      providerId,
      textModel,
      segments,
    });
    scheduleDeferredLazyCollection(taskId);
  } else {
    stopVisibilityObserver();
  }
  startMutationObserver();

  return segments;
}

export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): ReturnType<typeof applyTranslations> {
  return applyTranslations(currentAnchors, taskId, items);
}

export function handleTaskProgress(progress: TranslationProgress): void {
  if (!isTerminalTaskState(progress.state)) {
    return;
  }

  if (progress.taskId === lazyReportTaskId) {
    stopLazySegmentReporting();
    return;
  }

  if (progress.taskId === translationQueueContext?.taskId) {
    stopMutationObserver();
    resetTranslationQueue();
  }
}

export function hidePageTranslations(taskId?: string): void {
  hideTranslations(taskId ?? activeTaskId);
}

export function showPageTranslations(taskId?: string): void {
  showTranslations(taskId ?? activeTaskId);
}

export function removePageTranslations(taskId?: string): void {
  const targetTaskId = taskId ?? activeTaskId;
  removeTranslations(targetTaskId);

  if (targetTaskId === undefined || targetTaskId === activeTaskId) {
    stopLazySegmentReporting();
    stopMutationObserver();
    currentAnchors.clear();
    currentSegmentsById.clear();
    activeTaskId = undefined;
  } else {
    if (targetTaskId === lazyReportTaskId) {
      stopLazySegmentReporting();
    }
    for (const anchor of currentAnchors.listByTask(targetTaskId)) {
      currentSegmentsById.delete(anchor.segmentId);
    }
    currentAnchors.clearTask(targetTaskId);
  }
}

export function getPageRuntimeState(): {
  hasTranslations: boolean;
  taskId?: string;
  visibility?: "visible" | "hidden";
} {
  const domState = getTranslationDomState(activeTaskId);

  return {
    hasTranslations: domState.hasTranslations,
    taskId: domState.taskId ?? (domState.hasTranslations ? activeTaskId : undefined),
    visibility: domState.visibility,
  };
}
