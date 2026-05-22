import { elapsedMs, nowMs, tracePerf } from "@/utils/perfTrace";

export type SelectionTranslationPanelInput =
  | {
      sourceText: string;
      translatedText: string;
      errorMessage?: never;
    }
  | {
      sourceText: string;
      errorMessage: string;
      translatedText?: never;
    };

const panelId = "yoyo-selection-translation-panel";

function removeExistingPanel(): void {
  document.getElementById(panelId)?.remove();
}

function createTextBlock(label: string, text: string): HTMLElement {
  const block = document.createElement("div");
  const heading = document.createElement("strong");
  const body = document.createElement("p");

  heading.textContent = label;
  body.textContent = text;
  block.append(heading, body);
  return block;
}

export function showSelectionTranslation(
  input: SelectionTranslationPanelInput,
): void {
  const startedAt = nowMs();

  removeExistingPanel();

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.style.position = "fixed";
  panel.style.right = "24px";
  panel.style.bottom = "24px";
  panel.style.zIndex = "2147483647";
  panel.style.maxWidth = "360px";
  panel.style.padding = "12px";
  panel.style.borderRadius = "12px";
  panel.style.background = "#111827";
  panel.style.color = "#f9fafb";
  panel.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.24)";
  panel.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";

  panel.append(createTextBlock("Source", input.sourceText));
  if (input.errorMessage !== undefined) {
    panel.append(createTextBlock("Error", input.errorMessage));
  } else {
    panel.append(createTextBlock("Translation", input.translatedText ?? ""));
  }

  document.body.append(panel);
  tracePerf("content.selectionPanel.done", {
    stage: "selection",
    sourceCharCount: input.sourceText.length,
    outputCharCount: input.translatedText?.length ?? 0,
    durationMs: elapsedMs(startedAt),
    success: input.errorMessage === undefined,
  });
}
