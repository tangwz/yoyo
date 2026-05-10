import { AnchorRegistry } from "@/content/anchors";
import { isElementSkippable } from "@/content/domEligibility";
import { hashNormalizedText, normalizeSourceText } from "@/translation/hash";
import type { PageSegment, PageSegmentKind, SegmentPriority } from "@/translation/types";

export type SegmentCollection = {
  segments: PageSegment[];
  anchors: AnchorRegistry;
};

const leafReadableTags = new Set(["P", "LI", "BLOCKQUOTE"]);
const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const listTags = new Set(["UL", "OL"]);
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
  if (element.tagName === "LI" && hasNestedList(element)) return false;
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

function hasNestedList(element: Element): boolean {
  return element.querySelector(":scope > ul, :scope > ol") !== null;
}

function collectExtractableText(element: Element): string {
  return collectTextStream(element);
}

function collectNestedListItemOwnText(element: Element): string {
  return collectTextStream(element, listTags);
}

function collectTextStream(
  element: Element,
  excludedTags: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = [];

  for (const child of [...element.childNodes]) {
    if (child.nodeType === textNodeType) {
      parts.push(child.textContent ?? "");
      continue;
    }

    if (child.nodeType !== elementNodeType) continue;

    const childElement = child as Element;
    if (isElementSkippable(childElement)) continue;
    if (excludedTags.has(childElement.tagName)) continue;

    parts.push(collectTextStream(childElement, excludedTags));
  }

  return normalizeSourceText(parts.join(""));
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

export function priorityForElement(element: Element): SegmentPriority {
  const rect = element.getBoundingClientRect();
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);

  if (rect.bottom > 0 && rect.top < viewportHeight) {
    return "viewport";
  }

  if (rect.bottom > -viewportHeight * 2 && rect.top < viewportHeight * 3) {
    return "nearViewport";
  }

  return "normal";
}

export async function collectPageSegments(
  taskId: string,
): Promise<SegmentCollection> {
  const anchors = new AnchorRegistry();
  const segments: PageSegment[] = [];
  let order = 1;

  async function addSegment(
    element: Element,
    sourceText: string,
  ): Promise<void> {
    const segmentId = `seg_${order}`;
    segments.push({
      id: segmentId,
      order,
      sourceText,
      kind: segmentKindFor(element),
      priority: priorityForElement(element),
      pathHint: pathHintFor(element),
      textHash: await hashNormalizedText(sourceText),
    });
    anchors.set({ segmentId, sourceNode: element, taskId });
    order += 1;
  }

  async function walk(element: Element): Promise<void> {
    if (isElementSkippable(element)) return;

    if (element.tagName === "LI" && hasNestedList(element)) {
      const sourceText = collectNestedListItemOwnText(element);
      if (sourceText.length > 0) {
        await addSegment(element, sourceText);
      }

      for (const child of [...element.children].filter((child) =>
        listTags.has(child.tagName),
      )) {
        await walk(child);
      }
      return;
    }

    if (shouldExtractElement(element)) {
      const sourceText = collectExtractableText(element);
      if (sourceText.length === 0) return;

      await addSegment(element, sourceText);
      return;
    }

    for (const child of [...element.children]) {
      await walk(child);
    }
  }

  await walk(chooseRoot());

  return { segments, anchors };
}
