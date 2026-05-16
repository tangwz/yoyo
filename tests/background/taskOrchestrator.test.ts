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
  const getProviderProfile = vi.fn<(providerId: string) => Promise<ProviderProfile | undefined>>(
    async (providerId) => providerProfile({ id: providerId }),
  );
  const sendToContent = vi.fn<
    (tabId: number, message: ContentRequest) => Promise<ContentResponse>
  >();
  const now = vi.fn(() => 1000);
  const createTaskId = vi.fn(() => "task-1");

  const orchestrator = new TranslationTaskOrchestrator({
    getActiveProfile,
    getProviderProfile,
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
    getProviderProfile,
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
      providerId: "profile-1",
      textModel: "gpt-4.1-mini",
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

  it("requests current viewport segments before nearby segments from earlier DOM order", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    const requestedIds: string[][] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({
              id: "above-normal",
              order: 1,
              sourceText: "Far above.",
              textHash: "hash-above-normal",
              priority: "normal",
            }),
            segment({
              id: "above-near",
              order: 2,
              sourceText: "Near above.",
              textHash: "hash-above-near",
              priority: "nearViewport",
            }),
            segment({
              id: "current-viewport",
              order: 3,
              sourceText: "Current viewport.",
              textHash: "hash-current-viewport",
              priority: "viewport",
            }),
            segment({
              id: "below-near",
              order: 4,
              sourceText: "Near below.",
              textHash: "hash-below-near",
              priority: "nearViewport",
            }),
            segment({
              id: "below-normal",
              order: 5,
              sourceText: "Far below.",
              textHash: "hash-below-normal",
              priority: "normal",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      const ids = input.items?.map((item) => item.id) ?? [];
      requestedIds.push(ids);
      return {
        text: JSON.stringify({
          items: ids.map((id) => ({ id, text: `Translated ${id}` })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(requestedIds).toEqual([["current-viewport", "above-near", "below-near"]]);
    expect(progress).toMatchObject({
      state: "waitingForViewport",
      total: 5,
      translated: 3,
    });
  });

  it("merges lazy recovery segments into an active task before enqueueing", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [segment({ id: "visible", sourceText: "Visible.", priority: "viewport" })],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      const ids = input.items?.map((item) => item.id) ?? [];
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
    expect(initialProgress).toMatchObject({
      state: "waitingForViewport",
      total: 1,
      translated: 1,
    });

    const progress = await orchestrator.enqueueLazySegments(
      "task-1",
      ["normal"],
      [],
      {
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        collectionComplete: true,
        processedSegmentIds: ["visible"],
        segments: [
          segment({ id: "visible", sourceText: "Visible.", priority: "viewport" }),
          segment({
            id: "normal",
            order: 2,
            sourceText: "Normal.",
            textHash: "hash-normal",
            priority: "normal",
          }),
        ],
      },
    );

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]?.[0].prompt).toContain("normal");
    expect(progress).toMatchObject({
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("translates runtime-enqueued batches after an empty incomplete lazy collection", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      expect(message).toEqual({
        type: "applyTranslations",
        taskId: "task-1",
        items: [{ segmentId: "dynamic-1", translatedText: "动态文本。" }],
      });
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "dynamic-1", text: "动态文本。" }],
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
      total: 0,
      translated: 0,
      failed: 0,
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "Dynamic text.",
          priority: "viewport",
        }),
      ],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("dynamic-1");
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [{ segmentId: "dynamic-1", translatedText: "动态文本。" }],
    });
    expect(progress).toEqual({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });

  it("marks runtime batch failed segment ids before translating the current batch", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      expect(message.items).toEqual([
        { segmentId: "runtime-ok", translatedText: "Translated runtime-ok" },
      ]);
      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      const ids = input.items?.map((item) => item.id) ?? [];
      return {
        text: JSON.stringify({
          items: ids.map((id) => ({ id, text: `Translated ${id}` })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
      collectionComplete: true,
      failedSegmentIds: ["runtime-failed"],
      segments: [
        segment({
          id: "runtime-failed",
          sourceText: "Failed runtime text.",
          textHash: "hash-runtime-failed",
          priority: "viewport",
        }),
        segment({
          id: "runtime-ok",
          order: 2,
          sourceText: "Runtime text.",
          textHash: "hash-runtime-ok",
          priority: "viewport",
        }),
      ],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("runtime-failed");
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("runtime-ok");
    expect(progress).toEqual({
      taskId: "runtime-task",
      state: "completedWithErrors",
      total: 2,
      translated: 1,
      failed: 1,
    });
  });

  it("keeps an existing task without context waiting when runtime lazy collection is incomplete", async () => {
    const getActiveProfile = vi.fn()
      .mockReturnValueOnce(new Promise<ProviderProfile | undefined>(() => {}))
      .mockResolvedValueOnce(providerProfile());
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      expect(message).toEqual({
        type: "applyTranslations",
        taskId: "task-1",
        items: [{ segmentId: "dynamic-1", translatedText: "动态文本。" }],
      });
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "dynamic-1", text: "动态文本。" }],
      }),
      model: "gpt-4.1-mini",
    });

    orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "Dynamic text.",
          priority: "viewport",
        }),
      ],
    });

    expect(getActiveProfile).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(progress).toEqual({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });

  it("fails a missing runtime-enqueued task when no active provider profile exists", async () => {
    const getActiveProfile = vi.fn(async () => undefined);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "missing-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "Dynamic text.",
          priority: "viewport",
        }),
      ],
    });

    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    expect(sendToContent).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(progress).toEqual({
      taskId: "missing-task",
      state: "failed",
      total: 0,
      translated: 0,
      failed: 0,
      errorMessage: "No active provider profile.",
    });
    expect(orchestrator.getTask("missing-task")).toBeUndefined();
    expect(orchestrator.getTaskForTab(7)).toBeUndefined();
  });

  it("merges concurrent first runtime batches for the same task and tab", async () => {
    let resolveProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    const profilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveProfile = resolve;
    });
    const getActiveProfile = vi.fn(() => profilePromise);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const firstBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "First runtime text.",
          textHash: "hash-runtime-1",
          priority: "viewport",
        }),
      ],
    });
    const secondBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-2",
          sourceText: "Second runtime text.",
          textHash: "hash-runtime-2",
          priority: "viewport",
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(getActiveProfile).toHaveBeenCalledTimes(2);
    });
    resolveProfile?.(providerProfile());

    const results = await Promise.all([firstBatch, secondBatch]);

    expect(results).toEqual([
      expect.objectContaining({
        taskId: "runtime-task",
        total: 2,
        translated: 2,
        failed: 0,
      }),
      expect.objectContaining({
        taskId: "runtime-task",
        total: 2,
        translated: 2,
        failed: 0,
      }),
    ]);
    expect(results.map((result) => result.state)).not.toContain("cancelled");
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "applyTranslations",
      taskId: "runtime-task",
      items: [{ segmentId: "runtime-1", translatedText: "Translated runtime-1" }],
    });
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "applyTranslations",
      taskId: "runtime-task",
      items: [{ segmentId: "runtime-2", translatedText: "Translated runtime-2" }],
    });
    expect(orchestrator.getTask("runtime-task")).toMatchObject({
      state: "waitingForViewport",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("keeps full-page concurrent first runtime batches open until both merge", async () => {
    let resolveFirstProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    let resolveSecondProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    let resolveFirstProvider:
      | ((response: { text: string; model: string }) => void)
      | undefined;
    const firstProfilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveFirstProfile = resolve;
    });
    const secondProfilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveSecondProfile = resolve;
    });
    const getActiveProfile = vi.fn()
      .mockReturnValueOnce(firstProfilePromise)
      .mockReturnValueOnce(secondProfilePromise);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstProvider = resolve;
          }),
      )
      .mockImplementationOnce(async (request) => {
        const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
          items?: Array<{ id: string }>;
        };
        return {
          text: JSON.stringify({
            items: (input.items ?? []).map((item) => ({
              id: item.id,
              text: `Translated ${item.id}`,
            })),
          }),
          model: "gpt-4.1-mini",
        };
      });

    const firstBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
      collectionComplete: true,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "First runtime text.",
          textHash: "hash-runtime-1",
          priority: "viewport",
        }),
      ],
    });
    const secondBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
      collectionComplete: true,
      segments: [
        segment({
          id: "runtime-2",
          sourceText: "Second runtime text.",
          textHash: "hash-runtime-2",
          priority: "viewport",
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(getActiveProfile).toHaveBeenCalledTimes(2);
    });
    resolveFirstProfile?.(providerProfile());
    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(1);
    });
    resolveFirstProvider?.({
      text: JSON.stringify({
        items: [{ id: "runtime-1", text: "Translated runtime-1" }],
      }),
      model: "gpt-4.1-mini",
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTask("runtime-task")).toMatchObject({
        state: "translating",
        total: 1,
        translated: 1,
      });
    });
    resolveSecondProfile?.(providerProfile());

    await expect(Promise.all([firstBatch, secondBatch])).resolves.toEqual([
      {
        taskId: "runtime-task",
        state: "completed",
        total: 2,
        translated: 2,
        failed: 0,
      },
      {
        taskId: "runtime-task",
        state: "completed",
        total: 2,
        translated: 2,
        failed: 0,
      },
    ]);
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "applyTranslations",
      taskId: "runtime-task",
      items: [{ segmentId: "runtime-1", translatedText: "Translated runtime-1" }],
    });
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "applyTranslations",
      taskId: "runtime-task",
      items: [{ segmentId: "runtime-2", translatedText: "Translated runtime-2" }],
    });
  });

  it("rejects a missing runtime batch when another task is active for the same tab", async () => {
    const createTaskId = vi.fn(() => "new-task");
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "stale-dynamic", text: "Stale translation." }],
      }),
      model: "gpt-4.1-mini",
    });

    orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTaskForTab(7)).toMatchObject({
        taskId: "new-task",
        state: "waitingForViewport",
      });
    });

    const staleProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "old-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "stale-dynamic",
          sourceText: "Stale dynamic text.",
          priority: "viewport",
        }),
      ],
    });

    expect(staleProgress).toEqual({
      taskId: "old-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
      errorMessage: "Translation task is no longer available. Start translation again.",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "waitingForViewport",
    });
  });

  it("rejects a missing runtime batch when the same tab already has a completed task", async () => {
    const createTaskId = vi.fn(() => "new-task");
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId,
      now: vi.fn()
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(2000),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({
              id: "new-segment",
              sourceText: "New page text.",
              priority: "viewport",
            }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };

      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "completed",
    });

    generateText.mockClear();
    sendToContent.mockClear();

    const staleProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "old-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "old-runtime",
          sourceText: "Old runtime text.",
          priority: "viewport",
        }),
      ],
    });

    expect(staleProgress).toEqual({
      taskId: "old-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
      errorMessage: "Translation task is no longer available. Start translation again.",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(sendToContent).not.toHaveBeenCalled();
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "completed",
    });
  });

  it("rejects a runtime batch when its existing task belongs to another tab", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };

      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "tab-a-segment",
          sourceText: "Tab A text.",
          priority: "viewport",
        }),
      ],
    });
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
    });

    generateText.mockClear();
    sendToContent.mockClear();

    const rejectedProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 8,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "tab-b-segment",
          sourceText: "Tab B text.",
          priority: "viewport",
        }),
      ],
    });

    expect(rejectedProgress).toEqual({
      taskId: "task-1",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
      errorMessage: "Translation task is no longer available. Start translation again.",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(sendToContent).not.toHaveBeenCalled();
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
    });
    expect(orchestrator.getTaskForTab(8)).toBeUndefined();
  });

  it("merges collected segments after a runtime batch initializes the task first", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const requestedIds: string[] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      const ids = input.items?.map((item) => item.id) ?? [];
      requestedIds.push(...ids);
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
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });

    const runtimeProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });

    expect(runtimeProgress).toMatchObject({
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [
        segment({
          id: "initial-1",
          sourceText: "Initial visible text.",
          textHash: "hash-initial",
          priority: "viewport",
        }),
      ],
    });

    await expect(running).resolves.toEqual({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 2,
      translated: 2,
      failed: 0,
    });
    expect(requestedIds).toEqual(["runtime-1", "initial-1"]);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "waitingForViewport",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("keeps translatePage context when runtime batch arrives before collection returns", async () => {
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        expect(message).toMatchObject({
          taskId: "task-1",
          translationMode: "lazyViewport",
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        });
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });

    const runtimeProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "ja",
      targetLanguage: "fr",
      translationMode: "fullPage",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });

    expect(runtimeProgress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("Target language: fr");

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [
        segment({
          id: "normal-1",
          sourceText: "Normal text.",
          textHash: "hash-normal",
          priority: "normal",
        }),
      ],
    });

    await expect(running).resolves.toEqual({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 2,
      translated: 1,
      failed: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "waitingForViewport",
      total: 2,
      translated: 1,
      failed: 0,
    });
  });

  it("keeps pending translatePage context when a mismatched runtime batch arrives before profile resolves", async () => {
    let resolveProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const profilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveProfile = resolve;
    });
    const getActiveProfile = vi.fn(() => profilePromise);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        expect(message).toMatchObject({
          taskId: "task-1",
          translationMode: "lazyViewport",
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        });
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(getActiveProfile).toHaveBeenCalledTimes(1);
    });

    const runtimeBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "ja",
      targetLanguage: "fr",
      translationMode: "fullPage",
      collectionComplete: true,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });
    await Promise.resolve();
    expect(generateText).not.toHaveBeenCalled();

    resolveProfile?.(providerProfile());
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });
    await expect(runtimeBatch).resolves.toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });

    expect(getActiveProfile).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("Target language: fr");

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [],
    });
    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });

  it("does not apply runtime provider results after pending collection fails the task", async () => {
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    let resolveProvider:
      | ((response: { text: string; model: string }) => void)
      | undefined;
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >(
      async () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const { orchestrator, sendToContent } = createOrchestrator({
      provider: { generateText },
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      if (message.type === "applyTranslations") {
        throw new Error("Translations must not be applied after task failure.");
      }

      return { type: "contentActionResult", success: true };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });

    const runtimeBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    resolveCollect?.({
      type: "contentActionResult",
      success: true,
    });
    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 1,
      translated: 0,
      failed: 1,
      errorMessage: "Content script did not return page segments.",
    });

    resolveProvider?.({
      text: JSON.stringify({
        items: [{ id: "runtime-1", text: "Translated runtime." }],
      }),
      model: "gpt-4.1-mini",
    });
    await expect(runtimeBatch).resolves.toMatchObject({
      taskId: "task-1",
      state: "failed",
      translated: 0,
      failed: 1,
      errorMessage: "Content script did not return page segments.",
    });
    expect(sendToContent).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTask("task-1")).toMatchObject({
      taskId: "task-1",
      state: "failed",
      translated: 0,
      failed: 1,
      errorMessage: "Content script did not return page segments.",
    });
  });

  it("keeps original context when a runtime batch resumes after collection initializes it", async () => {
    const originalProfile = providerProfile({
      id: "original-provider",
      textModel: "original-model",
    });
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const getActiveProfile = vi.fn(async () => originalProfile);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: request.profile.textModel,
      };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });

    const runtimeBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "ja",
      targetLanguage: "fr",
      translationMode: "fullPage",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });
    await expect(runtimeBatch).resolves.toMatchObject({
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [
        segment({
          id: "initial-1",
          sourceText: "Initial visible text.",
          textHash: "hash-initial",
          priority: "viewport",
        }),
      ],
    });
    await expect(running).resolves.toMatchObject({
      state: "waitingForViewport",
      failed: 0,
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      profile: expect.objectContaining({
        id: "original-provider",
        textModel: "original-model",
      }),
      prompt: expect.stringContaining("Target language: zh-CN"),
    });
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("runtime-1");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("Target language: fr");
    expect(generateText.mock.calls[1]?.[0]).toMatchObject({
      profile: expect.objectContaining({
        id: "original-provider",
        textModel: "original-model",
      }),
      prompt: expect.stringContaining("Target language: zh-CN"),
    });
    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "waitingForViewport",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("does not load a runtime profile while collection is pending with bound context", async () => {
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const getActiveProfile = vi.fn()
      .mockResolvedValueOnce(providerProfile())
      .mockResolvedValueOnce(undefined);
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });

    const failedProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Runtime text.",
          textHash: "hash-runtime",
          priority: "viewport",
        }),
      ],
    });
    expect(failedProgress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
    expect(getActiveProfile).toHaveBeenCalledTimes(1);

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [
        segment({
          id: "initial-1",
          sourceText: "Initial visible text.",
          textHash: "hash-initial",
          priority: "viewport",
        }),
      ],
    });

    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 2,
      translated: 2,
      failed: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "waitingForViewport",
      translated: 2,
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

  it("rejects stale lazy recovery when the same tab already has an active task", async () => {
    let nextNow = 1000;
    const createTaskId = vi.fn(() => "new-task");
    const sendToContent = vi.fn<
      (tabId: number, message: ContentRequest) => Promise<ContentResponse>
    >();
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      now: vi.fn(() => {
        nextNow += 1;
        return nextNow;
      }),
      provider: { generateText },
      sendToContent,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      return { type: "contentActionResult", success: true };
    });

    orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTaskForTab(7)).toMatchObject({
        taskId: "new-task",
        state: "waitingForViewport",
      });
    });

    const staleProgress = await orchestrator.enqueueLazySegments(
      "old-task",
      ["segment-2"],
      [],
      {
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        segments: [
          segment({ id: "segment-1", sourceText: "Old visible.", priority: "viewport" }),
          segment({
            id: "segment-2",
            order: 2,
            sourceText: "Old later.",
            textHash: "hash-2",
            priority: "normal",
          }),
        ],
        processedSegmentIds: ["segment-1"],
      },
    );

    expect(staleProgress).toMatchObject({
      taskId: "old-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "waitingForViewport",
    });
  });

  it("rejects stale lazy recovery when a task starts while loading the recovery profile", async () => {
    let nextNow = 1000;
    let resolveRecoveryProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    const createTaskId = vi.fn(() => "new-task");
    const getProviderProfile = vi.fn(
      () =>
        new Promise<ProviderProfile | undefined>((resolve) => {
          resolveRecoveryProfile = resolve;
        }),
    );
    const sendToContent = vi.fn<
      (tabId: number, message: ContentRequest) => Promise<ContentResponse>
    >();
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      getProviderProfile,
      now: vi.fn(() => {
        nextNow += 1;
        return nextNow;
      }),
      provider: { generateText },
      sendToContent,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      return { type: "contentActionResult", success: true };
    });

    const staleRecovery = orchestrator.enqueueLazySegments(
      "old-task",
      ["segment-2"],
      [],
      {
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        providerId: "old-provider",
        segments: [
          segment({ id: "segment-1", sourceText: "Old visible.", priority: "viewport" }),
          segment({
            id: "segment-2",
            order: 2,
            sourceText: "Old later.",
            textHash: "hash-2",
            priority: "normal",
          }),
        ],
        processedSegmentIds: ["segment-1"],
      },
    );

    await vi.waitFor(() => {
      expect(getProviderProfile).toHaveBeenCalledWith("old-provider");
    });

    orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTaskForTab(7)).toMatchObject({
        taskId: "new-task",
        state: "waitingForViewport",
      });
    });

    resolveRecoveryProfile?.(providerProfile({ id: "old-provider" }));
    const staleProgress = await staleRecovery;

    expect(staleProgress).toMatchObject({
      taskId: "old-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "waitingForViewport",
    });
  });

  it("rejects stale lazy recovery when a task completes while loading the recovery profile", async () => {
    let resolveRecoveryProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    const createTaskId = vi.fn(() => "new-task");
    const getProviderProfile = vi.fn(
      () =>
        new Promise<ProviderProfile | undefined>((resolve) => {
          resolveRecoveryProfile = resolve;
        }),
    );
    const sendToContent = vi.fn<
      (tabId: number, message: ContentRequest) => Promise<ContentResponse>
    >();
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      getProviderProfile,
      provider: { generateText },
      sendToContent,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "new-segment", sourceText: "New page.", priority: "viewport" }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    const staleRecovery = orchestrator.enqueueLazySegments(
      "old-task",
      ["old-segment"],
      [],
      {
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        providerId: "old-provider",
        segments: [
          segment({ id: "old-visible", sourceText: "Old visible.", priority: "viewport" }),
          segment({
            id: "old-segment",
            order: 2,
            sourceText: "Old later.",
            textHash: "hash-old",
            priority: "normal",
          }),
        ],
        processedSegmentIds: ["old-visible"],
      },
    );

    await vi.waitFor(() => {
      expect(getProviderProfile).toHaveBeenCalledWith("old-provider");
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "completed",
    });

    resolveRecoveryProfile?.(providerProfile({ id: "old-provider" }));
    const staleProgress = await staleRecovery;

    expect(staleProgress).toMatchObject({
      taskId: "old-task",
      state: "cancelled",
      total: 0,
      translated: 0,
      failed: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "completed",
    });
  });

  it("prefers the active tab task over a cancelled task created in the same millisecond", async () => {
    const createTaskId = vi.fn()
      .mockReturnValueOnce("new-task");
    const { orchestrator, sendToContent } = createOrchestrator({
      createTaskId,
      now: vi.fn(() => 1000),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      return { type: "contentActionResult", success: true };
    });

    await orchestrator.enqueueLazySegments("old-task", [], [], {
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({ id: "segment-1", sourceText: "Old visible.", priority: "viewport" }),
      ],
      processedSegmentIds: ["segment-1"],
    });

    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "old-task",
      state: "waitingForViewport",
    });

    orchestrator.startTranslatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTaskForTab(7)).toMatchObject({
        taskId: "new-task",
        state: "waitingForViewport",
      });
    });
  });

  it("prefers the later tab task when terminal tasks share a timestamp", async () => {
    const createTaskId = vi.fn()
      .mockReturnValueOnce("new-task");
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      createTaskId,
      now: vi.fn(() => 1000),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "new-segment", sourceText: "New page.", priority: "viewport" }),
          ],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    await orchestrator.enqueueLazySegments("old-task", [], [], {
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: true,
      segments: [
        segment({ id: "old-segment", sourceText: "Old visible.", priority: "viewport" }),
      ],
      processedSegmentIds: ["old-segment"],
    });
    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "old-task",
      state: "completed",
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(orchestrator.getTaskForTab(7)).toMatchObject({
      taskId: "new-task",
      state: "completed",
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
      failedSegmentIds: ["segment-3"],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-10");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain('"id":"segment-1"');
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 12,
      translated: 3,
      failed: 1,
    });
  });

  it("retries unprocessed visible segments when recovering from a lazy snapshot", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      expect(message.items).toEqual([
        { segmentId: "segment-1", translatedText: "Translated visible." },
        { segmentId: "segment-2", translatedText: "Translated near." },
      ]);
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [
          { id: "segment-1", text: "Translated visible." },
          { id: "segment-2", text: "Translated near." },
        ],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.enqueueLazySegments("task-1", [], [], {
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
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
      processedSegmentIds: [],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-1");
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("segment-2");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("segment-3");
    expect(progress).toMatchObject({
      state: "waitingForViewport",
      total: 3,
      translated: 2,
      failed: 0,
    });
  });

  it("recovers a missing lazy task with the original provider context", async () => {
    const originalProfile = providerProfile({
      id: "original-provider",
      textModel: "original-model",
    });
    const activeProfile = providerProfile({
      id: "active-provider",
      textModel: "active-model",
    });
    const generateText = vi.fn<
      (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
    >();
    const { orchestrator, sendToContent } = createOrchestrator({
      getActiveProfile: vi.fn(async () => activeProfile),
      getProviderProfile: vi.fn(async (providerId) =>
        providerId === originalProfile.id ? originalProfile : undefined,
      ),
      provider: { generateText },
    });

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-2", text: "Translated paragraph 2." }],
      }),
      model: "original-model",
    });

    await orchestrator.enqueueLazySegments("task-1", ["segment-2"], [], {
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      providerId: originalProfile.id,
      textModel: originalProfile.textModel,
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
      processedSegmentIds: ["segment-1"],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].profile).toMatchObject({
      id: "original-provider",
      textModel: "original-model",
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

  it("falls back to non-streaming translation when stream completes without valid items", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();

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
    streamText.mockReturnValue(streamChunks(["not json\n"]));
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-1", text: "你好，世界。" }],
      }),
      model: "gpt-4.1-mini",
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 1,
      failed: 0,
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

  it("backs off before retrying missing streamed items after a rate-limited partial stream", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();
    let resolveFirstApply: (() => void) | undefined;
    const firstApply = new Promise<void>((resolve) => {
      resolveFirstApply = resolve;
    });

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
      if (message.type === "applyTranslations" && message.items[0]?.segmentId === "segment-1") {
        resolveFirstApply?.();
      }
      return { type: "contentActionResult", success: true };
    });
    streamText
      .mockImplementationOnce(() =>
        (async function* () {
          yield { text: '{"id":"segment-1","text":"一。"}\n' };
          throw new ProviderError("rateLimited", "Provider rate limit exceeded.", 429);
        })(),
      )
      .mockImplementationOnce(() => streamChunks(['{"id":"segment-2","text":"二。"}\n']));

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    await firstApply;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    expect(streamText).toHaveBeenCalledTimes(1);

    await expect(running).resolves.toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(2);
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
      7,
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
