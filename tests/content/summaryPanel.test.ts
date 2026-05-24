import { beforeEach, describe, expect, it, vi } from "vitest";
import { showPageSummary } from "@/content/summaryPanel";

describe("summary panel", () => {
  const writeText = vi.fn<Clipboard["writeText"]>();
  const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "execCommand",
  );

  beforeEach(() => {
    document.body.innerHTML = "";
    writeText.mockReset();
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("renders summary text", () => {
    showPageSummary({
      targetLanguage: "en",
      summaryText: "This article explains local browser AI.",
    });

    expect(screenPanel().id).toBe("yoyo-page-summary-panel");
    expect(screenPanel().textContent).toContain("Summary");
    expect(screenPanel().textContent).toContain(
      "This article explains local browser AI.",
    );
  });

  it("marks the panel as extension-owned content", () => {
    showPageSummary({
      targetLanguage: "en",
      summaryText: "This article explains local browser AI.",
    });

    expect(screenPanel().getAttribute("data-yoyo-extension")).toBe("summary-panel");
  });

  it("renders error text", () => {
    showPageSummary({
      targetLanguage: "en",
      errorMessage: "No readable article content found.",
    });

    expect(screenPanel().textContent).toContain("Summary");
    expect(screenPanel().textContent).toContain(
      "No readable article content found.",
    );
  });

  it("copies summary text from the copy button", async () => {
    writeText.mockResolvedValue(undefined);

    showPageSummary({
      targetLanguage: "en",
      summaryText: "This article explains local browser AI.",
    });

    screenPanel()
      .querySelector<HTMLButtonElement>('[data-yoyo-summary-copy-button="true"]')
      ?.click();

    expect(writeText).toHaveBeenCalledWith(
      "This article explains local browser AI.",
    );
    await waitForCopyButtonState("Copied", "Copied summary");
  });

  it("falls back to execCommand when clipboard writeText is unavailable", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    showPageSummary({
      targetLanguage: "en",
      summaryText: "Fallback summary.",
    });

    screenPanel()
      .querySelector<HTMLButtonElement>('[data-yoyo-summary-copy-button="true"]')
      ?.click();

    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    await waitForCopyButtonState("Copied", "Copied summary");
  });

  it("falls back to execCommand when clipboard writeText rejects", async () => {
    const execCommand = vi.fn(() => true);
    writeText.mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    showPageSummary({
      targetLanguage: "en",
      summaryText: "Rejected clipboard summary.",
    });

    screenPanel()
      .querySelector<HTMLButtonElement>('[data-yoyo-summary-copy-button="true"]')
      ?.click();

    await waitForCopyButtonState("Copied", "Copied summary");

    expect(writeText).toHaveBeenCalledWith("Rejected clipboard summary.");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("shows copy failure state when all clipboard strategies fail", async () => {
    const execCommand = vi.fn(() => false);
    writeText.mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    showPageSummary({
      targetLanguage: "en",
      summaryText: "Uncopyable summary.",
    });

    screenPanel()
      .querySelector<HTMLButtonElement>('[data-yoyo-summary-copy-button="true"]')
      ?.click();

    await waitForCopyButtonState("Copy failed", "Copy summary failed");

    expect(writeText).toHaveBeenCalledWith("Uncopyable summary.");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("does not render a copy button for summary errors", () => {
    showPageSummary({
      targetLanguage: "en",
      errorMessage: "No readable article content found.",
    });

    expect(
      screenPanel().querySelector('[data-yoyo-summary-copy-button="true"]'),
    ).toBeNull();
  });

  it("replaces an existing summary panel", () => {
    showPageSummary({ targetLanguage: "en", summaryText: "First summary." });
    showPageSummary({ targetLanguage: "en", summaryText: "Second summary." });

    expect(document.querySelectorAll("#yoyo-page-summary-panel")).toHaveLength(1);
    expect(screenPanel().textContent).not.toContain("First summary.");
    expect(screenPanel().textContent).toContain("Second summary.");
  });

  it("closes the panel from the close button", () => {
    showPageSummary({ targetLanguage: "en", summaryText: "Summary." });

    screenPanel()
      .querySelector<HTMLButtonElement>('[data-yoyo-summary-close-button="true"]')
      ?.click();

    expect(document.getElementById("yoyo-page-summary-panel")).toBeNull();
  });
});

function screenPanel(): HTMLElement {
  const panel = document.getElementById("yoyo-page-summary-panel");
  if (!panel) {
    throw new Error("Summary panel was not rendered.");
  }
  return panel;
}

async function waitForCopyButtonState(
  expectedText: string,
  expectedLabel: string,
): Promise<void> {
  let actualText = "";
  let actualLabel: string | null = "";

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const button = screenPanel().querySelector<HTMLButtonElement>(
      '[data-yoyo-summary-copy-button="true"]',
    );
    actualText = button?.textContent ?? "";
    actualLabel = button?.getAttribute("aria-label") ?? "";

    if (actualText === expectedText && actualLabel === expectedLabel) {
      return;
    }

    await Promise.resolve();
  }

  expect(actualText).toBe(expectedText);
  expect(actualLabel).toBe(expectedLabel);
}
