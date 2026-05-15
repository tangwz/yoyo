import { beforeEach, describe, expect, it } from "vitest";
import { showSelectionTranslation } from "@/content/selectionPanel";

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
});
