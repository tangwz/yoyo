import { beforeEach, describe, expect, it, vi } from "vitest";
import { showSelectionTranslation } from "@/content/selectionPanel";

function renderedConsoleOutput(calls: unknown[][]): string {
  return calls
    .map((call) =>
      call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    )
    .join("\n");
}

describe("selection panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders translated selection text", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      translatedText: "你好",
    });

    expect(document.body.textContent).toContain("Hello");
    expect(document.body.textContent).toContain("你好");
  });

  it("replaces previous panel content", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      translatedText: "你好",
    });
    showSelectionTranslation({
      sourceText: "Good morning",
      translatedText: "早上好",
    });

    expect(document.body.textContent).not.toContain("Hello");
    expect(document.body.textContent).toContain("Good morning");
  });

  it("renders error messages", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      errorMessage: "Chrome Built-in AI is unavailable.",
    });

    expect(document.body.textContent).toContain("Chrome Built-in AI is unavailable.");
  });

  it("traces successful selection panel rendering without raw text", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    showSelectionTranslation({
      sourceText: "Private source",
      translatedText: "Private translation",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.selectionPanel.done",
      expect.objectContaining({
        stage: "selection",
        sourceCharCount: 14,
        outputCharCount: 19,
        success: true,
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Private source");
    expect(output).not.toContain("Private translation");

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("traces failed selection panel rendering without raw text", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    showSelectionTranslation({
      sourceText: "Private source",
      errorMessage: "Provider failed",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.selectionPanel.done",
      expect.objectContaining({
        stage: "selection",
        sourceCharCount: 14,
        outputCharCount: 0,
        success: false,
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Private source");
    expect(output).not.toContain("Provider failed");

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
