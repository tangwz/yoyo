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
  handleTaskProgress,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
} from "@/content/pageRuntime";

describe("page runtime", () => {
  const setUrl = (url: string) => {
    (window as unknown as { happyDOM: { setURL: (nextUrl: string) => void } })
      .happyDOM.setURL(url);
  };

  function runtimeMessages<T extends { type: string }>(type: T["type"]): T[] {
    return runtimeMock.sendRuntimeMessage.mock.calls
      .map(([message]) => message as T)
      .filter((message) => message.type === type);
  }

  async function flushDeferredLazyCollection(): Promise<void> {
    const previousLazyMessageCount = runtimeMessages("enqueueLazySegments").length;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueLazySegments").length).toBeGreaterThan(
        previousLazyMessageCount,
      );
    });
    runtimeMock.sendRuntimeMessage.mockClear();
  }

  async function drainPendingTimers(): Promise<void> {
    if (!vi.isFakeTimers()) {
      return;
    }

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  }

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

  afterEach(async () => {
    await drainPendingTimers();
    removePageTranslations();
    await drainPendingTimers();
    vi.useRealTimers();
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

  it("inserts lazy pending indicators only for viewport and near-viewport segments", async () => {
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

    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          "[data-yoyo-translation][data-yoyo-pending='true']",
        ),
      ].map((node) => node.dataset.yoyoSegmentId),
    ).toEqual(["seg_1", "seg_2"]);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("enqueues visible lazy viewport segments as a runtime translation batch", async () => {
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

    await collectSegments("task-1", "lazyViewport", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith({
      type: "enqueueTranslationBatch",
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "fr",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        expect.objectContaining({
          id: "seg_1",
          sourceText: "First readable paragraph.",
          priority: "viewport",
        }),
        expect.objectContaining({
          id: "seg_2",
          sourceText: "Second readable paragraph.",
          priority: "nearViewport",
        }),
      ],
    });

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("stops lazy reporting when the initial lazy queue flush returns terminal progress", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    runtimeMock.sendRuntimeMessage.mockResolvedValue({
      type: "taskProgress",
      progress: {
        taskId: "task-1",
        state: "cancelled",
        total: 3,
        translated: 2,
        failed: 0,
      },
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

    await collectSegments("task-1", "lazyViewport", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });
    expect(runtimeMessages("enqueueLazySegments")).toHaveLength(0);
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.third = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalled();

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("reconciles failed initial lazy batches without losing reported anchors", async () => {
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
          translated: 0,
          failed: 2,
        },
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

    await collectSegments("task-1", "lazyViewport", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(2);
    });

    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      collectionComplete?: boolean;
      failedSegmentIds?: string[];
      segments: Array<{ id: string }>;
    }>("enqueueTranslationBatch");
    expect(batches[1]).toEqual(
      expect.objectContaining({
        collectionComplete: false,
        failedSegmentIds: ["seg_1", "seg_2"],
        segments: [
          expect.objectContaining({ id: "seg_1" }),
          expect.objectContaining({ id: "seg_2" }),
        ],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("clears non-lazy translation batches after terminal broadcast progress", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p>First readable paragraph.</p>
        <p>Second readable paragraph.</p>
        <p>Third readable paragraph.</p>
        <p>Fourth readable paragraph.</p>
        <p>Fifth readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    runtimeMock.sendRuntimeMessage.mockClear();

    handleTaskProgress({
      taskId: "task-1",
      state: "cancelled",
      total: 5,
      translated: 4,
      failed: 0,
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalled();
  });

  it("marks only the final full-page local queue batch as collection complete", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p>First readable paragraph.</p>
        <p>Second readable paragraph.</p>
        <p>Third readable paragraph.</p>
        <p>Fourth readable paragraph.</p>
        <p>Fifth readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(2);
    });

    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      collectionComplete?: boolean;
      segments: Array<{ id: string }>;
    }>("enqueueTranslationBatch");
    expect(batches[0]).toEqual(
      expect.objectContaining({
        collectionComplete: false,
        segments: [
          expect.objectContaining({ id: "seg_1" }),
          expect.objectContaining({ id: "seg_2" }),
          expect.objectContaining({ id: "seg_3" }),
          expect.objectContaining({ id: "seg_4" }),
        ],
      }),
    );
    expect(batches[1]).toEqual(
      expect.objectContaining({
        collectionComplete: true,
        segments: [expect.objectContaining({ id: "seg_5" })],
      }),
    );
  });

  it("continues flushing later pending batches after a runtime enqueue failure", async () => {
    vi.useFakeTimers();
    runtimeMock.sendRuntimeMessage
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "waitingForViewport",
          total: 5,
          translated: 1,
          failed: 4,
        },
      });
    document.body.innerHTML = `
      <article>
        <p>First readable paragraph.</p>
        <p>Second readable paragraph.</p>
        <p>Third readable paragraph.</p>
        <p>Fourth readable paragraph.</p>
        <p>Fifth readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(2);
    });

    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      collectionComplete?: boolean;
      failedSegmentIds?: string[];
      segments: Array<{ id: string }>;
    }>("enqueueTranslationBatch");
    expect(batches[0]?.segments.map((segment) => segment.id)).toEqual([
      "seg_1",
      "seg_2",
      "seg_3",
      "seg_4",
    ]);
    expect(batches[1]?.segments.map((segment) => segment.id)).toEqual([
      "seg_5",
      "seg_1",
      "seg_2",
      "seg_3",
      "seg_4",
    ]);
    expect(batches[1]).toEqual(
      expect.objectContaining({
        collectionComplete: true,
        failedSegmentIds: ["seg_1", "seg_2", "seg_3", "seg_4"],
      }),
    );
  });

  it("reconciles failed full-page batches when no normal pending segments remain", async () => {
    vi.useFakeTimers();
    runtimeMock.sendRuntimeMessage
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "waitingForViewport",
          total: 2,
          translated: 0,
          failed: 2,
        },
      });
    document.body.innerHTML = `
      <article>
        <p>First readable paragraph.</p>
        <p>Second readable paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "fr");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(2);
    });

    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      collectionComplete?: boolean;
      failedSegmentIds?: string[];
      segments: Array<{ id: string }>;
    }>("enqueueTranslationBatch");
    expect(batches[1]).toEqual(
      expect.objectContaining({
        collectionComplete: true,
        failedSegmentIds: ["seg_1", "seg_2"],
        segments: [
          expect.objectContaining({ id: "seg_1" }),
          expect.objectContaining({ id: "seg_2" }),
        ],
      }),
    );
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
    await flushDeferredLazyCollection();

    rects.third = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    const [lazyMessage] = runtimeMessages<{
      type: "enqueueLazySegments";
      taskId: string;
      segmentIds: string[];
      recovery?: { segments: Array<{ id: string; sourceText: string }> };
    }>("enqueueLazySegments");
    const thirdSegmentIds = lazyMessage?.recovery?.segments
      .filter((segment) => segment.sourceText === "Third readable paragraph.")
      .map((segment) => segment.id);
    expect(lazyMessage).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        segmentIds: expect.any(Array),
      }),
    );
    expect(lazyMessage?.segmentIds).toHaveLength(1);
    expect(thirdSegmentIds).toEqual(
      expect.arrayContaining(lazyMessage?.segmentIds ?? []),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("keeps initial lazy anchors stable when deferred collection reuses segment ids", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <article>
        <p id="above">Above viewport readable paragraph.</p>
        <p id="visible">Visible readable paragraph.</p>
        <p id="below">Below viewport readable paragraph.</p>
      </article>
    `;

    const rects: Record<string, { top: number; bottom: number }> = {
      above: { top: -500, bottom: -470 },
      visible: { top: 10, bottom: 30 },
      below: { top: 420, bottom: 450 },
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
    await flushDeferredLazyCollection();

    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Visible translated paragraph." },
    ]);

    const translatedNode = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-yoyo-translation][data-yoyo-segment-id='seg_1']",
      ),
    ].find((node) => node.dataset.yoyoPending !== "true");

    expect(translatedNode?.previousElementSibling).toBe(
      document.querySelector("#visible"),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("cancels deferred lazy collection when the task is removed before the scan starts", async () => {
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

    let rectReadCount = 0;
    const rects: Record<string, { top: number; bottom: number }> = {
      first: { top: 10, bottom: 30 },
      second: { top: 420, bottom: 450 },
      third: { top: 520, bottom: 550 },
    };

    for (const id of Object.keys(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () => {
        rectReadCount += 1;
        return {
          x: 0,
          y: rects[id].top,
          top: rects[id].top,
          bottom: rects[id].bottom,
          left: 0,
          right: 100,
          width: 100,
          height: rects[id].bottom - rects[id].top,
          toJSON: () => ({}),
        } as DOMRect;
      };
    }

    await collectSegments("task-1", "lazyViewport");
    rectReadCount = 0;

    removePageTranslations("task-1");
    await vi.advanceTimersByTimeAsync(1);
    const deferredRectReadCount = rectReadCount;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });

    expect(deferredRectReadCount).toBe(0);
  });

  it("retries forced recovery after deferred lazy collection when enqueue fails", async () => {
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
          state: "waitingForViewport",
          total: 1,
          translated: 1,
          failed: 0,
        },
      })
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
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueLazySegments")).toHaveLength(1);
    });
    expect(runtimeMessages("enqueueLazySegments")[0]).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        segmentIds: [],
        recovery: expect.objectContaining({
          collectionComplete: true,
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueLazySegments")).toHaveLength(2);
    });
    expect(runtimeMessages("enqueueLazySegments")[1]).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        segmentIds: [],
        recovery: expect.objectContaining({
          collectionComplete: true,
        }),
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
    await flushDeferredLazyCollection();
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

  it.each(["cancelled", "failed"] as const)(
    "stops lazy segment reporting when enqueue returns %s progress",
    async (terminalState) => {
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
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: terminalState,
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

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledTimes(1);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
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
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "stops lazy segment reporting when broadcast progress is %s",
    async (terminalState) => {
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
      await flushDeferredLazyCollection();

      handleTaskProgress({
        taskId: "task-1",
        state: terminalState,
        total: 2,
        translated: 1,
        failed: terminalState === "failed" ? 1 : 0,
      });

      rects.second = { top: 80, bottom: 96 };
      window.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(150);

      expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalled();

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
    },
  );

  it("ignores stale lazy enqueue responses after a new translation starts", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    let resolveFirstReport:
      | ((response: Awaited<ReturnType<typeof runtimeMock.sendRuntimeMessage>>) => void)
      | undefined;
    runtimeMock.sendRuntimeMessage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstReport = resolve;
          }),
      )
      .mockResolvedValue({
        type: "taskProgress",
        progress: {
          taskId: "task-2",
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
    await flushDeferredLazyCollection();

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-1",
        segmentIds: ["seg_2"],
      }),
    );

    rects.second = { top: 420, bottom: 450 };
    await collectSegments("task-2", "lazyViewport");
    await flushDeferredLazyCollection();
    resolveFirstReport?.({
      type: "taskProgress",
      progress: {
        taskId: "task-1",
        state: "waitingForViewport",
        total: 2,
        translated: 1,
        failed: 0,
      },
    });
    await Promise.resolve();
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledTimes(1);
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueLazySegments",
        taskId: "task-2",
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
    await flushDeferredLazyCollection();

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
    await flushDeferredLazyCollection();
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
