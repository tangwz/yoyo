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
  collectSummarySource,
  collectSegments,
  estimatePage,
  finalizeLazyRecoverySourceLanguage,
  getPageRuntimeState,
  handleTaskProgress,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
  stopActivePageRuntime,
} from "@/content/pageRuntime";

function renderedConsoleOutput(calls: unknown[][]): string {
  return calls
    .map((call) =>
      call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    )
    .join("\n");
}

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

  class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];
    readonly observed = new Set<Element>();

    constructor(private readonly callback: IntersectionObserverCallback) {
      MockIntersectionObserver.instances.push(this);
    }

    observe(element: Element): void {
      this.observed.add(element);
    }

    unobserve(element: Element): void {
      this.observed.delete(element);
    }

    disconnect(): void {
      this.observed.clear();
    }

    emitIntersecting(element: Element): void {
      this.callback(
        [
          {
            target: element,
            isIntersecting: true,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: element.getBoundingClientRect(),
            intersectionRect: element.getBoundingClientRect(),
            rootBounds: null,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
  }

  class MockMutationObserver {
    static instances: MockMutationObserver[] = [];
    readonly observed = new Set<Node>();

    constructor(private readonly callback: MutationCallback) {
      MockMutationObserver.instances.push(this);
    }

    observe(target: Node): void {
      this.observed.add(target);
    }

    disconnect(): void {
      this.observed.clear();
    }

    emit(mutations: MutationRecord[]): void {
      this.callback(mutations, this as unknown as MutationObserver);
    }
  }

  beforeEach(() => {
    removePageTranslations();
    document.body.innerHTML = "";
    document.title = "";
    setUrl("https://example.com/article");
    MockIntersectionObserver.instances = [];
    MockMutationObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("MutationObserver", MockMutationObserver);
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
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.title = "";
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

  it("collects summary source without inserting translation nodes", async () => {
    document.title = "Fallback document title";
    document.body.innerHTML = `
      <article>
        <h1>Readable article title</h1>
        <p>First readable paragraph.</p>
        <p>Second readable paragraph.</p>
      </article>
    `;

    const result = await collectSummarySource();

    const expectedSourceText = [
      "Readable article title",
      "First readable paragraph.",
      "Second readable paragraph.",
    ].join("\n\n");
    expect(result).toEqual({
      title: "Readable article title",
      sourceText: expectedSourceText,
      sourceCharCount: expectedSourceText.length,
      segmentCount: 3,
    });
    expect(document.querySelector("[data-yoyo-translation]")).toBeNull();
  });

  it("estimates and summarizes plain text without rewriting the source pre", async () => {
    const originalContentType = document.contentType;
    const paragraphs = Array.from(
      { length: 6 },
      (_, index) =>
        `Paragraph ${index + 1} ${"describes a raw text section ".repeat(20).trim()}.`,
    );
    const rawText = paragraphs.join("\n\n");
    Object.defineProperty(document, "contentType", {
      configurable: true,
      value: "text/plain",
    });
    document.body.innerHTML = `<pre style="word-wrap: break-word; white-space: pre-wrap;">${rawText}</pre>`;

    try {
      await estimatePage();
      const summary = await collectSummarySource();

      expect(summary.sourceText).toBe(rawText);
      expect(document.querySelectorAll("pre")).toHaveLength(1);
      expect(document.querySelector("pre")?.textContent).toBe(rawText);
      expect(document.querySelector("[data-yoyo-translation]")).toBeNull();
    } finally {
      Object.defineProperty(document, "contentType", {
        configurable: true,
        value: originalContentType,
      });
    }
  });

  it("limits summary source length and reports the truncated character count", async () => {
    const firstParagraph = "A".repeat(16_000);
    const secondParagraph = "B".repeat(10_000);
    document.body.innerHTML = `
      <article>
        <p>${firstParagraph}</p>
        <p>${secondParagraph}</p>
      </article>
    `;

    const result = await collectSummarySource();
    const expectedSourceText = `${firstParagraph}\n\n${"B".repeat(7_998)}`;

    expect(result.sourceText).toBe(expectedSourceText);
    expect(result.sourceText.length).toBe(24_000);
    expect(result.sourceCharCount).toBe(24_000);
    expect(result.segmentCount).toBe(2);
  });

  it("rejects pages without readable summary content", async () => {
    document.body.innerHTML = `
      <main>
        <button>Save</button>
      </main>
    `;

    await expect(collectSummarySource()).rejects.toThrow(
      "No readable article content found.",
    );
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

  it("traces collected segments without raw text", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    document.body.innerHTML = `
      <article>
        <p>First private paragraph.</p>
        <p>Second private paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "zh-CN");

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.collectSegments.done",
      expect.objectContaining({
        taskId: "task-1",
        translationMode: "fullPage",
        segmentCount: 2,
        sourceCharCount: 49,
        success: true,
      }),
    );
    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("First private paragraph.");
    expect(output).not.toContain("Second private paragraph.");

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
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
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
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

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        taskId: "task-1",
        sourceLanguage: "en",
        targetLanguage: "fr",
        translationMode: "lazyViewport",
        collectionComplete: false,
        recovery: expect.objectContaining({
          sourceLanguage: "en",
          targetLanguage: "fr",
          translationMode: "lazyViewport",
        }),
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
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.queue.flush.start",
      expect.objectContaining({
        taskId: "task-1",
        translationMode: "lazyViewport",
        segmentCount: 2,
        retryCount: 0,
        failedReportCount: 0,
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.queue.flush.done",
      expect.objectContaining({
        taskId: "task-1",
        translationMode: "lazyViewport",
        segmentCount: 2,
        retryCount: 0,
        failedReportCount: 0,
        success: true,
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("queues all discovered segments in full-page mode", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    document.body.innerHTML = `
      <article>
        <p id="visible">Visible paragraph.</p>
        <p id="far">Far paragraph.</p>
      </article>
    `;
    const rects: Record<string, { top: number; bottom: number }> = {
      visible: { top: 10, bottom: 30 },
      far: { top: 1000, bottom: 1030 },
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

    await collectSegments("task-1", "fullPage", "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        taskId: "task-1",
        translationMode: "fullPage",
        collectionComplete: true,
        segments: expect.arrayContaining([
          expect.objectContaining({ sourceText: "Visible paragraph." }),
          expect.objectContaining({ sourceText: "Far paragraph." }),
        ]),
      }),
    );

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

  it("retries failed initial lazy transport batches without losing reported anchors", async () => {
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
        segments: [
          expect.objectContaining({ id: "seg_1" }),
          expect.objectContaining({ id: "seg_2" }),
        ],
      }),
    );
    expect(batches[1]?.failedSegmentIds).toBeUndefined();

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("queues a normal segment when IntersectionObserver reports it visible", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <main>
        <article>
          <p id="visible">Visible paragraph.</p>
          <p id="later">Later paragraph.</p>
        </article>
      </main>
    `;

    const visible = document.querySelector("#visible") as HTMLElement;
    const later = document.querySelector("#later") as HTMLElement;
    visible.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 10,
        top: 10,
        bottom: 30,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;
    later.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 500,
        top: 500,
        bottom: 530,
        left: 0,
        right: 100,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      }) as DOMRect;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();

    expect(MockIntersectionObserver.instances[0]?.observed.has(later)).toBe(true);
    runtimeMock.sendRuntimeMessage.mockClear();

    later.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 20,
        top: 20,
        bottom: 50,
        left: 0,
        right: 100,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      }) as DOMRect;
    MockIntersectionObserver.instances[0]?.emitIntersecting(later);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [
          expect.objectContaining({
            sourceText: "Later paragraph.",
            priority: "viewport",
          }),
        ],
      }),
    );
    expect(runtimeMessages("enqueueLazySegments")).toEqual([]);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("discovers and enqueues newly inserted feed text while translation is active", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main id="feed">
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();

    document.querySelector("#feed")?.insertAdjacentHTML(
      "beforeend",
      `
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">New tweet text.</div>
        </article>
      `,
    );
    const insertedArticle = document.querySelector(
      "#feed article:last-child",
    ) as Element;
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: document.querySelector("#feed") as Node,
        addedNodes: [insertedArticle] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as MutationRecord,
    ]);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText: "New tweet text.",
            }),
          ],
        }),
      );
    });
  });

  it("requeues existing source nodes when their text changes", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <article>
          <div id="tweet" data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const tweet = document.querySelector("#tweet") as HTMLElement;
    const textNode = tweet.firstChild as Text;
    textNode.textContent = "Updated tweet text.";
    MockMutationObserver.instances[0]?.emit([
      {
        type: "characterData",
        target: textNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText: "Updated tweet text.",
            }),
          ],
        }),
      );
    });
  });

  it("observes newly inserted offscreen lazy text without enqueueing it immediately", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    document.body.innerHTML = `
      <main id="feed">
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    document.querySelector("#feed")?.insertAdjacentHTML(
      "beforeend",
      `
        <article>
          <div id="later" data-testid="tweetText" lang="en" dir="auto">Offscreen tweet text.</div>
        </article>
      `,
    );
    const later = document.querySelector("#later") as HTMLElement;
    later.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 1200,
        top: 1200,
        bottom: 1230,
        left: 0,
        right: 100,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      }) as DOMRect;
    const insertedArticle = document.querySelector(
      "#feed article:last-child",
    ) as Element;
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: document.querySelector("#feed") as Node,
        addedNodes: [insertedArticle] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(MockIntersectionObserver.instances[0]?.observed.has(later)).toBe(true);
    });

    later.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 20,
        top: 20,
        bottom: 50,
        left: 0,
        right: 100,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      }) as DOMRect;
    MockIntersectionObserver.instances[0]?.emitIntersecting(later);
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [
          expect.objectContaining({
            sourceText: "Offscreen tweet text.",
          }),
        ],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("drops source nodes when text changes to non-extractable content", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <article>
          <div id="tweet" data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const tweet = document.querySelector("#tweet") as HTMLElement;
    const textNode = tweet.firstChild as Text;
    textNode.textContent = "";
    MockMutationObserver.instances[0]?.emit([
      {
        type: "characterData",
        target: textNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(
      document.querySelector("[data-yoyo-translation][data-yoyo-segment-id='seg_1']"),
    ).toBeNull();
    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        failedSegmentIds: ["seg_1"],
      }),
    );
  });

  it("requeues an owning segment when descendant text changes", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p id="paragraph">Readable paragraph with enough context around <span id="child">old text</span> for extraction.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1);
    runtimeMock.sendRuntimeMessage.mockClear();

    const child = document.querySelector("#child") as HTMLElement;
    const textNode = child.firstChild as Text;
    textNode.textContent = "new text";
    MockMutationObserver.instances[0]?.emit([
      {
        type: "characterData",
        target: textNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText:
                "Readable paragraph with enough context around new text for extraction.",
            }),
          ],
        }),
      );
    });
  });

  it("drops source nodes removed by dynamic page updates", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <article>
          <div id="tweet" data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const tweet = document.querySelector("#tweet") as HTMLElement;
    tweet.remove();
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: document.querySelector("article") as Node,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [tweet] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        failedSegmentIds: ["seg_1"],
      }),
    );
    expect(
      document.querySelector("[data-yoyo-translation][data-yoyo-segment-id='seg_1']"),
    ).toBeNull();
  });

  it("translates dynamically inserted X-like feed posts during an active manual task", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <section id="timeline" role="feed" aria-label="Timeline: Home">
          <article data-testid="tweet">
            <div data-testid="tweetText" lang="en" dir="auto">Initial dynamic post text.</div>
            <div role="group" aria-label="Post actions">
              <button>Reply</button>
              <button>Repost</button>
              <button>Like</button>
            </div>
          </article>
        </section>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const timeline = document.querySelector("#timeline") as HTMLElement;
    const nextPost = document.createElement("article");
    nextPost.dataset.testid = "tweet";
    nextPost.innerHTML = `
      <header>
        <span dir="auto">Display Name</span>
        <span dir="auto">@display</span>
        <time>1m</time>
      </header>
      <div data-testid="tweetText" lang="en" dir="auto">Inserted post body should be queued.</div>
      <div role="group" aria-label="Post actions">
        <button>Reply</button>
        <button>Repost</button>
        <button>Like</button>
      </div>
    `;
    timeline.append(nextPost);
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: timeline,
        addedNodes: [nextPost] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText: "Inserted post body should be queued.",
            }),
          ],
        }),
      );
    });
    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      segments: Array<{ sourceText: string }>;
    }>("enqueueTranslationBatch");
    expect(
      batches.flatMap((batch) =>
        batch.segments.map((segment) => segment.sourceText),
      ),
    ).not.toEqual(
      expect.arrayContaining(["Reply", "Repost", "Like", "Display Name", "@display"]),
    );
  });

  it("ignores dynamic side rail updates while a feed translation task is active", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <section role="feed">
          <article data-testid="tweet">
            <div data-testid="tweetText" lang="en" dir="auto">Initial post body.</div>
          </article>
        </section>
        <aside id="rail" aria-label="Who to follow">
          <div dir="auto">Existing suggestion</div>
        </aside>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const rail = document.querySelector("#rail") as HTMLElement;
    const suggestion = document.createElement("div");
    suggestion.setAttribute("dir", "auto");
    suggestion.textContent = "New suggested account";
    rail.append(suggestion);
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: rail,
        addedNodes: [suggestion] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(runtimeMessages("enqueueTranslationBatch")).toEqual([]);
  });

  it("keeps translations when a click-driven page update temporarily detaches a source node", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <article id="post">
          <div id="tweet" data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Translated tweet text." },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    const post = document.querySelector("#post") as HTMLElement;
    const tweet = document.querySelector("#tweet") as HTMLElement;
    const translatedNode = document.querySelector(
      "[data-yoyo-translation][data-yoyo-segment-id='seg_1']",
    ) as HTMLElement;

    tweet.remove();
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: post,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [tweet] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);
    if (translatedNode.isConnected) {
      post.insertBefore(tweet, translatedNode);
    } else {
      post.append(tweet);
    }
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: post,
        addedNodes: [tweet] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(
      document.querySelector("[data-yoyo-translation][data-yoyo-segment-id='seg_1']"),
    ).toBe(translatedNode);
    expect(translatedNode.previousElementSibling).toBe(tweet);
    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        failedSegmentIds: ["seg_1"],
      }),
    );
  });

  it("requeues an owning segment when descendant content is removed", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p id="paragraph">Readable paragraph with enough context and <span id="child">temporary text</span> for extraction.</p>
      </article>
    `;

    await collectSegments("task-1", "fullPage", "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1);
    runtimeMock.sendRuntimeMessage.mockClear();

    const paragraph = document.querySelector("#paragraph") as HTMLElement;
    const child = document.querySelector("#child") as HTMLElement;
    child.remove();
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: paragraph,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [child] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText:
                "Readable paragraph with enough context and for extraction.",
            }),
          ],
        }),
      );
    });
  });

  it("does not let a stale collection overwrite a newer task", async () => {
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let resolveFirstDigest: ((value: ArrayBuffer) => void) | undefined;
    const firstDigest = new Promise<ArrayBuffer>((resolve) => {
      resolveFirstDigest = resolve;
    });
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementationOnce(async () => firstDigest)
      .mockImplementation((algorithm, data) => realDigest(algorithm, data));

    document.body.innerHTML = `
      <article>
        <p>Slow task paragraph.</p>
      </article>
    `;
    const staleCollection = collectSegments("task-1", "fullPage", "en", "fr");
    await vi.waitFor(() => {
      expect(digestSpy).toHaveBeenCalled();
    });

    document.body.innerHTML = `
      <article>
        <p>Newer task paragraph.</p>
      </article>
    `;
    await expect(collectSegments("task-2", "fullPage", "en", "de")).resolves.toEqual([
      expect.objectContaining({
        sourceText: "Newer task paragraph.",
      }),
    ]);

    resolveFirstDigest?.(new ArrayBuffer(32));
    await expect(staleCollection).rejects.toThrow(
      "Translation collection was superseded.",
    );
    expect(getPageRuntimeState()).toMatchObject({ taskId: "task-2" });

    digestSpy.mockRestore();
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
          translated: 5,
          failed: 0,
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
      }),
    );
    expect(batches[1]?.failedSegmentIds).toBeUndefined();
  });

  it("retries failed full-page transport batches when no normal pending segments remain", async () => {
    vi.useFakeTimers();
    runtimeMock.sendRuntimeMessage
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "waitingForViewport",
          total: 2,
          translated: 2,
          failed: 0,
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
        segments: [
          expect.objectContaining({ id: "seg_1" }),
          expect.objectContaining({ id: "seg_2" }),
        ],
      }),
    );
    expect(batches[1]?.failedSegmentIds).toBeUndefined();
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

  it("stops lazy collection and reporting when the active page runtime is stopped", async () => {
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

    expect(stopActivePageRuntime()).toBe("task-1");

    rects.third = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

    expect(runtimeMessages("enqueueLazySegments")).toEqual([]);
    expect(runtimeMessages("enqueueTranslationBatch")).toEqual([]);

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

  it("marks queued segments translated when page results are applied", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    document.body.innerHTML = `
      <article>
        <p>Visible paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Translated paragraph." },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(200);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [expect.objectContaining({ id: "seg_1" })],
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.applyTranslations.done",
      expect.objectContaining({
        taskId: "task-1",
        itemCount: 1,
        appliedCount: 1,
        failedCount: 0,
        success: true,
      }),
    );

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("marks queued segments failed when page results cannot be applied", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p id="source">Visible paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    document.querySelector("#source")?.remove();
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Translated paragraph." },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(200);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [expect.objectContaining({ id: "seg_1" })],
      }),
    );
  });

  it("does not let stale apply results mutate a newer task queue", async () => {
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
    await collectSegments("task-2", "lazyViewport");
    await flushDeferredLazyCollection();
    applyTranslationResults("task-1", [
      { segmentId: "seg_2", translatedText: "Stale translated paragraph." },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);

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

  it.each(["cancelled", "failed"] as const)(
    "does not apply late translation results after task progress is %s",
    async (terminalState) => {
      vi.useFakeTimers();
      document.body.innerHTML = `
        <article>
          <p>Visible readable paragraph.</p>
        </article>
      `;

      await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
      handleTaskProgress({
        taskId: "task-1",
        state: terminalState,
        total: 1,
        translated: terminalState === "failed" ? 0 : 1,
        failed: terminalState === "failed" ? 1 : 0,
      });

      const result = applyTranslationResults("task-1", [
        { segmentId: "seg_1", translatedText: "Translated paragraph." },
      ]);
      const translatedNodes = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-yoyo-translation][data-yoyo-segment-id='seg_1']",
        ),
      ].filter((node) => node.dataset.yoyoPending !== "true");

      expect(result).toEqual({
        appliedSegmentIds: [],
        failedSegmentIds: ["seg_1"],
      });
      expect(translatedNodes).toHaveLength(0);
    },
  );

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

  it("defers lazy recovery reporting until source language is finalized", async () => {
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

    await collectSegments(
      "task-1",
      "lazyViewport",
      "auto",
      "zh-CN",
      "chrome-built-in-ai",
      undefined,
      true,
    );

    rects.second = { top: 80, bottom: 96 };
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(150);
    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalled();

    expect(finalizeLazyRecoverySourceLanguage("task-1", "auto")).toBe(true);
    expect(finalizeLazyRecoverySourceLanguage("task-1", "en")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueTranslationBatch")).toHaveLength(1);
    });
    expect(runtimeMessages("enqueueTranslationBatch")[0]).toEqual(
      expect.objectContaining({
        sourceLanguage: "en",
      }),
    );
    await vi.waitFor(() => {
      expect(runtimeMessages("enqueueLazySegments")).toHaveLength(1);
    });
    expect(runtimeMessages("enqueueLazySegments")[0]).toEqual(
      expect.objectContaining({
        type: "enqueueLazySegments",
        segmentIds: ["seg_2"],
        recovery: expect.objectContaining({
          sourceLanguage: "en",
        }),
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });
});
