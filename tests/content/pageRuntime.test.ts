// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  sendRuntimeMessage: vi.fn(),
}));

vi.mock("@/messaging/runtime", () => ({
  sendRuntimeMessage: runtimeMock.sendRuntimeMessage,
}));

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
    runtimeMock.sendRuntimeMessage.mockReset();
    runtimeMock.sendRuntimeMessage.mockResolvedValue({
      type: "taskProgress",
      progress: {
        taskId: "task-1",
        state: "waitingForViewport",
        total: 3,
        translated: 2,
        failed: 0,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("reports newly visible lazy segments after scrolling", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
        <p id="second">Second readable paragraph.</p>
        <p id="third">Third readable paragraph.</p>
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {
      first: { top: 10, bottom: 30 },
      second: { top: 180, bottom: 210 },
      third: { top: 420, bottom: 450 },
    };

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await collectSegments("task-1", "lazyViewport");
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.third = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: ["seg_3"],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("retries lazy segment reporting when the runtime enqueue fails", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    runtimeMock.sendRuntimeMessage
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "waitingForViewport",
          total: 2,
          translated: 1,
          failed: 0,
        },
      });

    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
        <p id="second">Second readable paragraph.</p>
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {
      first: { top: 10, bottom: 30 },
      second: { top: 420, bottom: 450 },
    };

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await collectSegments("task-1", "lazyViewport");
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: ["seg_2"],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("retries lazy segment reporting when the runtime enqueue returns terminal progress", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    runtimeMock.sendRuntimeMessage
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "cancelled",
          total: 0,
          translated: 0,
          failed: 0,
          errorMessage: "Translation task is no longer available. Start translation again.",
        },
      })
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "waitingForViewport",
          total: 2,
          translated: 1,
          failed: 0,
        },
      });

    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
        <p id="second">Second readable paragraph.</p>
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {
      first: { top: 10, bottom: 30 },
      second: { top: 420, bottom: 450 },
    };

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await collectSegments("task-1", "lazyViewport");
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: ["seg_2"],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("reports disconnected lazy segments as failed enqueue items", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph.</p>
        <p id="second">Second readable paragraph.</p>
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {
      first: { top: 10, bottom: 30 },
      second: { top: 420, bottom: 450 },
    };

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await collectSegments("task-1", "lazyViewport");
    runtimeMock.sendRuntimeMessage.mockClear();

    document.querySelector("#second")?.remove();
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: [],
        failedSegmentIds: ["seg_2"],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("includes a long-page recovery snapshot when reporting lazy segments", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <article>
        ${Array.from(
          { length: 12 },
          (_value, index) =>
            `<p id="paragraph-${index + 1}">Readable long article paragraph ${index + 1} with enough text for extraction.</p>`,
        ).join("")}
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {};
    for (let index = 1; index <= 12; index += 1) {
      rects[`paragraph-${index}`] = {
        top: index <= 2 ? index * 20 : 500 + index * 40,
        bottom: index <= 2 ? index * 20 + 20 : 520 + index * 40,
      };
    }

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "第一段。" },
      { segmentId: "seg_2", translatedText: "第二段。" },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    document.querySelector("#paragraph-3")?.remove();
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: [],
        failedSegmentIds: ["seg_3"],
      }),
    );
    runtimeMock.sendRuntimeMessage.mockClear();

    rects["paragraph-10"] = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: ["seg_10"],
        recovery: expect.objectContaining({
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          translationMode: "lazyViewport",
          processedSegmentIds: ["seg_1", "seg_2"],
          failedSegmentIds: ["seg_3"],
        }),
      }),
    );
    const request = runtimeMock.sendRuntimeMessage.mock.calls[0][0] as {
      recovery: { segments: unknown[] };
    };
    expect(request.recovery.segments).toHaveLength(12);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
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
