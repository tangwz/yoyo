import { describe, expect, it, vi } from "vitest";
import {
  TranslationTaskOrchestrator,
  type TranslationTaskOrchestratorDependencies,
} from "@/background/taskOrchestrator";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { ProviderError } from "@/provider/errors";
import type {
  ChromeBuiltInAiProviderProfile,
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";
import type { TranslateBatchRequest } from "@/provider/translationProvider";
import type { PageSegment } from "@/translation/types";

function providerProfile(
  overrides: Partial<OpenAiCompatibleProviderProfile> = {},
): OpenAiCompatibleProviderProfile {
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

function chromeBuiltInProfile(): ChromeBuiltInAiProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
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
  const translateBatch = vi.fn<
    (request: TranslateBatchRequest) => Promise<{
      items: Array<{ segmentId: string; translatedText: string }>;
    }>
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
    getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    sendToContent,
    now,
    createTaskId,
    ...overrides,
  });

  return {
    orchestrator,
    translateBatch,
    getActiveProfile,
    getProviderProfile,
    sendToContent,
    now,
    createTaskId,
  };
}

async function* streamBatchResponses(
  responses: ReadonlyArray<{ items: Array<{ segmentId: string; translatedText: string }> }>,
): AsyncGenerator<{ items: Array<{ segmentId: string; translatedText: string }> }> {
  for (const response of responses) {
    await Promise.resolve();
    yield response;
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [
          { segmentId: "segment-1", translatedText: "你好，世界。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
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
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0]).toMatchObject({
      profile: expect.objectContaining({ id: "profile-1" }),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceText: "Hello world." })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("cancels a task as superseded", async () => {
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator();
    let resolveProvider: ((value: { items: Array<{ segmentId: string; translatedText: string }> }) => void) | undefined;

    sendToContent.mockResolvedValue({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [segment()],
    });
    translateBatch.mockImplementation(
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
      expect(translateBatch).toHaveBeenCalledTimes(1);
    });

    const progress = orchestrator.cancelTask("task-1", "superseded");

    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "cancelled",
    });
    expect(translateBatch.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);

    resolveProvider?.({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    });
    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "cancelled",
    });
  });

  it("does not collect page content when no active provider profile exists", async () => {
    const missingProvider = vi.fn(async () => undefined);
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator({
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
    expect(translateBatch).not.toHaveBeenCalled();
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 0,
      translated: 0,
      failed: 0,
    });
  });

  it("fails before collecting content when Chrome Built-in AI receives auto source language", async () => {
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator({
      getActiveProfile: vi.fn(async () => chromeBuiltInProfile()),
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });

    expect(sendToContent).not.toHaveBeenCalled();
    expect(translateBatch).not.toHaveBeenCalled();
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 0,
      translated: 0,
      failed: 0,
    });
  });

  it("uses the resolved translation provider for Chrome Built-in AI profiles", async () => {
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{
        items: Array<{ segmentId: string; translatedText: string }>;
      }>
    >(async () => ({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    }));
    const getTranslationProvider = vi.fn((profile: ProviderProfile) => ({
      translateText: vi.fn(),
      translateBatch,
    }));
    const { orchestrator, sendToContent } = createOrchestrator({
      getActiveProfile: async () => chromeBuiltInProfile(),
      getTranslationProvider,
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

    await expect(
      orchestrator.translatePage({
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(getTranslationProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chrome-built-in-ai" }),
    );
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].profile.type).toBe("chrome-built-in-ai");
  });

  it("completes with errors when provider output omits an expected segment", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch
      .mockResolvedValueOnce({
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
      })
      .mockResolvedValueOnce({
        items: [{ segmentId: "segment-2", translatedText: "早上好。" }],
      });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(translateBatch.mock.calls[1]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-2" })]),
    );
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("translates page content in priority ordered batches and applies each batch", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
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
    translateBatch.mockImplementation(async (request) => {
      const segmentIds = collectedSegments
        .filter((candidate) => request.segments.some((segment) => segment.id === candidate.id))
        .map((candidate) => candidate.id);

      events.push(`request:${segmentIds.join(",")}`);
      return {
        items: segmentIds.map((segmentId) => ({
            segmentId,
            translatedText: `Translated ${segmentId}`,
          })),
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

    sendToContent.mockResolvedValue({
      type: "collectSegmentsResult",
      taskId: "task-1",
      segments: [segment()],
    });
    translateBatch.mockRejectedValue(new Error("provider unavailable"));

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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-old", translatedText: "重复文本。" }],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-2",
      items: [{ segmentId: "segment-new", translatedText: "重复文本。" }],
    });
  });

  it("deduplicates repeated normalized text within one translation task", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "重复文本。" }],
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-1" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-2" })]),
    );
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockImplementation(async (request) => {
      const ids = ["segment-1", "segment-2", "segment-3"].filter((id) =>
        request.segments.some((segment) => segment.id === id),
      );
      return {
        items: ids.map((id) => ({ segmentId: id, translatedText: `Translated ${id}` })),
      };
    });

    const initialProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-1" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-2" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-3" })]),
    );
    expect(initialProgress).toMatchObject({
      state: "waitingForViewport",
      total: 3,
      translated: 2,
    });

    const afterScroll = await orchestrator.enqueueLazySegments("task-1", ["segment-3", "segment-3"]);

    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(translateBatch.mock.calls[1]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-3" })]),
    );
    expect(afterScroll).toMatchObject({
      state: "completed",
      translated: 3,
      failed: 0,
    });
  });

  it("requests current viewport segments before nearby segments from earlier DOM order", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
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
    translateBatch.mockImplementation(async (request) => {
      const ids = request.segments.map((segment) => segment.id);
      requestedIds.push(ids);
      return {
        items: ids.map((id) => ({ segmentId: id, translatedText: `Translated ${id}` })),
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockImplementation(async (request) => {
      const ids = request.segments.map((segment) => segment.id);
      return {
        items: ids.map((id) => ({ segmentId: id, translatedText: `Translated ${id}` })),
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

    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(translateBatch.mock.calls[1]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "normal" })]),
    );
    expect(progress).toMatchObject({
      state: "completed",
      total: 2,
      translated: 2,
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

  it("rejects stale lazy recovery when the same tab already has an active task", async () => {
    let nextNow = 1000;
    const createTaskId = vi.fn(() => "new-task");
    const sendToContent = vi.fn<
      (tabId: number, message: ContentRequest) => Promise<ContentResponse>
    >();
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      now: vi.fn(() => {
        nextNow += 1;
        return nextNow;
      }),
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
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
    expect(translateBatch).not.toHaveBeenCalled();
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
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      getProviderProfile,
      now: vi.fn(() => {
        nextNow += 1;
        return nextNow;
      }),
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
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
    expect(translateBatch).not.toHaveBeenCalled();
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
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator } = createOrchestrator({
      createTaskId,
      getProviderProfile,
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
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
    translateBatch.mockImplementation(async (request) => {
      return {
        items: request.segments.map((item) => ({
          segmentId: item.id,
          translatedText: `Translated ${item.id}`,
        })),
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
    expect(translateBatch).toHaveBeenCalledTimes(1);
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockImplementation(async (request) => {
      return {
        items: request.segments.map((item) => ({
          segmentId: item.id,
          translatedText: `Translated ${item.id}`,
        })),
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-10", translatedText: "Translated paragraph 10." }],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-10" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-1" })]),
    );
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 12,
      translated: 3,
      failed: 1,
    });
  });

  it("retries unprocessed visible segments when recovering from a lazy snapshot", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [
          { segmentId: "segment-1", translatedText: "Translated visible." },
          { segmentId: "segment-2", translatedText: "Translated near." },
        ],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-1" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-2" })]),
    );
    expect(translateBatch.mock.calls[0]?.[0].segments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "segment-3" })]),
    );
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
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator, sendToContent } = createOrchestrator({
      getActiveProfile: vi.fn(async () => activeProfile),
      getProviderProfile: vi.fn(async (providerId) =>
        providerId === originalProfile.id ? originalProfile : undefined,
      ),
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    });

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-2", translatedText: "Translated paragraph 2." }],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].profile).toMatchObject({
      id: "original-provider",
      textModel: "original-model",
    });
  });

  it("counts disconnected lazy segments as processed failures", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "Translated visible." }],
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

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(afterDisconnect).toMatchObject({
      state: "completedWithErrors",
      total: 2,
      translated: 1,
      failed: 1,
    });
  });

  it("does not complete a lazy task while earlier segments are still in flight", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
    let resolveInitialBatch:
      | ((value: { items: Array<{ segmentId: string; translatedText: string }> }) => void)
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
    translateBatch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialBatch = resolve;
          }),
      )
      .mockResolvedValueOnce({
        items: [{ segmentId: "segment-2", translatedText: "Translated later." }],
      });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    await vi.waitFor(() => {
      expect(translateBatch).toHaveBeenCalledTimes(1);
    });

    const afterEnqueue = await orchestrator.enqueueLazySegments("task-1", ["segment-2"]);

    expect(afterEnqueue).toMatchObject({
      state: "translating",
      total: 2,
      translated: 1,
      failed: 0,
    });

    resolveInitialBatch?.({
      items: [{ segmentId: "segment-1", translatedText: "Translated visible." }],
    });

    await expect(running).resolves.toMatchObject({
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("does not cancel a completed task when a same-tab task starts later", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockResolvedValue({
      items: [
          { segmentId: "segment-1", translatedText: "你好，世界。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
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
    expect(translateBatch).toHaveBeenCalledTimes(2);
  });

  it("does not cache translations that fail to apply to the page", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
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
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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

    expect(translateBatch).toHaveBeenCalledTimes(2);
  });

  it("does not apply translations after cancellation lands before page apply", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockImplementation(async () => {
      orchestrator.cancelTask("task-1", "userCancelled");
      return {
        items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
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
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
      emitProgress,
    });

    let resolveProvider: ((value: { items: Array<{ segmentId: string; translatedText: string }> }) => void) | undefined;
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
    translateBatch.mockImplementation(
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
      expect(translateBatch).toHaveBeenCalledTimes(1);
    });

    resolveProvider?.({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    });

    await vi.waitFor(() => {
      expect(orchestrator.getTask("task-1")).toMatchObject({ state: "completed" });
    });
    expect(emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", state: "completed" }),
      7,
    );
  });

  it("releases provider slots when translation provider resolution fails", async () => {
    const getTranslationProvider = vi.fn(() => {
      throw new Error("resolver failed");
    });
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider,
    });

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

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(getTranslationProvider).toHaveBeenCalled();
    expect(progress).toEqual({
      taskId: "task-1",
      state: "completedWithErrors",
      total: 3,
      translated: 0,
      failed: 3,
    });
  });

  it("applies streamed translation items progressively through translation providers", async () => {
    const translateBatch = vi.fn();
    const streamBatch = vi.fn(() =>
      streamBatchResponses([
        { items: [{ segmentId: "segment-1", translatedText: "一。" }] },
        { items: [{ segmentId: "segment-2", translatedText: "二。" }] },
      ]),
    );
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({
        translateText: vi.fn(),
        translateBatch,
        streamBatch,
      }),
    });
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

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch).not.toHaveBeenCalled();
    expect(applyEvents).toEqual(["segment-1", "segment-2"]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("splits a repeatedly failing batch and falls back to single segments", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

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
    translateBatch.mockImplementation(async (request) => {
      const containsSingleSegment =
        request.segments.some((segment) => segment.id === "segment-1") &&
        !request.segments.some((segment) => segment.id === "segment-2") &&
        !request.segments.some((segment) => segment.id === "segment-3");

      if (containsSingleSegment) {
        return {
          items: [{ segmentId: "segment-1", translatedText: "一。" }],
      };
      }

      throw new Error("batch failed");
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(translateBatch).toHaveBeenCalledTimes(9);
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
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
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
    translateBatch
      .mockRejectedValueOnce(new ProviderError("rateLimited", "Provider rate limit exceeded.", 429))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecondRequest = () =>
              resolve({
                items: Array.from({ length: 10 }, (_value, index) => ({
                  segmentId: `segment-${index + 11}`,
                  translatedText: `Translated ${index + 11}`,
                })),
              });
          }),
      )
      .mockImplementation(async (request) => {
        const ids = Array.from({ length: 21 }, (_value, index) => `segment-${index + 1}`)
          .filter((id) => request.segments.some((segment) => segment.id === id));
        return {
          items: ids.map((id) => ({ segmentId: id, translatedText: `Translated ${id}` })),
        };
      });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
    });

    await vi.waitFor(() => {
      expect(translateBatch).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(translateBatch).toHaveBeenCalledTimes(2);

    releaseSecondRequest?.();
    await vi.runAllTimersAsync();

    await expect(running).resolves.toMatchObject({
      state: "completed",
      translated: 21,
      failed: 0,
    });
  });
});
