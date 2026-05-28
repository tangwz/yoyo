const blockedProtocols = new Set([
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "file:",
]);

const blockedTags = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "PRE",
  "CODE",
  "TEXTAREA",
  "INPUT",
  "FORM",
  "BUTTON",
  "SELECT",
  "SVG",
  "CANVAS",
  "IFRAME",
  "VIDEO",
  "AUDIO",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TD",
  "TH",
]);

export function isPageUrlSupported(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !blockedProtocols.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isElementSkippable(element: Element): boolean {
  if (blockedTags.has(element.tagName)) return true;
  return hasNonTagSkipReason(element);
}

export function hasNonTagSkipReason(element: Element): boolean {
  if (element.hasAttribute("data-yoyo-translation")) return true;
  if (element.hasAttribute("data-yoyo-extension")) return true;
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if (element.hasAttribute("contenteditable")) return true;
  if ((element as HTMLElement).isContentEditable) return true;

  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}
