import { beforeEach, describe, expect, it } from "vitest";
import { showPageSummary } from "@/content/summaryPanel";

describe("summary panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
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

  it("replaces an existing summary panel", () => {
    showPageSummary({ targetLanguage: "en", summaryText: "First summary." });
    showPageSummary({ targetLanguage: "en", summaryText: "Second summary." });

    expect(document.querySelectorAll("#yoyo-page-summary-panel")).toHaveLength(1);
    expect(screenPanel().textContent).not.toContain("First summary.");
    expect(screenPanel().textContent).toContain("Second summary.");
  });

  it("closes the panel from the close button", () => {
    showPageSummary({ targetLanguage: "en", summaryText: "Summary." });

    screenPanel().querySelector<HTMLButtonElement>("button")?.click();

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
