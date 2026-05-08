import { AnchorRegistry } from "@/content/anchors";
import { isElementSkippable } from "@/content/domEligibility";
import { hashNormalizedText, normalizeSourceText } from "@/translation/hash";
import type { PageSegment, PageSegmentKind } from "@/translation/types";

export type SegmentCollection = {
  segments: PageSegment[];
  anchors: AnchorRegistry;
};

const leafReadableTags = new Set(["P", "LI", "BLOCKQUOTE"]);
const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const genericMinimumTextLength = 80;
const textNodeType = 3;
const elementNodeType = 1;

function chooseRoot(): Element {
  return (
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.querySelector('[role="main"]') ??
    document.body
  );
}

function isDirectReadableCandidate(element: Element): boolean {
  return leafReadableTags.has(element.tagName) || headingTags.has(element.tagName);
}

function segmentKindFor(element: Element): PageSegmentKind {
  if (headingTags.has(element.tagName)) return "heading";
  if (element.tagName === "LI") return "listItem";
  return "paragraph";
}

function hasReadableChildCandidate(element: Element): boolean {
  for (const child of [...element.children]) {
    if (isElementSkippable(child)) continue;
    if (isDirectReadableCandidate(child)) return true;
    if (hasReadableChildCandidate(child)) return true;
  }

  return false;
}

function collectExtractableText(element: Element): string {
  const parts: string[] = [];

  for (const child of [...element.childNodes]) {
    if (child.nodeType === textNodeType) {
      parts.push(child.textContent ?? "");
      continue;
    }

    if (child.nodeType !== elementNodeType) continue;

    const childElement = child as Element;
    if (isElementSkippable(childElement)) continue;

    parts.push(collectExtractableText(childElement));
  }

  return normalizeSourceText(parts.join(" "));
}

function shouldExtractElement(element: Element): boolean {
  if (isElementSkippable(element)) return false;
  if (isDirectReadableCandidate(element)) return true;
  if (hasReadableChildCandidate(element)) return false;

  return collectExtractableText(element).length >= genericMinimumTextLength;
}

function pathHintFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    const index = current.parentElement
      ? [...current.parentElement.children].indexOf(current) + 1
      : 1;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

export async function collectPageSegments(
  taskId: string,
): Promise<SegmentCollection> {
  const anchors = new AnchorRegistry();
  const segments: PageSegment[] = [];
  let order = 1;

  async function walk(element: Element): Promise<void> {
    if (isElementSkippable(element)) return;

    if (shouldExtractElement(element)) {
      const sourceText = collectExtractableText(element);
      if (sourceText.length === 0) return;

      const segmentId = `seg_${order}`;
      segments.push({
        id: segmentId,
        order,
        sourceText,
        kind: segmentKindFor(element),
        pathHint: pathHintFor(element),
        textHash: await hashNormalizedText(sourceText),
      });
      anchors.set({ segmentId, sourceNode: element, taskId });
      order += 1;
      return;
    }

    for (const child of [...element.children]) {
      await walk(child);
    }
  }

  await walk(chooseRoot());

  return { segments, anchors };
}
