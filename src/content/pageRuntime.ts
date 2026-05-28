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
import type { SummarySourceResult } from "@/summary/types";
import {
  isTerminalTaskState,
  type PageSegment,
  type TranslationMode,
  type TranslationProgress,
  type TranslationResultItem,
} from "@/translation/types";
import { elapsedMs, nowMs, tracePerf } from "@/utils/perfTrace";

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
let pendingRetryRuntimeBatchSegments = new Map<string, PageSegment>();
let pendingFailedRuntimeBatchSegments = new Map<string, PageSegment>();
let visibilityObserver: IntersectionObserver | undefined;
let observedSegmentIdsByElement = new WeakMap<Element, string>();
let mutationObserver: MutationObserver | undefined;
let mutationRescanTimer:
  | ReturnType<typeof globalThis.setTimeout>
  | undefined;
let dirtyMutationRoots = new Set<Element>();
let pendingDisconnectedSegmentIds = new Set<string>();
let collectionGeneration = 0;
const maxSummarySourceChars = 24_000;

function joinSummarySourceText(segments: PageSegment[]): string {
  let sourceText = "";

  for (const segment of segments) {
    const separator =
      sourceText.length > 0 && !segment.preserveWhitespace ? "\n\n" : "";
    const nextText = `${separator}${segment.sourceText}`;
    const remainingChars = maxSummarySourceChars - sourceText.length;
    if (remainingChars <= 0) {
      break;
    }

    sourceText += nextText.slice(0, remainingChars);
  }

  return sourceText.trim();
}

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

export async function collectSummarySource(): Promise<SummarySourceResult> {
  if (!isPageUrlSupported(location.href)) {
    throw new Error("Unsupported page URL.");
  }

  const { segments } = await collectPageSegments("summary");
  const sourceText = joinSummarySourceText(segments);
  if (!sourceText) {
    throw new Error("No readable article content found.");
  }

  const headingTitle = segments.find((segment) => segment.kind === "heading")
    ?.sourceText;
  const documentTitle = document.title.trim();
  const title = headingTitle || documentTitle || undefined;

  return {
    title,
    sourceText,
    sourceCharCount: sourceText.length,
    segmentCount: segments.length,
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
  pendingRetryRuntimeBatchSegments = new Map();
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
  pendingDisconnectedSegmentIds = new Set();
}

function dropRuntimeSegment(
  segmentId: string,
  options: { reportFailed?: boolean } = {},
): void {
  const segment = currentSegmentsById.get(segmentId);
  currentAnchors.get(segmentId)?.insertedNode?.remove();
  currentAnchors.delete(segmentId);
  currentSegmentsById.delete(segmentId);
  translationQueue.remove([segmentId]);
  pendingRetryRuntimeBatchSegments.delete(segmentId);
  if (options.reportFailed && segment) {
    pendingFailedRuntimeBatchSegments.set(segmentId, segment);
  } else {
    pendingFailedRuntimeBatchSegments.delete(segmentId);
  }
  reportedLazySegmentIds.delete(segmentId);
  failedLazySegmentIds.delete(segmentId);
  pendingDisconnectedSegmentIds.delete(segmentId);
}

function findOwningAnchorElement(element: Element): Element {
  let current: Element | null = element;
  while (current) {
    if (
      currentAnchors
        .listByTask(translationQueueContext?.taskId ?? "")
        .some((anchor) => anchor.sourceNode === current)
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return element;
}

function scheduleMutationRescanForElement(element: Element): void {
  scheduleMutationRescan(findOwningAnchorElement(element));
}

function markDisconnectedAnchorsForNode(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
    return;
  }

  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) {
    return;
  }

  const taskId = translationQueueContext?.taskId;
  if (!taskId) {
    return;
  }

  for (const anchor of currentAnchors.listByTask(taskId)) {
    if (!anchor.sourceNode.isConnected || element.contains(anchor.sourceNode)) {
      pendingDisconnectedSegmentIds.add(anchor.segmentId);
    }
  }
}

function dropMissingSegmentsInRoot(
  taskId: string,
  root: Element,
  collection: SegmentCollection,
): void {
  const collectedNodes = new Set(
    collection.anchors.listByTask(taskId).map((anchor) => anchor.sourceNode),
  );

  for (const anchor of currentAnchors.listByTask(taskId)) {
    if (!anchor.sourceNode.isConnected) {
      if (pendingDisconnectedSegmentIds.has(anchor.segmentId)) {
        dropRuntimeSegment(anchor.segmentId, { reportFailed: true });
      }
      continue;
    }
    pendingDisconnectedSegmentIds.delete(anchor.segmentId);
    if (anchor.sourceNode !== root && !root.contains(anchor.sourceNode)) {
      continue;
    }
    if (collectedNodes.has(anchor.sourceNode)) {
      continue;
    }

    dropRuntimeSegment(anchor.segmentId, { reportFailed: true });
  }
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
        const anchor = segmentId ? currentAnchors.get(segmentId) : undefined;
        if (!segment || !anchor) {
          continue;
        }

        const priority = priorityForElement(anchor.sourceNode);
        if (priority === "normal") {
          continue;
        }

        newlyVisible.push({
          ...segment,
          priority,
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
      pendingRetryRuntimeBatchSegments.size === 0 &&
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
  const retrySegments = [...pendingRetryRuntimeBatchSegments.values()].filter(
    (segment) => !queuedSegmentIds.has(segment.id),
  );
  const retrySegmentIds = retrySegments.map((segment) => segment.id);
  const retryOrQueuedSegmentIds = new Set([
    ...queuedSegmentIds,
    ...retrySegmentIds,
  ]);
  const failedSegments = [...pendingFailedRuntimeBatchSegments.values()].filter(
    (segment) => !retryOrQueuedSegmentIds.has(segment.id),
  );
  const failedSegmentIds = failedSegments.map((segment) => segment.id);
  if (
    segments.length === 0 &&
    retrySegmentIds.length === 0 &&
    failedSegmentIds.length === 0
  ) {
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
    segments: [...segments, ...retrySegments, ...failedSegments],
    collectionComplete,
  };
  if (failedSegmentIds.length > 0) {
    request.failedSegmentIds = failedSegmentIds;
  }
  if (context.translationMode === "lazyViewport") {
    const recovery = buildLazyRecoverySnapshot(context.taskId);
    if (recovery) {
      request.recovery = recovery;
    }
  }

  const segmentCount = request.segments.length;
  const startedAt = nowMs();
  tracePerf("content.queue.flush.start", {
    taskId: context.taskId,
    translationMode: context.translationMode,
    segmentCount,
    retryCount: retrySegmentIds.length,
    failedReportCount: failedSegmentIds.length,
  });
  const response = await Promise.resolve(
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request),
  ).catch(() => undefined);
  tracePerf("content.queue.flush.done", {
    taskId: context.taskId,
    translationMode: context.translationMode,
    segmentCount,
    retryCount: retrySegmentIds.length,
    failedReportCount: failedSegmentIds.length,
    durationMs: elapsedMs(startedAt),
    success: response?.type === "taskProgress",
  });

  if (translationQueueContext !== context) {
    return;
  }

  if (!response || response.type !== "taskProgress") {
    translationQueue.markFailed(segmentIds);
    for (const segment of segments) {
      pendingRetryRuntimeBatchSegments.set(segment.id, segment);
    }
    scheduleTranslationQueueFlush();
    return;
  }

  for (const segmentId of retrySegmentIds) {
    pendingRetryRuntimeBatchSegments.delete(segmentId);
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

  const translatedSegmentIds = [
    ...segmentIds,
    ...retrySegmentIds,
    ...failedSegmentIds,
  ];
  translationQueue.retryFailed(
    translatedSegmentIds,
    [...segments, ...retrySegments, ...failedSegments],
  );
  translationQueue.markTranslating(translatedSegmentIds);
  translationQueue.markTranslated(translatedSegmentIds);
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
      root,
      materializePlainTextChunks: true,
    });
    if (translationQueueContext !== context) {
      return;
    }

    dropMissingSegmentsInRoot(context.taskId, root, collection);
    const newSegments = mergeLazySegmentCollection(context.taskId, collection);
    if (newSegments.length === 0) {
      continue;
    }

    const queueableSegments =
      context.translationMode === "lazyViewport"
        ? newSegments.filter((segment) => segment.priority !== "normal")
        : newSegments;
    const newSegmentIds = new Set(queueableSegments.map((segment) => segment.id));
    insertPendingTranslations(currentAnchors, context.taskId, newSegmentIds);
    translationQueue.enqueue(queueableSegments);
    if (context.translationMode === "lazyViewport") {
      for (const segment of queueableSegments) {
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
          scheduleMutationRescanForElement(mutation.target.parentElement);
        }
        continue;
      }

      if (mutation.type !== "childList") {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleMutationRescanForElement(node as Element);
        } else if (
          node.nodeType === Node.TEXT_NODE &&
          mutation.target instanceof Element
        ) {
          scheduleMutationRescanForElement(mutation.target);
        }
      }

      for (const node of mutation.removedNodes) {
        if (mutation.target instanceof Element) {
          scheduleMutationRescanForElement(mutation.target);
        }
        markDisconnectedAnchorsForNode(node);
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
  options: { deferReporting?: boolean } = {},
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
  if (options.deferReporting) {
    return;
  }
  startLazyViewportReporting();
}

function startLazyViewportReporting(): void {
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

  const collection = await collectPageSegments(taskId, {
    materializePlainTextChunks: true,
  });
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
  const existingAnchorsByNode = new Map<Element, ReturnType<AnchorRegistry["listByTask"]>>();
  for (const anchor of currentAnchors.listByTask(taskId)) {
    const anchors = existingAnchorsByNode.get(anchor.sourceNode) ?? [];
    anchors.push(anchor);
    existingAnchorsByNode.set(anchor.sourceNode, anchors);
  }
  const nextSegmentsById = new Map(currentSegmentsById);
  const existingSegmentIds = new Set(nextSegmentsById.keys());
  const newSegmentIds: string[] = [];
  const usedSegmentIds = new Set(nextSegmentsById.keys());
  const matchedExistingSegmentIds = new Set<string>();
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

    const existingAnchors = existingAnchorsByNode.get(anchor.sourceNode) ?? [];
    const existingAnchor = existingAnchors.find((candidate) => {
      if (matchedExistingSegmentIds.has(candidate.segmentId)) {
        return false;
      }
      const existingSegment = nextSegmentsById.get(candidate.segmentId);
      return (
        existingSegment?.textHash === segment.textHash &&
        existingSegment.sourceText === segment.sourceText
      );
    });
    if (existingAnchor) {
      matchedExistingSegmentIds.add(existingAnchor.segmentId);
      nextSegmentsById.set(existingAnchor.segmentId, {
        ...segment,
        id: existingAnchor.segmentId,
      });
      usedSegmentIds.add(existingAnchor.segmentId);
      continue;
    }

    const unmatchedExistingAnchor =
      existingAnchors.length === 1 &&
      !matchedExistingSegmentIds.has(existingAnchors[0].segmentId)
        ? existingAnchors[0]
        : undefined;
    if (unmatchedExistingAnchor) {
      const segmentId = allocateSegmentId(segment.id);
      dropRuntimeSegment(unmatchedExistingAnchor.segmentId);
      matchedExistingSegmentIds.add(unmatchedExistingAnchor.segmentId);
      currentAnchors.set({
        ...anchor,
        segmentId,
      });
      nextSegmentsById.delete(unmatchedExistingAnchor.segmentId);
      nextSegmentsById.set(segmentId, {
        ...segment,
        id: segmentId,
      });
      newSegmentIds.push(segmentId);
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
  deferLazyCollection = false,
) {
  if (!isPageUrlSupported(location.href)) {
    throw new Error("Unsupported page URL.");
  }

  stopLazySegmentReporting();
  removeTranslations();

  const generation = ++collectionGeneration;
  const startedAt = nowMs();
  const { segments, anchors } = await collectPageSegments(
    taskId,
    translationMode === "lazyViewport"
      ? { visibleRangeOnly: true, materializePlainTextChunks: true }
      : { materializePlainTextChunks: true },
  );
  if (generation !== collectionGeneration) {
    throw new Error("Translation collection was superseded.");
  }

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
  if (!(translationMode === "lazyViewport" && deferLazyCollection)) {
    scheduleTranslationQueueFlush();
  }

  if (translationMode === "lazyViewport") {
    startVisibilityObserver(taskId);
    startLazySegmentReporting(taskId, {
      sourceLanguage,
      targetLanguage,
      translationMode,
      providerId,
      textModel,
      segments,
    }, { deferReporting: deferLazyCollection });
    if (!deferLazyCollection) {
      scheduleDeferredLazyCollection(taskId);
    }
  } else {
    stopVisibilityObserver();
  }
  startMutationObserver();

  tracePerf("content.collectSegments.done", {
    taskId,
    translationMode,
    segmentCount: segments.length,
    sourceCharCount: segments.reduce(
      (total, segment) => total + segment.sourceText.length,
      0,
    ),
    durationMs: elapsedMs(startedAt),
    success: true,
  });
  return segments;
}

export function finalizeLazyRecoverySourceLanguage(
  taskId: string,
  sourceLanguage: string,
): boolean {
  if (lazyReportTaskId !== taskId || !lazyRecoverySnapshot) {
    return false;
  }

  lazyRecoverySnapshot = {
    ...lazyRecoverySnapshot,
    sourceLanguage,
  };
  if (translationQueueContext?.taskId === taskId) {
    translationQueueContext = {
      ...translationQueueContext,
      sourceLanguage,
    };
  }
  scheduleTranslationQueueFlush();
  startLazyViewportReporting();
  scheduleDeferredLazyCollection(taskId);
  return true;
}

export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): ReturnType<typeof applyTranslations> {
  const startedAt = nowMs();
  if (translationQueueContext?.taskId !== taskId) {
    const result = {
      appliedSegmentIds: [],
      failedSegmentIds: items.map((item) => item.segmentId),
    };
    tracePerf("content.applyTranslations.done", {
      taskId,
      itemCount: items.length,
      appliedCount: result.appliedSegmentIds.length,
      failedCount: result.failedSegmentIds.length,
      durationMs: elapsedMs(startedAt),
      success: false,
    });
    return result;
  }

  const result = applyTranslations(currentAnchors, taskId, items);
  translationQueue.markTranslating([
    ...result.appliedSegmentIds,
    ...result.failedSegmentIds,
  ]);
  translationQueue.markTranslated(result.appliedSegmentIds);
  translationQueue.markFailed(result.failedSegmentIds);
  tracePerf("content.applyTranslations.done", {
    taskId,
    itemCount: items.length,
    appliedCount: result.appliedSegmentIds.length,
    failedCount: result.failedSegmentIds.length,
    durationMs: elapsedMs(startedAt),
    success: result.failedSegmentIds.length === 0,
  });
  return result;
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
    collectionGeneration += 1;
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
