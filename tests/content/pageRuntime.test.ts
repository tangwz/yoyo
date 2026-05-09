// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSegments, estimatePage } from "@/content/pageRuntime";

describe("page runtime", () => {
  const setUrl = (url: string) => {
    (window as unknown as { happyDOM: { setURL: (nextUrl: string) => void } })
      .happyDOM.setURL(url);
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    setUrl("https://example.com/article");
  });

  afterEach(() => {
    setUrl("https://example.com/article");
  });

  it("rejects segment collection on unsupported URLs", async () => {
    document.body.innerHTML = `<article><p>Private local file text.</p></article>`;
    setUrl("file:///Users/example/private.html");

    await expect(collectSegments("task-1")).rejects.toThrow("Unsupported page URL.");
    await expect(estimatePage()).resolves.toMatchObject({
      canTranslate: false,
      estimatedSegments: 0,
      estimatedChars: 0,
      reason: "Unsupported page URL.",
    });
  });
});
