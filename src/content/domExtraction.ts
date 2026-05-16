import { AnchorRegistry } from "@/content/anchors";
import { isElementSkippable } from "@/content/domEligibility";
import { hashNormalizedText, normalizeSourceText } from "@/translation/hash";
import type { PageSegment, PageSegmentKind, SegmentPriority } from "@/translation/types";

export type SegmentCollection = {
  segments: PageSegment[];
  anchors: AnchorRegistry;
};

export type SegmentCollectionOptions = {
  visibleRangeOnly?: boolean;
};

const leafReadableTags = new Set(["P", "LI", "BLOCKQUOTE"]);
const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const listTags = new Set(["UL", "OL"]);
const genericMinimumTextLength = 80;
const textNodeType = 3;
const elementNodeType = 1;

const rootSelector = [
  "article",
  "main",
  '[role="main"]',
  '[role="article"]',
  '[data-testid="tweet"]',
  '[data-testid="tweetText"]',
  "[lang]",
  '[dir="auto"]',
].join(",");

const lowValueSelector = [
  "nav",
  "header",
  "footer",
  "[role='navigation']",
  "[role='button']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
  "[aria-label*='action' i]",
  "[aria-label*='control' i]",
  "[data-testid='reply']",
  "[data-testid='retweet']",
  "[data-testid='like']",
].join(",");

function discoverRoots(): Element[] {
  const roots = [...document.querySelectorAll(rootSelector)];
  roots.push(document.body);

  return roots.filter((root, index, allRoots) => {
    if (isElementSkippable(root)) return false;
    return !allRoots.some(
      (other, otherIndex) =>
        otherIndex !== index && other !== root && other.contains(root),
    );
  });
}

function isLowValueFeedElement(element: Element): boolean {
  if (element.matches(lowValueSelector)) return true;

  const text = normalizeSourceText(element.textContent ?? "");
  if (!text) return true;
  if (/^@\w{1,30}$/.test(text)) return true;
  if (/^\d+([.,]\d+)?[KMB]?$/.test(text)) return true;
  if (/^\d+[smhdw]$/.test(text)) return true;

  return false;
}

function isHighConfidenceShortTextElement(element: Element): boolean {
  if (element.matches('[data-testid="tweetText"]')) return true;
  if (element.closest('[data-testid="tweetText"]')) return true;
  if (element.closest("article, [role='article'], [data-testid='tweet']")) {
    return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
  }
  return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
}

function hasHighConfidenceReadableChild(element: Element): boolean {
  return [...element.children].some((child) => {
    if (isElementSkippable(child) || isLowValueFeedElement(child)) {
      return false;
    }
    return isHighConfidenceShortTextElement(child) || hasHighConfidenceReadableChild(child);
  });
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
  if (isLowValueFeedElement(element)) return false;
  if (isDirectReadableCandidate(element)) return true;
  if (!isHighConfidenceShortTextElement(element) && hasHighConfidenceReadableChild(element)) {
    return false;
  }
  if (hasReadableChildCandidate(element)) return false;

  const text = collectExtractableText(element);
  if (text.length === 0) return false;
  if (isHighConfidenceShortTextElement(element)) return true;

  return text.length >= genericMinimumTextLength;
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

function isOutsideVisibleCollectionRange(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);

  return rect.bottom <= -viewportHeight * 2 || rect.top >= viewportHeight * 3;
}

export async function collectPageSegments(
  taskId: string,
  options: SegmentCollectionOptions = {},
): Promise<SegmentCollection> {
  const anchors = new AnchorRegistry();
  const segments: PageSegment[] = [];
  const seenNodes = new WeakSet<Element>();
  const seenTextHashes = new Set<string>();
  let order = 1;

  async function addSegment(
    element: Element,
    sourceText: string,
  ): Promise<void> {
    const normalizedText = normalizeSourceText(sourceText);
    if (!normalizedText || seenTextHashes.has(normalizedText)) {
      return;
    }

    const priority = priorityForElement(element);
    if (options.visibleRangeOnly && priority === "normal") {
      return;
    }

    const segmentId = `seg_${order}`;
    seenTextHashes.add(normalizedText);
    segments.push({
      id: segmentId,
      order,
      sourceText: normalizedText,
      kind: segmentKindFor(element),
      priority,
      pathHint: pathHintFor(element),
      textHash: await hashNormalizedText(normalizedText),
    });
    anchors.set({ segmentId, sourceNode: element, taskId });
    order += 1;
  }

  async function walk(element: Element): Promise<void> {
    if (seenNodes.has(element)) return;
    seenNodes.add(element);
    if (isElementSkippable(element)) return;
    if (isLowValueFeedElement(element)) return;
    if (options.visibleRangeOnly && element !== document.body && isOutsideVisibleCollectionRange(element)) {
      return;
    }

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

  for (const root of discoverRoots()) {
    await walk(root);
  }

  return { segments, anchors };
}
