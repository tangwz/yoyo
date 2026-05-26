import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
} from "@/messaging/contracts";
import { sendRuntimeMessage } from "@/messaging/runtime";
import { elapsedMs, nowMs, tracePerf } from "@/utils/perfTrace";

export type SelectionTranslationPanelInput = Extract<
  ContentRequest,
  { type: "showSelectionTranslation" }
>;

export type SelectionPanelDependencies = {
  sendBackgroundMessage?: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  clipboard?: Pick<Clipboard, "writeText">;
  createRequestId?: () => string;
};

type ResolvedSelectionPanelDependencies = {
  sendBackgroundMessage: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  clipboard?: Pick<Clipboard, "writeText">;
  createRequestId: () => string;
};

const panelId = "yoyo-selection-translation-panel";
const panelMargin = 12;
const fallbackLeft = 24;
const fallbackTop = 24;
const copyLabel = "Copy translation";
const copiedLabel = "Copied";
const copyFailedLabel = "Copy failed";
const copyResetDelayMs = 1600;
const svgNamespace = "http://www.w3.org/2000/svg";
const maxDismissedRequestIds = 32;
const maxTrackedRequestIds = 64;

let currentInput: SelectionTranslationPanelInput | undefined;
let currentDependencies: ResolvedSelectionPanelDependencies | undefined;
let latestRequestId: string | undefined;
let copyResetTimer: number | undefined;
const dismissedRequestIds = new Set<string>();
const seenRequestIds = new Set<string>();
const requestAnchors = new Map<string, PanelAnchorRect | undefined>();

type PanelAnchorRect = Pick<
  DOMRect,
  "bottom" | "height" | "left" | "top" | "width"
>;

function resolveDependencies(
  dependencies: SelectionPanelDependencies = {},
): ResolvedSelectionPanelDependencies {
  return {
    sendBackgroundMessage:
      dependencies.sendBackgroundMessage ??
      ((message) =>
        sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message)),
    clipboard: dependencies.clipboard ?? navigator.clipboard,
    createRequestId: dependencies.createRequestId ?? createRequestId,
  };
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `selection-${Date.now()}`;
}

function removeExistingPanel(): void {
  document.getElementById(panelId)?.remove();
  if (copyResetTimer !== undefined) {
    window.clearTimeout(copyResetTimer);
    copyResetTimer = undefined;
  }
}

function closePanel(): void {
  if (currentInput) {
    rememberDismissedRequestId(currentInput.requestId);
  }
  removeExistingPanel();
  currentInput = undefined;
}

function rememberDismissedRequestId(requestId: string): void {
  rememberRequestId(dismissedRequestIds, requestId, maxDismissedRequestIds);
}

function rememberSeenRequestId(requestId: string): void {
  rememberRequestId(seenRequestIds, requestId, maxTrackedRequestIds);
}

function rememberRequestId(
  requestIds: Set<string>,
  requestId: string,
  maxSize: number,
): void {
  requestIds.add(requestId);
  while (requestIds.size > maxSize) {
    const oldestRequestId = requestIds.values().next().value;
    if (oldestRequestId === undefined) {
      return;
    }
    requestIds.delete(oldestRequestId);
    requestAnchors.delete(oldestRequestId);
  }
}

function createHeader(input: SelectionTranslationPanelInput): HTMLElement {
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.marginBottom = "10px";

  const brand = document.createElement("span");
  brand.dataset.yoyoSelectionBrand = "";
  brand.setAttribute("aria-hidden", "true");
  brand.textContent = "Y";
  brand.style.display = "inline-flex";
  brand.style.alignItems = "center";
  brand.style.justifyContent = "center";
  brand.style.width = "22px";
  brand.style.height = "22px";
  brand.style.flex = "0 0 auto";
  brand.style.borderRadius = "6px";
  brand.style.background = "#16a34a";
  brand.style.color = "#ffffff";
  brand.style.font = "700 13px/1 ui-sans-serif, system-ui, sans-serif";

  const providerSelect = createProviderSelect(input);
  const spacer = document.createElement("span");
  spacer.style.flex = "1 1 auto";

  const copyButton = createIconButton("copy", copyLabel);
  copyButton.dataset.yoyoSelectionAction = "copy";
  copyButton.disabled =
    input.state !== "translated" || input.translatedText.length === 0;
  copyButton.addEventListener("click", () => {
    void copyTranslation(copyButton);
  });

  const closeButton = createIconButton("close", "Close translation popup");
  closeButton.dataset.yoyoSelectionAction = "close";
  closeButton.addEventListener("click", closePanel);

  header.append(brand, providerSelect, spacer, copyButton, closeButton);
  return header;
}

function createProviderSelect(input: SelectionTranslationPanelInput): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Selection translation provider");
  select.style.minWidth = "0";
  select.style.maxWidth = "210px";
  select.style.height = "28px";
  select.style.border = "1px solid rgba(22, 163, 74, 0.35)";
  select.style.borderRadius = "6px";
  select.style.background = "#ffffff";
  select.style.color = "#111827";
  select.style.font = "12px/1 ui-sans-serif, system-ui, sans-serif";
  select.style.padding = "0 6px";

  for (const option of input.providerOptions) {
    const optionElement = document.createElement("option");
    optionElement.value = option.id;
    optionElement.textContent = option.label;
    select.append(optionElement);
  }

  select.value = input.selectedProviderId ?? input.providerOptions[0]?.id ?? "";
  select.disabled = input.state === "loading" || input.providerOptions.length === 0;
  select.addEventListener("change", () => {
    void switchProvider(select.value);
  });

  return select;
}

function createIconButton(
  icon: "copy" | "close",
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.append(createIconSvg(icon));
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "28px";
  button.style.height = "28px";
  button.style.flex = "0 0 auto";
  button.style.border = "1px solid rgba(17, 24, 39, 0.12)";
  button.style.borderRadius = "6px";
  button.style.background = "#f9fafb";
  button.style.color = "#111827";
  button.style.font = "700 12px/1 ui-sans-serif, system-ui, sans-serif";
  button.style.cursor = "pointer";
  button.style.padding = "0";
  return button;
}

function createIconSvg(icon: "copy" | "close"): SVGSVGElement {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const pathData =
    icon === "copy"
      ? [
          "M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2",
          "M10 4h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        ]
      : ["M18 6 6 18", "M6 6l12 12"];

  for (const data of pathData) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }

  return svg;
}

function createBody(input: SelectionTranslationPanelInput): HTMLElement {
  const body = document.createElement("div");
  body.style.color = input.state === "failed" ? "#991b1b" : "#111827";
  body.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";
  body.style.whiteSpace = "pre-wrap";
  body.style.overflowWrap = "anywhere";
  body.textContent = bodyTextForInput(input);
  return body;
}

function bodyTextForInput(input: SelectionTranslationPanelInput): string {
  if (input.state === "loading") {
    return "Translating...";
  }
  if (input.state === "failed") {
    return input.errorMessage;
  }
  return input.translatedText;
}

function renderPanel(input: SelectionTranslationPanelInput): void {
  const startedAt = nowMs();

  removeExistingPanel();

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.className = "notranslate";
  panel.setAttribute("translate", "no");
  panel.dataset.yoyoExtension = "selection-translation-panel";
  panel.setAttribute("role", input.state === "failed" ? "alert" : "status");
  panel.setAttribute("aria-live", "polite");
  panel.style.position = "fixed";
  panel.style.left = `${fallbackLeft}px`;
  panel.style.top = `${fallbackTop}px`;
  panel.style.zIndex = "2147483647";
  panel.style.boxSizing = "border-box";
  panel.style.width = "min(360px, calc(100vw - 24px))";
  panel.style.maxHeight = "min(320px, calc(100vh - 24px))";
  panel.style.overflow = "auto";
  panel.style.padding = "12px";
  panel.style.border = "1px solid rgba(17, 24, 39, 0.12)";
  panel.style.borderRadius = "8px";
  panel.style.background = "#ffffff";
  panel.style.color = "#111827";
  panel.style.boxShadow = "0 18px 44px rgba(15, 23, 42, 0.22)";
  panel.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";

  panel.append(createHeader(input), createBody(input));
  document.body.append(panel);
  positionPanel(panel, input.requestId);

  tracePerf("content.selectionPanel.done", {
    stage: "selection",
    sourceCharCount: input.sourceText.length,
    outputCharCount: input.state === "translated" ? input.translatedText.length : 0,
    durationMs: elapsedMs(startedAt),
    success: input.state !== "failed",
  });
}

function positionPanel(panel: HTMLElement, requestId: string): void {
  const selectionRect = getOrCreateRequestAnchor(requestId);
  const panelRect = panel.getBoundingClientRect();
  const panelWidth = panelRect.width || 360;
  const panelHeight = panelRect.height || 120;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;

  if (!selectionRect) {
    panel.style.left = `${clamp(fallbackLeft, panelMargin, viewportWidth - panelWidth - panelMargin)}px`;
    panel.style.top = `${clamp(fallbackTop, panelMargin, viewportHeight - panelHeight - panelMargin)}px`;
    return;
  }

  const centeredLeft =
    selectionRect.left + selectionRect.width / 2 - panelWidth / 2;
  const topAbove = selectionRect.top - panelHeight - panelMargin;
  const topBelow = selectionRect.bottom + panelMargin;
  const hasRoomAbove = topAbove >= panelMargin;
  const top = hasRoomAbove ? topAbove : topBelow;

  panel.style.left = `${clamp(centeredLeft, panelMargin, viewportWidth - panelWidth - panelMargin)}px`;
  panel.style.top = `${clamp(top, panelMargin, viewportHeight - panelHeight - panelMargin)}px`;
}

function getOrCreateRequestAnchor(requestId: string): PanelAnchorRect | undefined {
  if (requestAnchors.has(requestId)) {
    return requestAnchors.get(requestId);
  }

  const selectionRect = getSelectionRect();
  requestAnchors.set(requestId, selectionRect);
  return selectionRect;
}

function copyRequestAnchor(sourceRequestId: string, targetRequestId: string): void {
  if (!requestAnchors.has(sourceRequestId) || requestAnchors.has(targetRequestId)) {
    return;
  }

  requestAnchors.set(targetRequestId, requestAnchors.get(sourceRequestId));
}

function getSelectionRect(): PanelAnchorRect | undefined {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return undefined;
  }

  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

async function switchProvider(providerId: string): Promise<void> {
  if (!currentInput || !currentDependencies || providerId.length === 0) {
    return;
  }

  const sourceInput = currentInput;
  const dependencies = currentDependencies;
  const requestId = dependencies.createRequestId();
  copyRequestAnchor(sourceInput.requestId, requestId);
  const loadingInput: SelectionTranslationPanelInput = {
    type: "showSelectionTranslation",
    requestId,
    state: "loading",
    sourceText: sourceInput.sourceText,
    sourceLanguage: sourceInput.sourceLanguage,
    targetLanguage: sourceInput.targetLanguage,
    selectedProviderId: providerId,
    providerOptions: sourceInput.providerOptions,
  };
  currentInput = loadingInput;
  renderPanel(loadingInput);

  try {
    const setProviderResponse = await dependencies.sendBackgroundMessage({
      type: "setSelectionTranslationProvider",
      providerId,
    });

    if (!isCurrentRequest(requestId)) {
      return;
    }

    if (setProviderResponse.type !== "backgroundActionResult") {
      renderFailed(
        loadingInput,
        messageForBackgroundResponse(
          setProviderResponse,
          "Unable to save selection translation provider.",
        ),
      );
      return;
    }

    const response = await dependencies.sendBackgroundMessage({
      type: "translateSelectionWithProvider",
      requestId,
      text: sourceInput.sourceText,
      sourceLanguage: sourceInput.sourceLanguage,
      targetLanguage: sourceInput.targetLanguage,
      providerId,
    });

    if (!isCurrentRequest(requestId)) {
      return;
    }

    if (
      (response.type === "selectionTranslationResult" ||
        response.type === "selectionTranslationError") &&
      response.requestId !== requestId
    ) {
      return;
    }

    if (
      response.type === "selectionTranslationResult" &&
      response.requestId === requestId
    ) {
      const translatedInput: SelectionTranslationPanelInput = {
        ...loadingInput,
        selectedProviderId: response.providerId,
        state: "translated",
        translatedText: response.translatedText,
      };
      currentInput = translatedInput;
      renderPanel(translatedInput);
      return;
    }

    if (
      response.type === "selectionTranslationError" &&
      response.requestId === requestId
    ) {
      renderFailed(loadingInput, response.message, response.providerId);
      return;
    }

    renderFailed(
      loadingInput,
      messageForBackgroundResponse(response, "Selection translation failed."),
    );
  } catch (error) {
    if (isCurrentRequest(requestId)) {
      renderFailed(
        loadingInput,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function messageForBackgroundResponse(
  response: BackgroundResponse,
  fallbackMessage: string,
): string {
  return response.type === "backgroundError" ? response.message : fallbackMessage;
}

function renderFailed(
  baseInput: Extract<SelectionTranslationPanelInput, { state: "loading" }>,
  errorMessage: string,
  selectedProviderId = baseInput.selectedProviderId,
): void {
  const failedInput: SelectionTranslationPanelInput = {
    ...baseInput,
    ...(selectedProviderId === undefined ? {} : { selectedProviderId }),
    state: "failed",
    errorMessage,
  };
  currentInput = failedInput;
  renderPanel(failedInput);
}

function isCurrentRequest(requestId: string): boolean {
  return (
    currentInput?.requestId === requestId &&
    document.getElementById(panelId) !== null
  );
}

async function copyTranslation(copyButton: HTMLButtonElement): Promise<void> {
  if (
    !currentInput ||
    !currentDependencies?.clipboard ||
    currentInput.state !== "translated"
  ) {
    setCopyState(copyButton, "failed");
    return;
  }

  try {
    await currentDependencies.clipboard.writeText(currentInput.translatedText);
    setCopyState(copyButton, "copied");
  } catch {
    setCopyState(copyButton, "failed");
  }
}

function setCopyState(
  copyButton: HTMLButtonElement,
  state: "copied" | "failed",
): void {
  if (copyResetTimer !== undefined) {
    window.clearTimeout(copyResetTimer);
  }

  copyButton.dataset.yoyoCopyState = state;
  copyButton.setAttribute(
    "aria-label",
    state === "copied" ? copiedLabel : copyFailedLabel,
  );
  copyResetTimer = window.setTimeout(() => {
    copyButton.dataset.yoyoCopyState = "";
    copyButton.setAttribute("aria-label", copyLabel);
    copyResetTimer = undefined;
  }, copyResetDelayMs);
}

export function showSelectionTranslation(
  input: SelectionTranslationPanelInput,
  dependencies: SelectionPanelDependencies = {},
): void {
  resetDetachedPanelState();

  if (dismissedRequestIds.has(input.requestId)) {
    return;
  } else if (latestRequestId !== input.requestId && isStaleInput(input)) {
    return;
  }

  rememberSeenRequestId(input.requestId);
  latestRequestId = input.requestId;
  currentInput = input;
  currentDependencies = resolveDependencies(dependencies);
  renderPanel(input);
}

function resetDetachedPanelState(): void {
  if (currentInput === undefined || document.getElementById(panelId) !== null) {
    return;
  }

  currentInput = undefined;
  latestRequestId = undefined;
  seenRequestIds.clear();
  dismissedRequestIds.clear();
  requestAnchors.clear();
}

function isStaleInput(input: SelectionTranslationPanelInput): boolean {
  return seenRequestIds.has(input.requestId);
}
