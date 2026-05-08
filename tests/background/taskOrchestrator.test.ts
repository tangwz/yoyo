import { describe, expect, it, vi } from "vitest";
import {
  TranslationTaskOrchestrator,
  type TranslationTaskOrchestratorDependencies,
} from "@/background/taskOrchestrator";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import type { GenerateTextRequest, ProviderProfile } from "@/provider/types";
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
    ...overrides,
  };
}

function createOrchestrator(
  overrides: Partial<TranslationTaskOrchestratorDependencies> = {},
) {
  const generateText = vi.fn<
    (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
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
    provider: { generateText },
    sendToContent,
    now,
    createTaskId,
    ...overrides,
  });

  return {
    orchestrator,
    generateText,
    getActiveProfile,
    sendToContent,
    now,
    createTaskId,
  };
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

  it("fails when no active provider profile exists", async () => {
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
    expect(generateText).not.toHaveBeenCalled();
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 1,
      translated: 0,
      failed: 1,
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
});
