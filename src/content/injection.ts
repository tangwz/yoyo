import type { AnchorRegistry } from "@/content/anchors";
import { applyMirroredStyle } from "@/content/styleMirror";
import type { TranslationResultItem } from "@/translation/types";

export type ApplyTranslationsResult = {
  appliedSegmentIds: string[];
  failedSegmentIds: string[];
};

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
      const wrapper = document.createElement("div");
      wrapper.dataset.yoyoTranslation = "true";
      wrapper.dataset.yoyoSegmentId = item.segmentId;
      wrapper.dataset.yoyoTaskId = taskId;

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

function translationNodes(taskId?: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-yoyo-translation]")]
    .filter((node) => taskId === undefined || node.dataset.yoyoTaskId === taskId);
}
