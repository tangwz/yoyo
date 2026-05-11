import type { AnchorRegistry } from "@/content/anchors";
import { applyMirroredStyle } from "@/content/styleMirror";
import type { TranslationResultItem } from "@/translation/types";

export type ApplyTranslationsResult = {
  appliedSegmentIds: string[];
  failedSegmentIds: string[];
};

export type TranslationDomState = {
  hasTranslations: boolean;
  taskId?: string;
  visibility?: "visible" | "hidden";
};

export function insertPendingTranslations(
  anchors: AnchorRegistry,
  taskId: string,
  segmentIds?: ReadonlySet<string>,
): ApplyTranslationsResult {
  const appliedSegmentIds: string[] = [];
  const failedSegmentIds: string[] = [];

  for (const anchor of anchors.listByTask(taskId)) {
    if (segmentIds && !segmentIds.has(anchor.segmentId)) {
      continue;
    }

    anchor.insertedNode?.remove();
    if (!anchor.sourceNode.isConnected || !anchor.sourceNode.parentElement) {
      anchor.insertedNode = undefined;
      failedSegmentIds.push(anchor.segmentId);
      continue;
    }

    try {
      const wrapper = createTranslationWrapper(taskId, anchor.segmentId);
      wrapper.dataset.yoyoPending = "true";
      wrapper.setAttribute("aria-label", "Translation pending");

      const inner = document.createElement("div");
      inner.dataset.yoyoTranslationInner = "true";
      inner.dataset.yoyoTranslationPendingInner = "true";
      applyMirroredStyle(inner, anchor.sourceNode);
      applyPendingIndicatorStyle(inner);

      const spinner = document.createElement("span");
      spinner.dataset.yoyoTranslationSpinner = "true";
      spinner.setAttribute("aria-hidden", "true");
      applySpinnerStyle(spinner);

      inner.append(spinner);
      wrapper.append(inner);
      anchor.sourceNode.insertAdjacentElement("afterend", wrapper);
      anchor.insertedNode = wrapper;
      appliedSegmentIds.push(anchor.segmentId);
    } catch {
      anchor.insertedNode = undefined;
      failedSegmentIds.push(anchor.segmentId);
    }
  }

  ensurePendingSpinnerStyle();
  return { appliedSegmentIds, failedSegmentIds };
}

export function applyTranslations(
  anchors: AnchorRegistry,
  taskId: string,
  items: TranslationResultItem[],
): ApplyTranslationsResult {
  const appliedSegmentIds: string[] = [];
  const failedSegmentIds: string[] = [];

  for (const item of items) {
    const anchor = anchors.get(item.segmentId);
    if (!anchor || anchor.taskId !== taskId) {
      failedSegmentIds.push(item.segmentId);
      continue;
    }

    anchor.insertedNode?.remove();
    if (!anchor.sourceNode.isConnected || !anchor.sourceNode.parentElement) {
      anchor.insertedNode = undefined;
      failedSegmentIds.push(item.segmentId);
      continue;
    }

    try {
      const wrapper = createTranslationWrapper(taskId, item.segmentId);

      const inner = document.createElement("div");
      inner.dataset.yoyoTranslationInner = "true";
      inner.textContent = item.translatedText;
      applyMirroredStyle(inner, anchor.sourceNode);

      wrapper.append(inner);
      anchor.sourceNode.insertAdjacentElement("afterend", wrapper);
      anchor.insertedNode = wrapper;
      appliedSegmentIds.push(item.segmentId);
    } catch {
      anchor.insertedNode = undefined;
      failedSegmentIds.push(item.segmentId);
    }
  }

  return { appliedSegmentIds, failedSegmentIds };
}

export function hideTranslations(taskId?: string): void {
  for (const node of translationNodes(taskId)) {
    node.dataset.yoyoHidden = "true";
    node.style.display = "none";
  }
}

export function showTranslations(taskId?: string): void {
  for (const node of translationNodes(taskId)) {
    delete node.dataset.yoyoHidden;
    node.style.removeProperty("display");
  }
}

export function removeTranslations(taskId?: string): void {
  for (const node of translationNodes(taskId)) {
    node.remove();
  }
}

export function getTranslationDomState(taskId?: string): TranslationDomState {
  const nodes = translationNodes(taskId);
  if (nodes.length === 0) {
    return { hasTranslations: false };
  }

  return {
    hasTranslations: true,
    taskId: taskId ?? nodes[0]?.dataset.yoyoTaskId,
    visibility: nodes.every((node) => node.dataset.yoyoHidden === "true")
      ? "hidden"
      : "visible",
  };
}

function translationNodes(taskId?: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-yoyo-translation]")]
    .filter((node) => taskId === undefined || node.dataset.yoyoTaskId === taskId);
}

function createTranslationWrapper(taskId: string, segmentId: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.dataset.yoyoTranslation = "true";
  wrapper.dataset.yoyoSegmentId = segmentId;
  wrapper.dataset.yoyoTaskId = taskId;
  return wrapper;
}

function applyPendingIndicatorStyle(element: HTMLElement): void {
  element.style.display = "inline-flex";
  element.style.alignItems = "center";
  element.style.width = "1.5em";
  element.style.minHeight = "1em";
  element.style.opacity = "0.68";
  element.style.verticalAlign = "baseline";
}

function applySpinnerStyle(element: HTMLElement): void {
  element.style.display = "inline-block";
  element.style.width = "0.72em";
  element.style.height = "0.72em";
  element.style.border = "0.16em solid currentColor";
  element.style.borderRightColor = "transparent";
  element.style.borderRadius = "999px";
  element.style.animation = "yoyo-translation-spinner 0.8s linear infinite";
}

function ensurePendingSpinnerStyle(): void {
  if (document.getElementById("yoyo-translation-spinner-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "yoyo-translation-spinner-style";
  style.textContent = `
@keyframes yoyo-translation-spinner {
  to {
    transform: rotate(360deg);
  }
}`;
  document.documentElement.append(style);
}
