// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTranslationResults,
  collectSegments,
  estimatePage,
  getPageRuntimeState,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
} from "@/content/pageRuntime";

describe("page runtime", () => {
  const setUrl = (url: string) => {
    (window as unknown as { happyDOM: { setURL: (nextUrl: string) => void } })
      .happyDOM.setURL(url);
  };

  beforeEach(() => {
    removePageTranslations();
    document.body.innerHTML = "";
    setUrl("https://example.com/article");
  });

  afterEach(() => {
    removePageTranslations();
    document.body.innerHTML = "";
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

  it("inserts pending indicators for collected segments", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
        <p id="second">Second readable paragraph.</p>
      </article>
    `;

    const segments = await collectSegments("task-1");

    expect(segments.map((segment) => segment.id)).toEqual(["seg_1", "seg_2"]);
    expect(
      document.querySelectorAll(
        "[data-yoyo-translation][data-yoyo-pending='true']",
      ),
    ).toHaveLength(2);
    expect(
      document.querySelector(
        "[data-yoyo-translation][data-yoyo-segment-id='seg_1']",
      )?.previousElementSibling,
    ).toBe(document.querySelector("#first"));
  });

  it("reports visible runtime state after applying translations", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Premier paragraphe lisible." },
    ]);

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: true,
      taskId: "task-1",
      visibility: "visible",
    });
  });

  it("reports hidden runtime state after hiding translations", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Premier paragraphe lisible." },
    ]);

    hidePageTranslations("task-1");

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: true,
      taskId: "task-1",
      visibility: "hidden",
    });
  });

  it("reports visible runtime state after showing translations", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Premier paragraphe lisible." },
    ]);
    hidePageTranslations("task-1");

    showPageTranslations("task-1");

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: true,
      taskId: "task-1",
      visibility: "visible",
    });
  });

  it("clears runtime state after removing translations", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Premier paragraphe lisible." },
    ]);

    removePageTranslations("task-1");

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: false,
      taskId: undefined,
      visibility: undefined,
    });
  });

  it("reconstructs runtime state from existing translation DOM", () => {
    document.body.innerHTML = `
      <article>
        <p>First readable paragraph.</p>
        <div data-yoyo-translation="true" data-yoyo-task-id="task-from-dom">
          Premier paragraphe lisible.
        </div>
      </article>
    `;

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: true,
      taskId: "task-from-dom",
      visibility: "visible",
    });

    document
      .querySelector("[data-yoyo-translation]")
      ?.setAttribute("data-yoyo-hidden", "true");

    expect(getPageRuntimeState()).toEqual({
      hasTranslations: true,
      taskId: "task-from-dom",
      visibility: "hidden",
    });
  });
});
