export type PageSummaryPanelInput =
  | {
      targetLanguage: string;
      summaryText: string;
      errorMessage?: never;
    }
  | {
      targetLanguage: string;
      errorMessage: string;
      summaryText?: never;
    };

const panelId = "yoyo-page-summary-panel";
const copyStatusResetDelayMs = 1500;
const copyButtonDefaultText = "Copy";
const copyButtonDefaultLabel = "Copy summary";

function removeExistingPanel(): void {
  document.getElementById(panelId)?.remove();
}

function applyPanelStyle(panel: HTMLElement): void {
  panel.style.position = "fixed";
  panel.style.right = "24px";
  panel.style.bottom = "24px";
  panel.style.zIndex = "2147483647";
  panel.style.boxSizing = "border-box";
  panel.style.width = "min(420px, calc(100vw - 32px))";
  panel.style.maxHeight = "min(520px, calc(100vh - 32px))";
  panel.style.overflow = "auto";
  panel.style.padding = "14px";
  panel.style.borderRadius = "12px";
  panel.style.background = "#111827";
  panel.style.color = "#f9fafb";
  panel.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.24)";
  panel.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";
}

function applyHeaderButtonStyle(button: HTMLButtonElement): void {
  button.style.border = "1px solid rgba(255, 255, 255, 0.24)";
  button.style.borderRadius = "6px";
  button.style.padding = "4px 8px";
  button.style.color = "#f9fafb";
  button.style.background = "transparent";
  button.style.cursor = "pointer";
  button.style.font = "inherit";
}

function setButtonState(
  button: HTMLButtonElement,
  text: string,
  ariaLabel: string,
): void {
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      if (copyTextWithLegacyCommand(text)) {
        return;
      }

      throw new Error("Clipboard copy failed.");
    }
  }

  if (copyTextWithLegacyCommand(text)) {
    return;
  }

  throw new Error("Clipboard copy is unavailable.");
}

function copyTextWithLegacyCommand(text: string): boolean {
  if (document.execCommand === undefined) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

async function handleCopySummary(
  button: HTMLButtonElement,
  summaryText: string,
): Promise<void> {
  button.disabled = true;

  try {
    await copyTextToClipboard(summaryText);
    setButtonState(button, "Copied", "Copied summary");
  } catch {
    setButtonState(button, "Copy failed", "Copy summary failed");
  } finally {
    window.setTimeout(() => {
      setButtonState(button, copyButtonDefaultText, copyButtonDefaultLabel);
      button.disabled = false;
    }, copyStatusResetDelayMs);
  }
}

export function showPageSummary(input: PageSummaryPanelInput): void {
  removeExistingPanel();

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.setAttribute("role", input.errorMessage !== undefined ? "alert" : "status");
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute("data-yoyo-extension", "summary-panel");
  panel.dataset.yoyoSummaryLanguage = input.targetLanguage;
  applyPanelStyle(panel);

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";

  const title = document.createElement("strong");
  title.textContent = "Summary";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.alignItems = "center";
  actions.style.gap = "8px";

  if (input.summaryText !== undefined) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    setButtonState(copyButton, copyButtonDefaultText, copyButtonDefaultLabel);
    copyButton.dataset.yoyoSummaryCopyButton = "true";
    copyButton.addEventListener("click", () => {
      void handleCopySummary(copyButton, input.summaryText);
    });
    applyHeaderButtonStyle(copyButton);
    actions.append(copyButton);
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close summary");
  closeButton.dataset.yoyoSummaryCloseButton = "true";
  closeButton.addEventListener("click", removeExistingPanel);
  applyHeaderButtonStyle(closeButton);
  actions.append(closeButton);

  const body = document.createElement("p");
  body.textContent = input.errorMessage ?? input.summaryText ?? "";
  body.style.margin = "12px 0 0";
  body.style.whiteSpace = "pre-wrap";

  header.append(title, actions);
  panel.append(header, body);
  document.body.append(panel);
}
