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

type TextNormalizationCache = WeakMap<Element, string>;

const leafReadableTags = new Set(["P", "LI", "BLOCKQUOTE"]);
const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const listTags = new Set(["UL", "OL"]);
const genericMinimumTextLength = 80;
const textNodeType = 3;
const elementNodeType = 1;

const structuralRootSelector = [
  "article",
  "main",
  '[role="main"]',
  '[role="article"]',
  '[role="feed"]',
  '[role="listitem"]',
  '[data-testid="tweet"]',
  '[data-testid="cellInnerDiv"]',
].join(",");

const textRootSelector = [
  '[data-testid="tweetText"]',
  "[lang]",
  '[dir="auto"]',
  "[data-path]",
  "[data-pathname]",
  "[contenteditable]",
].join(",");

const rootSelector = [
  structuralRootSelector,
  textRootSelector,
].join(",");

const weakRootSelector = [
  "[lang]",
  '[dir="auto"]',
  "[data-path]",
  "[data-pathname]",
  "[contenteditable]",
].join(",");

const genericLowValueSelector = [
  "[role='button']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
].join(",");

const feedLowValueSelector = [
  "nav",
  "footer",
  "time",
  "[role='navigation']",
  "[aria-label*='action' i]",
  "[aria-label*='control' i]",
  "[data-testid='reply']",
  "[data-testid='retweet']",
  "[data-testid='like']",
].join(",");

function discoverRoots(): Element[] {
  const discoveredRoots: Element[] = [];
  let currentRoot: Element | null = null;
  let hasStrongRoot = false;

  for (const root of document.querySelectorAll(rootSelector)) {
    if (root === document.documentElement || root === document.body) continue;
    if (currentRoot?.contains(root)) continue;
    if (isElementSkippable(root)) continue;
    if (isInsideGenericChrome(root)) continue;

    discoveredRoots.push(root);
    hasStrongRoot ||= isStrongRoot(root);
    currentRoot = root;
  }

  if (discoveredRoots.length === 0) return [document.body];
  return hasStrongRoot ? discoveredRoots : [...discoveredRoots, document.body];
}

function isWeakRoot(element: Element): boolean {
  return (
    element.matches(weakRootSelector) &&
    !element.matches('[data-testid="tweetText"]')
  );
}

function isFeedListItemContext(element: Element): boolean {
  const listItem = element.matches('[role="listitem"]')
    ? element
    : element.closest('[role="listitem"]');
  if (!listItem) return false;
  if (listItem.closest('[role="feed"], [data-testid="tweet"], [data-testid="cellInnerDiv"]')) {
    return true;
  }

  return listItem.querySelector(
    [
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[data-testid="cellInnerDiv"]',
    ].join(","),
  ) !== null;
}

function isStrongRoot(element: Element): boolean {
  if (isWeakRoot(element)) return false;
  if (element.matches('[role="listitem"]')) return isFeedListItemContext(element);
  return true;
}

function isInsideGenericChrome(element: Element): boolean {
  const chrome = element.closest(genericLowValueSelector);
  return chrome !== null && chrome !== element;
}

function normalizedElementText(
  element: Element,
  textCache?: TextNormalizationCache,
): string {
  const cachedText = textCache?.get(element);
  if (cachedText !== undefined) return cachedText;

  const text = normalizeSourceText(element.textContent ?? "");
  textCache?.set(element, text);
  return text;
}

function isGenericLowValueElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  if (element.matches(genericLowValueSelector)) return true;

  const text = normalizedElementText(element, textCache);
  if (!text) return true;

  return false;
}

function isFeedHeuristicContext(element: Element): boolean {
  if (isInsideGenericChrome(element)) return false;

  if (
    element.closest(
      [
        '[data-testid="tweet"]',
        '[data-testid="tweetText"]',
        '[data-testid="cellInnerDiv"]',
        '[role="feed"]',
      ].join(","),
    )
  ) {
    return true;
  }

  if (isFeedListItemContext(element)) return true;

  const roleArticle = element.closest('[role="article"]');
  if (!roleArticle) return false;
  if (roleArticle.closest('[role="feed"]') || isFeedListItemContext(roleArticle)) return true;
  return roleArticle.querySelector(
    [
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[data-testid="cellInnerDiv"]',
    ].join(","),
  ) !== null;
}

function isFeedPostContext(element: Element): boolean {
  if (isInsideGenericChrome(element)) return false;

  const post = element.closest(
    [
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[data-testid="cellInnerDiv"]',
    ].join(","),
  );
  if (post || isFeedListItemContext(element)) return true;

  const article = element.closest("article, [role='article']");
  if (!article) return false;
  if (article.closest('[role="feed"]')) return true;
  return article.querySelector(
    '[data-testid="tweetText"], [data-testid="cellInnerDiv"]',
  ) !== null;
}

function isFeedLowValueElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  if (!isFeedHeuristicContext(element)) return false;
  if (element.closest('[data-testid="tweetText"]')) return false;
  if (element.tagName === "HEADER" && isFeedPostContext(element)) return true;
  if (element.matches(feedLowValueSelector)) return true;

  const text = normalizedElementText(element, textCache);
  if (/^@\w{1,30}$/.test(text)) return true;
  if (/^\d+([.,]\d+)?[KMB]?$/.test(text)) return true;
  if (/^\d+[smhdw]$/.test(text)) return true;

  return false;
}

function isLowValueElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  return (
    isGenericLowValueElement(element, textCache) ||
    isFeedLowValueElement(element, textCache)
  );
}

function hasNestedPostTextCandidate(element: Element): boolean {
  return element.querySelector(
    [
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[role="article"]',
      '[role="listitem"]',
    ].join(","),
  ) !== null;
}

function isHighConfidenceShortTextElement(element: Element): boolean {
  if (element === document.documentElement || element === document.body) return false;
  if (isInsideGenericChrome(element)) return false;
  if (element.matches('[data-testid="cellInnerDiv"]')) {
    return !hasNestedPostTextCandidate(element);
  }
  if (element.matches('[role="listitem"]')) return isFeedListItemContext(element);
  if (element.matches('[data-testid="tweetText"]')) return true;
  if (element.closest('[data-testid="tweetText"]')) return true;
  if (element.matches('[role="article"]') && element.closest('[role="feed"]')) {
    return true;
  }
  if (element.closest("article, [role='article'], [data-testid='tweet']")) {
    return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
  }
  return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
}

function hasHighConfidenceReadableChild(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  return [...element.children].some((child) => {
    if (isElementSkippable(child) || isLowValueElement(child, textCache)) {
      return false;
    }
    return (
      isHighConfidenceShortTextElement(child) ||
      hasHighConfidenceReadableChild(child, textCache)
    );
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

function hasReadableChildCandidate(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  for (const child of [...element.children]) {
    if (isElementSkippable(child)) continue;
    if (isLowValueElement(child, textCache)) continue;
    if (isDirectReadableCandidate(child)) return true;
    if (hasReadableChildCandidate(child, textCache)) return true;
  }

  return false;
}

function hasNestedList(element: Element): boolean {
  return element.querySelector(":scope > ul, :scope > ol") !== null;
}

function collectExtractableText(
  element: Element,
  textCache?: TextNormalizationCache,
): string {
  return collectTextStream(
    element,
    new Set(),
    !isDirectReadableCandidate(element),
    textCache,
  );
}

function collectNestedListItemOwnText(
  element: Element,
  textCache?: TextNormalizationCache,
): string {
  return collectTextStream(
    element,
    listTags,
    !isDirectReadableCandidate(element),
    textCache,
  );
}

function collectTextStream(
  element: Element,
  excludedTags: ReadonlySet<string> = new Set(),
  skipFeedLowValue = true,
  textCache?: TextNormalizationCache,
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
    if (isGenericLowValueElement(childElement, textCache)) continue;
    if (skipFeedLowValue && isFeedLowValueElement(childElement, textCache)) continue;
    if (excludedTags.has(childElement.tagName)) continue;

    parts.push(
      collectTextStream(childElement, excludedTags, skipFeedLowValue, textCache),
    );
  }

  return normalizeSourceText(parts.join(""));
}

function shouldExtractElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  if (isElementSkippable(element)) return false;
  if (isLowValueElement(element, textCache)) return false;
  if (isDirectReadableCandidate(element)) return true;
  if (
    !isHighConfidenceShortTextElement(element) &&
    hasHighConfidenceReadableChild(element, textCache)
  ) {
    return false;
  }
  if (hasReadableChildCandidate(element, textCache)) return false;

  const text = collectExtractableText(element, textCache);
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
  const textCache: TextNormalizationCache = new WeakMap();
  let order = 1;

  async function addSegment(
    element: Element,
    sourceText: string,
  ): Promise<void> {
    const normalizedText = normalizeSourceText(sourceText);
    if (!normalizedText) {
      return;
    }

    const priority = priorityForElement(element);
    if (options.visibleRangeOnly && priority === "normal") {
      return;
    }

    const segmentId = `seg_${order}`;
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
    if (isLowValueElement(element, textCache)) return;
    if (options.visibleRangeOnly && element !== document.body && isOutsideVisibleCollectionRange(element)) {
      return;
    }

    if (element === document.body) {
      for (const child of [...element.children]) {
        await walk(child);
      }
      return;
    }

    if (element.tagName === "LI" && hasNestedList(element)) {
      const sourceText = collectNestedListItemOwnText(element, textCache);
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

    if (shouldExtractElement(element, textCache)) {
      const sourceText = collectExtractableText(element, textCache);
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
