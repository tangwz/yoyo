import { AnchorRegistry } from "@/content/anchors";
import {
  hasNonTagSkipReason,
  isElementSkippable,
} from "@/content/domEligibility";
import {
  hashNormalizedText,
  hashSourceText,
  normalizeSourceText,
} from "@/translation/hash";
import type { PageSegment, PageSegmentKind, SegmentPriority } from "@/translation/types";

export type SegmentCollection = {
  segments: PageSegment[];
  anchors: AnchorRegistry;
};

export type SegmentCollectionOptions = {
  visibleRangeOnly?: boolean;
  root?: Element;
  materializePlainTextChunks?: boolean;
};

type TextNormalizationCache = WeakMap<Element, string>;
type DiscoveredRootCandidate = {
  element: Element;
  isWeak: boolean;
};

const leafReadableTags = new Set(["P", "LI", "BLOCKQUOTE"]);
const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const listTags = new Set(["UL", "OL"]);
const genericMinimumTextLength = 80;
const plainTextSegmentMaxLength = 1_800;
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

const pageChromeSelector = [
  "nav",
  "aside",
  "header",
  "footer",
  "[role='navigation']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
].join(",");

const extractablePageChromeSelector = [
  "nav",
  "aside",
  "[role='navigation']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
].join(",");

const feedPageChromeSelector = [
  '[aria-label*="trend" i]',
  '[aria-label*="trending" i]',
  '[aria-label*="趋势"]',
].join(",");

const feedLowValueSelector = [
  "nav",
  "footer",
  "time",
  "[role='navigation']",
  "[aria-label*='action' i]",
  "[aria-label*='control' i]",
  "[aria-label*='meta' i]",
  "[data-testid='reply']",
  "[data-testid='retweet']",
  "[data-testid='like']",
].join(",");

const legacyStoryTableTitleSelector = ".titleline > a[href]";
const cardHeadlineSelector = ".tile__headline";
const legacyStoryTableContainerTags = new Set(["TABLE", "TBODY", "TR", "TD"]);

function isPlainTextDocument(): boolean {
  return document.contentType.toLowerCase().split(";")[0]?.trim() === "text/plain";
}

function isBrowserGeneratedPlainTextPre(element: Element): boolean {
  if (!isPlainTextDocument()) return false;
  if (element.tagName !== "PRE") return false;
  if (element.parentElement !== document.body) return false;

  const style = (element as HTMLElement).style;
  return style.whiteSpace === "pre-wrap" && style.wordWrap === "break-word";
}

function findBrowserGeneratedPlainTextPre(): Element | undefined {
  if (!isPlainTextDocument()) return undefined;
  return [...document.body.children].find(
    (child) =>
      isBrowserGeneratedPlainTextPre(child) && !hasNonTagSkipReason(child),
  );
}

function isLegacyStoryTableContainer(element: Element): boolean {
  return (
    legacyStoryTableContainerTags.has(element.tagName) &&
    element.querySelector(legacyStoryTableTitleSelector) !== null
  );
}

function isCardButtonContainer(element: Element): boolean {
  return element.tagName === "BUTTON" && element.querySelector(cardHeadlineSelector) !== null;
}

function isCardHeadlineContainer(element: Element): boolean {
  return (
    element.matches(cardHeadlineSelector) ||
    (element.hasAttribute("aria-hidden") &&
      element.querySelector(cardHeadlineSelector) !== null)
  );
}

function hasExtractionBlocker(
  element: Element,
  options: { allowAriaHidden?: boolean } = {},
): boolean {
  if (!options.allowAriaHidden) return hasNonTagSkipReason(element);

  if (element.hasAttribute("data-yoyo-translation")) return true;
  if (element.hasAttribute("data-yoyo-extension")) return true;
  if (element.hasAttribute("hidden")) return true;
  if (element.hasAttribute("contenteditable")) return true;
  if ((element as HTMLElement).isContentEditable) return true;

  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function isElementSkippedForExtraction(element: Element): boolean {
  if (isBrowserGeneratedPlainTextPre(element)) {
    return hasNonTagSkipReason(element);
  }

  if (isLegacyStoryTableContainer(element) && !hasExtractionBlocker(element)) {
    return false;
  }

  if (
    (isCardButtonContainer(element) || isCardHeadlineContainer(element)) &&
    !hasExtractionBlocker(element, { allowAriaHidden: true })
  ) {
    return false;
  }

  return isElementSkippable(element);
}

function discoverRoots(): Element[] {
  const plainTextPre = findBrowserGeneratedPlainTextPre();
  if (plainTextPre) return [plainTextPre];

  const discoveredRoots: DiscoveredRootCandidate[] = [];

  for (const candidateRoot of document.querySelectorAll(rootSelector)) {
    const candidate = rootForCandidate(candidateRoot);
    if (!candidate) continue;
    const root = candidate.element;
    if (root === document.documentElement || root === document.body) continue;
    if (isElementSkippedForExtraction(root)) continue;
    if (isInsideGenericChrome(root)) continue;

    const existingIndex = discoveredRoots.findIndex((existing) =>
      existing.element === root || existing.element.contains(root),
    );
    if (existingIndex >= 0) {
      const existing = discoveredRoots[existingIndex];
      if (
        existing.element === root ||
        !shouldPreferNestedRoot(root, existing.element)
      ) {
        continue;
      }
      discoveredRoots.splice(existingIndex, 1);
    }

    if (discoveredRoots.some((existing) => root.contains(existing.element))) {
      continue;
    }

    discoveredRoots.push(candidate);
  }

  if (discoveredRoots.length === 0) return [document.body];
  const hasStrongRoot = discoveredRoots.some(
    (candidate) => !candidate.isWeak && isStrongRoot(candidate.element),
  );
  if (!hasStrongRoot) {
    return [document.body, ...discoveredRoots.map((candidate) => candidate.element)];
  }

  return discoveredRoots
    .filter((candidate) => !isWeakPageChromeRoot(candidate))
    .map((candidate) => candidate.element);
}

function shouldPreferNestedRoot(root: Element, existingRoot: Element): boolean {
  if (!existingRoot.matches("main, [role='main']")) return false;
  if (root.matches("[lang], [dir='auto'], [data-path], [data-pathname]")) {
    return false;
  }
  if (root.matches('[role="listitem"]')) return isFeedListItemContext(root);

  return root.matches(
    [
      "article",
      '[role="article"]',
      '[role="feed"]',
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[data-testid="cellInnerDiv"]',
    ].join(","),
  );
}

function isWeakRoot(element: Element): boolean {
  return (
    element.matches(weakRootSelector) &&
    !element.matches('[data-testid="tweetText"]')
  );
}

function rootForCandidate(element: Element): DiscoveredRootCandidate | null {
  if (element.hasAttribute("contenteditable")) {
    const parent = element.parentElement;
    return parent ? { element: parent, isWeak: true } : null;
  }

  return { element, isWeak: isWeakRoot(element) || isEditableOnlyRoot(element) };
}

function isEditableOnlyRoot(element: Element): boolean {
  if (element.querySelector("[contenteditable]") === null) return false;
  return !hasMeaningfulNonEditableContent(element);
}

function hasMeaningfulNonEditableContent(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType === textNodeType) {
      if (normalizeSourceText(child.textContent ?? "")) return true;
      continue;
    }

    if (child.nodeType !== elementNodeType) continue;

    const childElement = child as Element;
    if (isElementSkippedForExtraction(childElement)) continue;
    if (hasMeaningfulNonEditableContent(childElement)) return true;
  }

  return false;
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

function isWeakPageChromeRoot(candidate: DiscoveredRootCandidate): boolean {
  if (!candidate.isWeak) return false;
  if (isFeedHeuristicContext(candidate.element)) return false;

  const chrome = candidate.element.closest(pageChromeSelector);
  return chrome !== null;
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
  if (element.tagName === "HEADER" && isFeedPostContext(element)) return true;
  if (element.matches(feedLowValueSelector)) return true;
  if (isDirectReadableChromeInPostWithExplicitBody(element, textCache)) return true;
  if (isNonBodyTextHintInPostWithExplicitBody(element)) return true;
  if (isInsideBodySafeTextContainer(element)) return false;

  const text = normalizedElementText(element, textCache);
  if (/^@\w{1,30}$/.test(text)) return true;
  if (/^\d+([.,]\d+)?[KMB]?$/.test(text)) return true;
  if (/^\d+[smhdw]$/.test(text)) return true;

  return false;
}

function isDirectReadableChromeInPostWithExplicitBody(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  if (!isDirectReadableCandidate(element)) return false;
  if (!isInsidePostWithExplicitBody(element)) return false;
  if (element.closest('[data-testid="tweetText"]')) return false;
  if (isShortDirectReadableBeforeExplicitBody(element, textCache)) return true;

  return [...element.children].some((child) => {
    if (child.matches(feedLowValueSelector)) return true;
    const text = normalizedElementText(child, textCache);
    return (
      /^@\w{1,30}$/.test(text) ||
      /^\d+([.,]\d+)?[KMB]?$/.test(text) ||
      /^\d+[smhdw]$/.test(text)
    );
  });
}

function isShortDirectReadableBeforeExplicitBody(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  const post = element.closest(
    [
      '[data-testid="tweet"]',
      '[data-testid="cellInnerDiv"]',
      '[role="feed"]',
      '[role="listitem"]',
      '[role="article"]',
    ].join(","),
  );
  const explicitBody = post?.querySelector('[data-testid="tweetText"]');
  if (!post || !explicitBody) return false;
  if ((element.compareDocumentPosition(explicitBody) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
    return false;
  }

  const text = normalizedElementText(element, textCache);
  return text.length > 0 && text.length < genericMinimumTextLength;
}

function isInsideBodySafeTextContainer(element: Element): boolean {
  return (
    element.closest('[data-testid="tweetText"]') !== null ||
    isInsideFallbackBodyTextContainer(element) ||
    closestDirectReadableFeedElement(element) !== null
  );
}

function isInsideFallbackBodyTextContainer(element: Element): boolean {
  const textContainer = element.closest("[lang], [dir='auto']");
  if (!textContainer) return false;

  const post = textContainer.closest(
    [
      '[data-testid="tweet"]',
      '[data-testid="cellInnerDiv"]',
      '[role="feed"]',
      '[role="listitem"]',
      '[role="article"]',
    ].join(","),
  );
  return post?.querySelector('[data-testid="tweetText"]') === null;
}

function closestDirectReadableFeedElement(element: Element): Element | null {
  const readable = element.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6");
  if (!readable || !isDirectReadableCandidate(readable)) return null;
  if (isInsidePostWithExplicitBody(readable)) return null;
  return isFeedHeuristicContext(readable) ? readable : null;
}

function isInsidePostWithExplicitBody(element: Element): boolean {
  if (element.closest('[data-testid="tweetText"]')) return false;

  const post = element.closest(
    [
      '[data-testid="tweet"]',
      '[data-testid="cellInnerDiv"]',
      '[role="feed"]',
      '[role="listitem"]',
      '[role="article"]',
    ].join(","),
  );
  return post !== null && post.querySelector('[data-testid="tweetText"]') !== null;
}

function isLowValueElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  return (
    isFeedPageChromeElement(element) ||
    isPageChromeDescendantOutsideArticle(element) ||
    isWeakTextHintInPageChrome(element) ||
    isGenericLowValueElement(element, textCache) ||
    isFeedLowValueElement(element, textCache)
  );
}

function isFeedPageChromeElement(element: Element): boolean {
  if (isFeedHeuristicContext(element)) return false;
  return element.closest(feedPageChromeSelector) !== null;
}

function isPageChromeDescendantOutsideArticle(element: Element): boolean {
  const chrome = element.closest(extractablePageChromeSelector);
  if (!chrome) return false;

  const article = element.closest("article, [role='article']");
  return article === null || !article.contains(chrome);
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
  if (isWeakTextHintInPageChrome(element)) return false;
  if (isNonBodyTextHintInPostWithExplicitBody(element)) return false;
  if (element.matches(legacyStoryTableTitleSelector)) return true;
  if (element.matches(cardHeadlineSelector)) return true;
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

function isWeakTextHintInPageChrome(element: Element): boolean {
  if (!element.matches("[lang], [dir='auto']")) return false;
  if (isFeedHeuristicContext(element)) return false;
  if (element.closest('[data-testid="tweetText"]')) return false;

  if (!element.closest("article, main, [role='main'], [role='article']")) {
    return false;
  }

  const chrome = element.closest(pageChromeSelector);
  return chrome !== null;
}

function isNonBodyTextHintInPostWithExplicitBody(element: Element): boolean {
  if (!element.matches("[lang], [dir='auto']")) return false;
  if (element.closest('[data-testid="tweetText"]')) return false;

  const post = element.closest(
    [
      '[data-testid="tweet"]',
      '[data-testid="cellInnerDiv"]',
      '[role="feed"]',
      '[role="listitem"]',
      '[role="article"]',
    ].join(","),
  );
  return post !== null && post.querySelector('[data-testid="tweetText"]') !== null;
}

function hasHighConfidenceReadableChild(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  return [...element.children].some((child) => {
    if (isElementSkippedForExtraction(child) || isLowValueElement(child, textCache)) {
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
  if (element.tagName === "LI" && element.querySelector(cardHeadlineSelector)) return false;
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
    if (isElementSkippedForExtraction(child)) continue;
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
    shouldSkipFeedLowValueInTextStream(element),
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
    shouldSkipFeedLowValueInTextStream(element),
    textCache,
  );
}

function shouldSkipFeedLowValueInTextStream(element: Element): boolean {
  return !isDirectReadableCandidate(element) || isFeedHeuristicContext(element);
}

function collectTextStream(
  element: Element,
  excludedTags: ReadonlySet<string> = new Set(),
  skipFeedLowValue = true,
  textCache?: TextNormalizationCache,
): string {
  return normalizeSourceText(
    collectRawTextStream(element, excludedTags, skipFeedLowValue, textCache),
  );
}

function collectRawTextStream(
  element: Element,
  excludedTags: ReadonlySet<string>,
  skipFeedLowValue: boolean,
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
    if (isElementSkippedForExtraction(childElement)) continue;
    if (isFeedPageChromeElement(childElement)) continue;
    if (isPageChromeDescendantOutsideArticle(childElement)) continue;
    if (isWeakTextHintInPageChrome(childElement)) continue;
    if (isGenericLowValueElement(childElement, textCache)) continue;
    if (skipFeedLowValue && isFeedLowValueElement(childElement, textCache)) continue;
    if (excludedTags.has(childElement.tagName)) continue;

    parts.push(collectRawTextStream(childElement, excludedTags, skipFeedLowValue, textCache));
  }

  return parts.join("");
}

function shouldExtractElement(
  element: Element,
  textCache?: TextNormalizationCache,
): boolean {
  if (isElementSkippedForExtraction(element)) return false;
  if (isLowValueElement(element, textCache)) return false;
  if (isBrowserGeneratedPlainTextPre(element)) {
    return collectExtractableText(element, textCache).length > 0;
  }
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

function normalizePlainTextSource(sourceText: string): string {
  return sourceText.replace(/\r\n?/g, "\n");
}

function plainTextBreakIndex(text: string, start: number): number {
  const maxEnd = Math.min(text.length, start + plainTextSegmentMaxLength);
  if (maxEnd === text.length) return text.length;

  const candidate = text.slice(start, maxEnd + 1);
  const minimumUsefulBreak = plainTextSegmentMaxLength * 0.5;
  const paragraphBreak = candidate.lastIndexOf("\n\n");
  if (paragraphBreak > minimumUsefulBreak) {
    let end = start + paragraphBreak;
    while (end < text.length && text[end] === "\n") {
      end += 1;
    }
    return end;
  }

  const lineBreak = candidate.lastIndexOf("\n");
  if (lineBreak > minimumUsefulBreak) {
    return start + lineBreak + 1;
  }

  const whitespaceBreak = Math.max(
    candidate.lastIndexOf(" "),
    candidate.lastIndexOf("\t"),
  );
  if (whitespaceBreak > minimumUsefulBreak) {
    return start + whitespaceBreak + 1;
  }

  return maxEnd;
}

function splitPlainTextSource(sourceText: string): string[] {
  const text = normalizePlainTextSource(sourceText);
  if (!normalizeSourceText(text)) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = plainTextBreakIndex(text, start);
    const chunk = text.slice(start, end);
    if (normalizeSourceText(chunk)) {
      chunks.push(chunk);
    }
    start = end;
  }

  return chunks;
}

function plainTextChunkElements(
  element: Element,
  options: { materialize: boolean },
): HTMLElement[] {
  const chunks = splitPlainTextSource(element.textContent ?? "");
  if (chunks.length === 0) return [];

  if (chunks.length === 1) {
    if (options.materialize) {
      element.textContent = chunks[0];
    }
    return [element as HTMLElement];
  }

  if (!options.materialize) {
    return chunks.map((chunk) => {
      const chunkElement = element.cloneNode(false) as HTMLElement;
      chunkElement.textContent = chunk;
      return chunkElement;
    });
  }

  const computedStyle = window.getComputedStyle(element);
  const chunkElements = chunks.map((chunk) => {
    const chunkElement = element.cloneNode(false) as HTMLElement;
    chunkElement.textContent = chunk;
    return chunkElement;
  });
  for (const [index, chunkElement] of chunkElements.entries()) {
    chunkElement.dataset.yoyoPlainTextChunk = "true";
    chunkElement.style.marginTop = index === 0 ? computedStyle.marginTop : "0";
    chunkElement.style.marginBottom =
      index === chunkElements.length - 1 ? computedStyle.marginBottom : "0";
    chunkElement.style.marginLeft = computedStyle.marginLeft;
    chunkElement.style.marginRight = computedStyle.marginRight;
  }

  element.replaceWith(...chunkElements);
  return chunkElements;
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
    addOptions: { preserveSourceText?: boolean } = {},
  ): Promise<void> {
    const normalizedText = normalizeSourceText(sourceText);
    if (!normalizedText) {
      return;
    }
    const segmentSourceText = addOptions.preserveSourceText
      ? sourceText
      : normalizedText;

    const priority = priorityForElement(element);
    if (options.visibleRangeOnly && priority === "normal") {
      return;
    }

    const segmentId = `seg_${order}`;
    segments.push({
      id: segmentId,
      order,
      sourceText: segmentSourceText,
      kind: segmentKindFor(element),
      priority,
      pathHint: pathHintFor(element),
      textHash: addOptions.preserveSourceText
        ? await hashSourceText(segmentSourceText)
        : await hashNormalizedText(segmentSourceText),
      preserveWhitespace: addOptions.preserveSourceText || undefined,
    });
    anchors.set({
      segmentId,
      sourceNode: element,
      taskId,
    });
    order += 1;
  }

  async function walk(element: Element): Promise<void> {
    if (seenNodes.has(element)) return;
    seenNodes.add(element);
    if (isElementSkippedForExtraction(element)) return;
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

    if (isBrowserGeneratedPlainTextPre(element)) {
      const chunkElements = plainTextChunkElements(element, {
        materialize: options.materializePlainTextChunks === true,
      });
      for (const [index, chunkElement] of chunkElements.entries()) {
        if (options.visibleRangeOnly && index > 0) {
          break;
        }
        await addSegment(chunkElement, chunkElement.textContent ?? "", {
          preserveSourceText: true,
        });
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

  const roots = options.root ? [options.root] : discoverRoots();
  for (const root of roots) {
    await walk(root);
  }

  return { segments, anchors };
}
