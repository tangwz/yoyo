import { AnchorRegistry } from "@/content/anchors";
import { collectPageSegments } from "@/content/domExtraction";
import { isPageUrlSupported } from "@/content/domEligibility";
import {
  applyTranslations,
  hideTranslations,
  removeTranslations,
  showTranslations,
} from "@/content/injection";
import type { PageTranslationEstimate } from "@/messaging/contracts";
import type { TranslationResultItem } from "@/translation/types";

let currentAnchors = new AnchorRegistry();
let activeTaskId: string | undefined;

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

export async function collectSegments(taskId: string) {
  removeTranslations();

  const { segments, anchors } = await collectPageSegments(taskId);
  currentAnchors = anchors;
  activeTaskId = taskId;

  return segments;
}

export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): void {
  applyTranslations(currentAnchors, taskId, items);
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
    currentAnchors.clear();
    activeTaskId = undefined;
  } else {
    currentAnchors.clearTask(targetTaskId);
  }
}

export function getPageRuntimeState(): {
  hasTranslations: boolean;
  taskId?: string;
} {
  return {
    hasTranslations: document.querySelector("[data-yoyo-translation]") !== null,
    taskId: activeTaskId,
  };
}
