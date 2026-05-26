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

let currentInput: SelectionTranslationPanelInput | undefined;
let currentDependencies: ResolvedSelectionPanelDependencies | undefined;
let copyResetTimer: number | undefined;

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
  removeExistingPanel();
  currentInput = undefined;
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

  const copyButton = createIconButton("[ ]", copyLabel, "copy");
  copyButton.disabled =
    input.state !== "translated" || input.translatedText.length === 0;
  copyButton.addEventListener("click", () => {
    void copyTranslation(copyButton);
  });

  const closeButton = createIconButton("x", "Close translation popup", "close");
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
  select.disabled = input.providerOptions.length === 0;
  select.addEventListener("change", () => {
    void switchProvider(select.value);
  });

  return select;
}

function createIconButton(
  text: string,
  label: string,
  action: "copy" | "close",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.yoyoSelectionAction = action;
  button.setAttribute("aria-label", label);
  button.textContent = text;
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
  positionPanel(panel);

  tracePerf("content.selectionPanel.done", {
    stage: "selection",
    sourceCharCount: input.sourceText.length,
    outputCharCount: input.state === "translated" ? input.translatedText.length : 0,
    durationMs: elapsedMs(startedAt),
    success: input.state !== "failed",
  });
}

function positionPanel(panel: HTMLElement): void {
  const selectionRect = getSelectionRect();
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

function getSelectionRect(): DOMRect | undefined {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return undefined;
  }

  return rect;
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
      renderFailed(loadingInput, response.message);
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
): void {
  const failedInput: SelectionTranslationPanelInput = {
    ...baseInput,
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
  currentInput = input;
  currentDependencies = resolveDependencies(dependencies);
  renderPanel(input);
}
