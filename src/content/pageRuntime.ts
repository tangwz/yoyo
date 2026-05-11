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
let reportedLazySegmentIds = new Set<string>();
let failedLazySegmentIds = new Set<string>();
let currentSegmentsById = new Map<string, PageSegment>();
let lazyCollectionComplete = true;

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
  if (lazyReportTimer !== undefined) {
    globalThis.clearTimeout(lazyReportTimer);
    lazyReportTimer = undefined;
  }

  window.removeEventListener("scroll", scheduleLazySegmentReport);
  window.removeEventListener("resize", scheduleLazySegmentReport);
  lazyReportTaskId = undefined;
  lazyRecoverySnapshot = undefined;
  lazyCollectionComplete = true;
  reportedLazySegmentIds = new Set();
  failedLazySegmentIds = new Set();
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
  globalThis.setTimeout(() => {
    void collectDeferredLazySegments(taskId);
  }, 0);
}

async function collectDeferredLazySegments(taskId: string): Promise<void> {
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
): void {
  const existingAnchorsByNode = new Map(
    currentAnchors
      .listByTask(taskId)
      .map((anchor) => [anchor.sourceNode, anchor]),
  );
  const nextSegmentsById = new Map(currentSegmentsById);
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
  }

  currentSegmentsById = nextSegmentsById;
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

  if (translationMode === "lazyViewport") {
    startLazySegmentReporting(taskId, {
      sourceLanguage,
      targetLanguage,
      translationMode,
      providerId,
      textModel,
      segments,
    });
    scheduleDeferredLazyCollection(taskId);
  }

  return segments;
}

export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): ReturnType<typeof applyTranslations> {
  return applyTranslations(currentAnchors, taskId, items);
}

export function handleTaskProgress(progress: TranslationProgress): void {
  if (progress.taskId !== lazyReportTaskId) {
    return;
  }

  if (isTerminalTaskState(progress.state)) {
    stopLazySegmentReporting();
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
