import { describe, expect, it, vi } from "vitest";
import {
  TranslationTaskOrchestrator,
  type TranslationTaskOrchestratorDependencies,
} from "@/background/taskOrchestrator";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { ProviderError } from "@/provider/errors";
import type {
  GenerateTextRequest,
  ProviderProfile,
  StreamTextRequest,
} from "@/provider/types";
import type { PageSegment } from "@/translation/types";

function providerProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "profile-1",
    displayName: "Test Provider",
    type: "openai-compatible",
    baseURL: "https://provider.example.test",
    apiKey: "secret",
    textModel: "gpt-4.1-mini",
    ...overrides,
  };
}

function segment(overrides: Partial<PageSegment> = {}): PageSegment {
  return {
    id: "segment-1",
    order: 1,
    sourceText: "Hello world.",
    kind: "paragraph",
    pathHint: "body.p[1]",
    textHash: "hash-1",
    priority: "viewport",
    ...overrides,
  };
}

function createOrchestrator(
  overrides: Partial<TranslationTaskOrchestratorDependencies> = {},
) {
  const generateText = vi.fn<
    (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
  >();
  const streamText = vi.fn<
    (request: StreamTextRequest) => AsyncGenerator<{ text: string }>
  >();
  const getActiveProfile = vi.fn<() => Promise<ProviderProfile | undefined>>(
    async () => providerProfile(),
  );
  const sendToContent = vi.fn<
    (tabId: number, message: ContentRequest) => Promise<ContentResponse>
  >();
  const now = vi.fn(() => 1000);
  const createTaskId = vi.fn(() => "task-1");

  const orchestrator = new TranslationTaskOrchestrator({
    getActiveProfile,
    provider: { generateText, streamText },
    sendToContent,
    now,
    createTaskId,
    ...overrides,
  });

  return {
    orchestrator,
    generateText,
    streamText,
    getActiveProfile,
    sendToContent,
    now,
    createTaskId,
  };
}

async function* streamChunks(chunks: readonly string[]): AsyncGenerator<{ text: string }> {
  for (const text of chunks) {
    await Promise.resolve();
    yield { text };
  }
}

describe("TranslationTaskOrchestrator", () => {
  it("creates a task before collecting segments and completes translation", async () => {
    const collectedSegments = [
      segment({ id: "segment-1", sourceText: "Hello world." }),
      segment({
        id: "segment-2",
        order: 2,
        sourceText: "Good morning.",
        textHash: "hash-2",
      }),
    ];
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (tabId, message) => {
      expect(tabId).toBe(7);

      if (message.type === "collectSegments") {
        expect(orchestrator.getTask("task-1")).toMatchObject({
          taskId: "task-1",
          state: "collecting",
          total: 0,
          translated: 0,
          failed: 0,
        });
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: collectedSegments,
        };
      }

      expect(message).toEqual({
        type: "applyTranslations",
        taskId: "task-1",
        items: [
          { segmentId: "segment-1", translatedText: "你好，世界。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
      });
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [
          { segmentId: "segment-1", translatedText: "你好，世界。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(sendToContent).toHaveBeenNthCalledWith(1, 7, {
      type: "collectSegments",
      taskId: "task-1",
      translationMode: "lazyViewport",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      profile: expect.objectContaining({ id: "profile-1" }),
      prompt: expect.stringContaining("Target language: zh-CN"),
    });
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Hello world.");
    expect(generateText.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("cancels a task as superseded", async () => {
    const { orchestrator, sendToContent, generateText } = createOrchestrator();
    let resolveProvider: ((value: { text: string; model: string }) => void) | undefined;

    sendToContent.mockResolvedValue({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [segment()],
    });
    generateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    const progress = orchestrator.cancelTask("task-1", "superseded");

    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "cancelled",
    });
    expect(generateText.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);

    resolveProvider?.({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });
    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "cancelled",
    });
  });

  it("does not collect page content when no active provider profile exists", async () => {
    const missingProvider = vi.fn(async () => undefined);
    const { orchestrator, sendToContent, generateText } = createOrchestrator({
      getActiveProfile: missingProvider,
    });

    sendToContent.mockResolvedValue({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [segment()],
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(missingProvider).toHaveBeenCalledTimes(1);
    expect(sendToContent).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 0,
      translated: 0,
      failed: 0,
    });
  });

  it("completes with errors when provider output omits an expected segment", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockResolvedValueOnce({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [
        segment({ id: "segment-1", sourceText: "Hello world." }),
        segment({
          id: "segment-2",
          order: 2,
          sourceText: "Good morning.",
          textHash: "hash-2",
        }),
      ],
    });
    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    });
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completedWithErrors",
      total: 2,
      translated: 1,
      failed: 1,
    });
  });

  it("retries missing segment translations before marking them failed", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockResolvedValueOnce({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [
        segment({ id: "segment-1", sourceText: "Hello world." }),
        segment({
          id: "segment-2",
          order: 2,
          sourceText: "Good morning.",
          textHash: "hash-2",
        }),
      ],
    });
    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
        }),
        model: "gpt-4.1-mini",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          items: [{ segmentId: "segment-2", translatedText: "早上好。" }],
        }),
        model: "gpt-4.1-mini",
      });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]?.[0].prompt).toContain("segment-2");
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("translates page content in priority ordered batches and applies each batch", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    const collectedSegments = Array.from({ length: 6 }, (_value, index) =>
      segment({
        id: `segment-${index + 1}`,
        order: index + 1,
        sourceText: `Paragraph ${index + 1}.`,
        textHash: `hash-${index + 1}`,
      }),
    );
    const events: string[] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: collectedSegments,
        };
      }

      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      const segmentIds = message.items.map((item) => item.segmentId);
      events.push(`apply:${segmentIds.join(",")}`);
      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const segmentIds = collectedSegments
        .filter((candidate) => request.prompt.includes(candidate.id))
        .map((candidate) => candidate.id);

      events.push(`request:${segmentIds.join(",")}`);
      return {
        text: JSON.stringify({
          items: segmentIds.map((segmentId) => ({
            segmentId,
            translatedText: `Translated ${segmentId}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(events).toEqual([
      "request:segment-1,segment-2,segment-3,segment-4,segment-5,segment-6",
      "apply:segment-1,segment-2,segment-3,segment-4,segment-5,segment-6",
    ]);
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 6,
      translated: 6,
      failed: 0,
    });
  });

  it("completes with errors when a provider batch rejects after collection succeeds", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockResolvedValue({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [segment()],
    });
    generateText.mockRejectedValue(new Error("provider unavailable"));

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "completedWithErrors",
      total: 1,
      translated: 0,
      failed: 1,
    });
  });

  it("uses cached translation items on repeated translations", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId: vi.fn().mockReturnValueOnce("task-1").mockReturnValueOnce("task-2"),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-2",
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    });
    expect(progress).toEqual({
      taskId: "task-2",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });

  it("applies cached translations with the current segment id", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId: vi.fn().mockReturnValueOnce("task-1").mockReturnValueOnce("task-2"),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments" && message.taskId === "task-1") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment({ id: "segment-old", sourceText: "Repeated text." })],
        };
      }

      if (message.type === "collectSegments" && message.taskId === "task-2") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment({ id: "segment-new", sourceText: "Repeated text." })],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-old", text: "重复文本。" }],
      }),
      model: "gpt-4.1-mini",
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-2",
      items: [{ segmentId: "segment-new", translatedText: "重复文本。" }],
    });
  });

  it("deduplicates repeated normalized text within one translation task", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Repeated\u00A0text." }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Repeated text.",
              textHash: "hash-2",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-1", text: "重复文本。" }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-1");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("segment-2");
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [
        { segmentId: "segment-1", translatedText: "重复文本。" },
        { segmentId: "segment-2", translatedText: "重复文本。" },
      ],
    });
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("waits for viewport in lazy mode and translates newly enqueued segments once", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        expect(message.translationMode).toBe("lazyViewport");
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Visible.", priority: "viewport" }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Near.",
              textHash: "hash-2",
              priority: "nearViewport",
            }),
            segment({
              id: "segment-3",
              order: 3,
              sourceText: "Far.",
              textHash: "hash-3",
              priority: "normal",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const ids = ["segment-1", "segment-2", "segment-3"].filter((id) =>
        request.prompt.includes(id),
      );
      return {
        text: JSON.stringify({
          items: ids.map((id) => ({ id, text: `Translated ${id}` })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const initialProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-1");
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-2");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("segment-3");
    expect(initialProgress).toMatchObject({
      state: "waitingForViewport",
      total: 3,
      translated: 2,
    });

    const afterScroll = await orchestrator.enqueueLazySegments("task-1", ["segment-3", "segment-3"]);

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]?.[0].prompt).toContain("segment-3");
    expect(afterScroll).toMatchObject({
      state: "completed",
      translated: 3,
      failed: 0,
    });
  });

  it("returns cancelled progress when lazy enqueue references a missing task", async () => {
    const { orchestrator } = createOrchestrator();

    await expect(orchestrator.enqueueLazySegments("missing-task", ["segment-1"])).resolves.toEqual({
      taskId: "missing-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
      errorMessage: "Translation task is no longer available. Start translation again.",
    });
  });

  it("recovers a missing lazy task from a long-page recovery snapshot", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    const longSegments = Array.from({ length: 12 }, (_value, index) =>
      segment({
        id: `segment-${index + 1}`,
        order: index + 1,
        sourceText: `Long paragraph ${index + 1}.`,
        textHash: `hash-${index + 1}`,
        priority: index < 2 ? "viewport" : "normal",
      }),
    );

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      expect(message.items).toEqual([
        { segmentId: "segment-10", translatedText: "Translated paragraph 10." },
      ]);
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-10", text: "Translated paragraph 10." }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.enqueueLazySegments("task-1", ["segment-10"], [], {
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      segments: longSegments,
      processedSegmentIds: ["segment-1", "segment-2"],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-10");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain('"id":"segment-1"');
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 12,
      translated: 3,
      failed: 0,
    });
  });

  it("counts disconnected lazy segments as processed failures", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Visible.", priority: "viewport" }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Gone.",
              textHash: "hash-2",
              priority: "normal",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-1", text: "Translated visible." }],
      }),
      model: "gpt-4.1-mini",
    });

    const initialProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(initialProgress).toMatchObject({
      state: "waitingForViewport",
      translated: 1,
      failed: 0,
    });

    const afterDisconnect = await orchestrator.enqueueLazySegments("task-1", [], ["segment-2"]);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(afterDisconnect).toMatchObject({
      state: "completedWithErrors",
      total: 2,
      translated: 1,
      failed: 1,
    });
  });

  it("does not complete a lazy task while earlier segments are still in flight", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    let resolveInitialBatch:
      | ((value: { text: string; model: string }) => void)
      | undefined;

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Visible.", priority: "viewport" }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Later.",
              textHash: "hash-2",
              priority: "normal",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialBatch = resolve;
          }),
      )
      .mockResolvedValueOnce({
        text: JSON.stringify({
          items: [{ id: "segment-2", text: "Translated later." }],
        }),
        model: "gpt-4.1-mini",
      });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    const afterEnqueue = await orchestrator.enqueueLazySegments("task-1", ["segment-2"]);

    expect(afterEnqueue).toMatchObject({
      state: "translating",
      total: 2,
      translated: 1,
      failed: 0,
    });

    resolveInitialBatch?.({
      text: JSON.stringify({
        items: [{ id: "segment-1", text: "Translated visible." }],
      }),
      model: "gpt-4.1-mini",
    });

    await expect(running).resolves.toMatchObject({
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("applies streamed translation items as soon as each record is parsed", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();
    const applyEvents: string[] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "One." }),
            segment({ id: "segment-2", order: 2, sourceText: "Two.", textHash: "hash-2" }),
          ],
        };
      }

      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      applyEvents.push(message.items.map((item) => item.segmentId).join(","));
      return { type: "contentActionResult", success: true };
    });
    streamText.mockReturnValue(
      streamChunks([
        '{"id":"segment-1","text":"一。"}\n',
        '{"id":"segment-2","text":"二。"}\n',
      ]),
    );

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(applyEvents).toEqual(["segment-1", "segment-2"]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("falls back to non-streaming translation when streamText is unavailable", async () => {
    const fallbackGenerateText = vi.fn(async () => ({
      text: JSON.stringify({
        items: [{ id: "segment-1", text: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    }));
    const { orchestrator, streamText, sendToContent } = createOrchestrator({
      provider: {
        generateText: fallbackGenerateText,
      },
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }
      return { type: "contentActionResult", success: true };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamText).not.toHaveBeenCalled();
    expect(fallbackGenerateText).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 1,
    });
  });

  it("retries only missing streamed items after a stream fails mid-batch", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "One." }),
            segment({ id: "segment-2", order: 2, sourceText: "Two.", textHash: "hash-2" }),
          ],
        };
      }
      return { type: "contentActionResult", success: true };
    });
    streamText.mockImplementation(() =>
      (async function* () {
        yield { text: '{"id":"segment-1","text":"一。"}\n' };
        throw new Error("stream failed");
      })(),
    );
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-2", text: "二。" }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalled();
    expect(generateText.mock.calls.at(-1)?.[0].prompt).toContain("segment-2");
    expect(generateText.mock.calls.at(-1)?.[0].prompt).not.toContain("segment-1");
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("retries only failed fan-out members after a partial streaming apply", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();
    const applyEvents: string[][] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Repeated text." }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Repeated text.",
              textHash: "hash-2",
            }),
          ],
        };
      }

      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      applyEvents.push(message.items.map((item) => item.segmentId));
      if (applyEvents.length === 1) {
        return {
          type: "contentActionResult",
          success: false,
          appliedSegmentIds: ["segment-1"],
          failedSegmentIds: ["segment-2"],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    streamText.mockReturnValueOnce(streamChunks(['{"id":"segment-1","text":"重复文本。"}\n']));
    streamText.mockReturnValueOnce(streamChunks(['{"id":"segment-1","text":"重复文本。"}\n']));

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(2);
    expect(applyEvents).toEqual([["segment-1", "segment-2"], ["segment-2"]]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("does not cancel a completed task when a same-tab task starts later", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId: vi.fn().mockReturnValueOnce("task-1").mockReturnValueOnce("task-2"),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    await expect(
      orchestrator.translatePage({
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(orchestrator.getTask("task-1")).toMatchObject({
      taskId: "task-1",
      state: "completed",
    });
  });

  it("counts content apply errors as failed translations", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }

      return { type: "contentError", message: "Could not apply translations." };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "completedWithErrors",
      total: 1,
      translated: 0,
      failed: 1,
    });
  });

  it("counts partial content apply failures without caching failed items", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId: vi.fn().mockReturnValueOnce("task-1").mockReturnValueOnce("task-2"),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "Hello world." }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Good morning.",
              textHash: "hash-2",
            }),
          ],
        };
      }

      if (message.type === "applyTranslations" && message.taskId === "task-1") {
        return {
          type: "contentActionResult",
          success: false,
          appliedSegmentIds: ["segment-1"],
          failedSegmentIds: ["segment-2"],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [
          { segmentId: "segment-1", translatedText: "你好，世界。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
      }),
      model: "gpt-4.1-mini",
    });

    const firstProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    const secondProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(firstProgress).toMatchObject({
      state: "completedWithErrors",
      translated: 1,
      failed: 1,
    });
    expect(secondProgress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("does not cache translations that fail to apply to the page", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId: vi.fn().mockReturnValueOnce("task-1").mockReturnValueOnce("task-2"),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }

      if (message.type === "applyTranslations" && message.taskId === "task-1") {
        return { type: "contentError", message: "Could not apply translations." };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("does not apply translations after cancellation lands before page apply", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async () => {
      orchestrator.cancelTask("task-1", "userCancelled");
      return {
        text: JSON.stringify({
          items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
        }),
        model: "gpt-4.1-mini",
      };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(sendToContent).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "cancelled",
      translated: 0,
      failed: 0,
    });
  });

  it("starts translation tasks asynchronously and emits progress updates", async () => {
    const emitProgress = vi.fn();
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      emitProgress,
    });

    let resolveProvider: ((value: { text: string; model: string }) => void) | undefined;
    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment()],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );

    const initialProgress = orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(initialProgress).toMatchObject({
      taskId: "task-1",
      state: "collecting",
    });

    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    resolveProvider?.({
      text: JSON.stringify({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    await vi.waitFor(() => {
      expect(orchestrator.getTask("task-1")).toMatchObject({ state: "completed" });
    });
    expect(emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", state: "completed" }),
    );
  });

  it("splits a repeatedly failing batch and falls back to single segments", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "One." }),
            segment({ id: "segment-2", order: 2, sourceText: "Two.", textHash: "hash-2" }),
            segment({ id: "segment-3", order: 3, sourceText: "Three.", textHash: "hash-3" }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const containsSingleSegment =
        request.prompt.includes("segment-1") &&
        !request.prompt.includes("segment-2") &&
        !request.prompt.includes("segment-3");

      if (containsSingleSegment) {
        return {
          text: JSON.stringify({
            items: [{ segmentId: "segment-1", translatedText: "一。" }],
          }),
          model: "gpt-4.1-mini",
        };
      }

      throw new Error("batch failed");
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(generateText).toHaveBeenCalledTimes(9);
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [{ segmentId: "segment-1", translatedText: "一。" }],
    });
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completedWithErrors",
      total: 3,
      translated: 1,
      failed: 2,
    });
  });

  it("waits for the second active request before draining more batches after rate limiting", async () => {
    vi.useFakeTimers();
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >();
    const { orchestrator, sendToContent } = createOrchestrator({
      provider: { generateText },
    });
    let releaseSecondRequest: (() => void) | undefined;

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: Array.from({ length: 21 }, (_value, index) =>
            segment({
              id: `segment-${index + 1}`,
              order: index + 1,
              sourceText: `Paragraph ${index + 1}.`,
              textHash: `hash-${index + 1}`,
            }),
          ),
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText
      .mockRejectedValueOnce(new ProviderError("rateLimited", "Provider rate limit exceeded.", 429))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecondRequest = () =>
              resolve({
                text: JSON.stringify({
                  items: Array.from({ length: 10 }, (_value, index) => ({
                    id: `segment-${index + 11}`,
                    text: `Translated ${index + 11}`,
                  })),
                }),
                model: "gpt-4.1-mini",
              });
          }),
      )
      .mockImplementation(async (request) => {
        const ids = Array.from({ length: 21 }, (_value, index) => `segment-${index + 1}`)
          .filter((id) => request.prompt.includes(id));
        return {
          text: JSON.stringify({
            items: ids.map((id) => ({ id, text: `Translated ${id}` })),
          }),
          model: "gpt-4.1-mini",
        };
      });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
    });

    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(generateText).toHaveBeenCalledTimes(2);

    releaseSecondRequest?.();
    await vi.runAllTimersAsync();

    await expect(running).resolves.toMatchObject({
      state: "completed",
      translated: 21,
      failed: 0,
    });
  });
});
