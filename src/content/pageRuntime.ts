import { AnchorRegistry } from "@/content/anchors";
import { collectPageSegments, priorityForElement } from "@/content/domExtraction";
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
  type PageSegment,
  type TranslationMode,
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

async function reportVisibleLazySegments(): Promise<void> {
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

  if (segmentIds.length === 0 && failedSegmentIds.length === 0) {
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
  const recovery = buildLazyRecoverySnapshot(taskId);
  if (recovery) {
    request.recovery = recovery;
  }

  const response = await Promise.resolve(
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request),
  ).catch(() => undefined);

  if (
    !response ||
    response.type !== "taskProgress" ||
    response.progress.state === "cancelled" ||
    response.progress.state === "failed"
  ) {
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
  reportedLazySegmentIds = new Set(
    currentAnchors
      .listByTask(taskId)
      .filter((anchor) => priorityForElement(anchor.sourceNode) !== "normal")
      .map((anchor) => anchor.segmentId),
  );
  window.addEventListener("scroll", scheduleLazySegmentReport, { passive: true });
  window.addEventListener("resize", scheduleLazySegmentReport, { passive: true });
}

export async function collectSegments(
  taskId: string,
  translationMode: TranslationMode = "fullPage",
  sourceLanguage = "auto",
  targetLanguage = "zh-CN",
) {
  if (!isPageUrlSupported(location.href)) {
    throw new Error("Unsupported page URL.");
  }

  stopLazySegmentReporting();
  removeTranslations();

  const { segments, anchors } = await collectPageSegments(taskId);
  currentSegmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  currentAnchors = anchors;
  activeTaskId = taskId;
  insertPendingTranslations(currentAnchors, taskId);

  if (translationMode === "lazyViewport") {
    startLazySegmentReporting(taskId, {
      sourceLanguage,
      targetLanguage,
      translationMode,
      segments,
    });
  }

  return segments;
}

export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): ReturnType<typeof applyTranslations> {
  return applyTranslations(currentAnchors, taskId, items);
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
