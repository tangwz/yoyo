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
  PageTranslationEstimate,
} from "@/messaging/contracts";
import { sendRuntimeMessage } from "@/messaging/runtime";
import type { TranslationMode, TranslationResultItem } from "@/translation/types";

let currentAnchors = new AnchorRegistry();
let activeTaskId: string | undefined;
let lazyReportTaskId: string | undefined;
let lazyReportTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let reportedLazySegmentIds = new Set<string>();

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
  reportedLazySegmentIds = new Set();
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

  const segmentIds = currentAnchors
    .listByTask(taskId)
    .filter((anchor) => {
      if (reportedLazySegmentIds.has(anchor.segmentId) || !anchor.sourceNode.isConnected) {
        return false;
      }

      return priorityForElement(anchor.sourceNode) !== "normal";
    })
    .map((anchor) => anchor.segmentId);

  if (segmentIds.length === 0) {
    return;
  }

  for (const segmentId of segmentIds) {
    reportedLazySegmentIds.add(segmentId);
  }

  await Promise.resolve(sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
    type: "enqueueLazySegments",
    taskId,
    segmentIds,
  })).catch(() => undefined);
}

function startLazySegmentReporting(taskId: string): void {
  lazyReportTaskId = taskId;
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
) {
  if (!isPageUrlSupported(location.href)) {
    throw new Error("Unsupported page URL.");
  }

  stopLazySegmentReporting();
  removeTranslations();

  const { segments, anchors } = await collectPageSegments(taskId);
  currentAnchors = anchors;
  activeTaskId = taskId;
  insertPendingTranslations(currentAnchors, taskId);

  if (translationMode === "lazyViewport") {
    startLazySegmentReporting(taskId);
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
    activeTaskId = undefined;
  } else {
    if (targetTaskId === lazyReportTaskId) {
      stopLazySegmentReporting();
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
