import { describe, expect, it, vi } from "vitest";
import {
  TranslationTaskOrchestrator,
  type TranslationTaskOrchestratorDependencies,
} from "@/background/taskOrchestrator";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { ProviderError } from "@/provider/errors";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import type {
  ChromeBuiltInAiProviderProfile,
  GenerateTextRequest,
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
  StreamTextRequest,
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
    textModel: "gpt-5-mini",
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

type LegacyTextProviderOverride = {
  generateText: (request: GenerateTextRequest) => Promise<{ text: string; model: string }>;
  streamText?: (request: StreamTextRequest) => AsyncGenerator<{ text: string }>;
};

type TestOrchestratorOverrides = Partial<TranslationTaskOrchestratorDependencies> & {
  provider?: LegacyTextProviderOverride;
};

function createOrchestrator(overrides: TestOrchestratorOverrides = {}) {
  const { provider: legacyProvider, ...dependencyOverrides } = overrides;
  const generateText = vi.fn<
    (request: GenerateTextRequest) => Promise<{ text: string; model: string }>
  >();
  const streamText = vi.fn<
    (request: StreamTextRequest) => AsyncGenerator<{ text: string }>
  >();
  const translateBatch = vi.fn<
    (request: TranslateBatchRequest) => Promise<{
      items: Array<{ segmentId: string; translatedText: string }>;
    }>
  >(async (request) => {
    const adapter = new OpenAiTranslationAdapter({
      generateText: legacyProvider?.generateText ?? generateText,
      streamText: legacyProvider?.streamText ?? streamText,
    });
    return adapter.translateBatch(request);
  });
  const streamBatch = vi.fn(async function* (request: TranslateBatchRequest) {
    const textStreamer = legacyProvider?.streamText ?? streamText;
    if (!legacyProvider?.streamText && !streamText.getMockImplementation()) {
      return;
    }

    const adapter = new OpenAiTranslationAdapter({
      generateText: legacyProvider?.generateText ?? generateText,
      streamText: textStreamer,
    });
    yield* adapter.streamBatch(request);
  });
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
    getTranslationProvider: () => ({
      translateText: vi.fn(),
      translateBatch,
      streamBatch,
    }),
    sendToContent,
    now,
    createTaskId,
    ...dependencyOverrides,
  });

  return {
    orchestrator,
    generateText,
    streamText,
    translateBatch,
    streamBatch,
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

async function* streamBatchResponses(
  responses: ReadonlyArray<{ items: Array<{ segmentId: string; translatedText: string }> }>,
): AsyncGenerator<{ items: Array<{ segmentId: string; translatedText: string }> }> {
  for (const response of responses) {
    await Promise.resolve();
    yield response;
  }
}

function renderedConsoleOutput(calls: unknown[][]): string {
  return calls
    .map((call) =>
      call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    )
    .join("\n");
}

function perfTraceMetadata(
  calls: unknown[][],
  eventName: string,
): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call[0] === `[yoyo:perf] ${eventName}`)
    .map((call) => call[1])
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
}

describe("TranslationTaskOrchestrator", () => {
  it("traces page translation batches without logging segment text", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const collectedSegment = segment({
      id: "segment-1",
      sourceText: "Private source text.",
    });
    const translatedText = "Private translated text.";
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: [collectedSegment],
          };
        }

        if (message.type === "applyTranslations") {
          return {
            type: "contentActionResult",
            success: true,
            appliedSegmentIds: message.items.map((item) => item.segmentId),
          };
        }

        throw new Error(`Unexpected content message: ${message.type}`);
      });
      translateBatch.mockResolvedValue({
        items: [{ segmentId: "segment-1", translatedText }],
      });

      await orchestrator.translatePage({
        tabId: 7,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "fullPage",
      });

      expect(translateBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          traceContext: expect.objectContaining({
            taskId: "task-1",
            batchId: expect.stringMatching(/^batch-/),
            stage: "page",
            providerType: "openai-compatible",
            segmentCount: 1,
            sourceCharCount: collectedSegment.sourceText.length,
          }),
        }),
      );

      const output = renderedConsoleOutput(infoSpy.mock.calls);
      const batchStart = perfTraceMetadata(infoSpy.mock.calls, "translation.batch.start");
      const batchApplyDone = perfTraceMetadata(
        infoSpy.mock.calls,
        "translation.batch.apply.done",
      );
      const providerBatchId = translateBatch.mock.calls[0]?.[0].traceContext?.batchId;

      expect(output).toContain("translation.task.start");
      expect(output).toContain("translation.collect.done");
      expect(infoSpy).toHaveBeenCalledWith(
        "[yoyo:perf] translation.detectLanguage.done",
        expect.objectContaining({
          taskId: "task-1",
          providerType: "openai-compatible",
          sourceLanguage: "en",
          success: true,
        }),
      );
      expect(output).toContain("translation.batch.start");
      expect(output).toContain("translation.batch.done");
      expect(output).toContain("translation.batch.apply.done");
      expect(batchStart).toContainEqual(
        expect.objectContaining({
          batchId: providerBatchId,
        }),
      );
      expect(batchApplyDone).toEqual([
        expect.objectContaining({
          taskId: "task-1",
          batchId: providerBatchId,
          itemCount: 1,
          appliedCount: 1,
          failedCount: 0,
          success: true,
        }),
      ]);
      expect(output).not.toContain(collectedSegment.sourceText);
      expect(output).not.toContain(translatedText);
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

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
      deferLazyCollection: false,
      targetLanguage: "zh-CN",
      providerId: "profile-1",
      textModel: "gpt-5-mini",
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

  it("uses single-segment batches for Xiaomi MiMo to improve per-line latency", async () => {
    const collectedSegments = [
      segment({ id: "segment-1", sourceText: "Hello world." }),
      segment({
        id: "segment-2",
        order: 2,
        sourceText: "Good morning.",
        textHash: "hash-2",
      }),
    ];
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator({
      getActiveProfile: vi.fn(async () =>
        providerProfile({
          id: "xiaomi-mimo",
          presetId: "xiaomi-mimo",
          baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
          textModel: "mimo-v2.5",
        }),
      ),
    });

    sendToContent.mockImplementation(async (tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: collectedSegments,
        };
      }

      if (message.type === "applyTranslations") {
        return { type: "contentActionResult", success: true };
      }

      throw new Error(`Unexpected content message: ${message.type}`);
    });

    translateBatch.mockImplementation(async (request) => ({
      items: request.segments.map((segment) => ({
        segmentId: segment.id,
        translatedText: `translated-${segment.id}`,
      })),
    }));

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
    });

    expect(translateBatch).toHaveBeenCalledTimes(2);
    const requestSegments = translateBatch.mock.calls.map((call) =>
      call[0].segments.map((segment) => segment.id),
    );
    expect(requestSegments).toEqual([["segment-1"], ["segment-2"]]);
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

  it("does not trace buffered provider aborts as failed batches after cancellation", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator();
    let rejectProvider: ((error: Error) => void) | undefined;

    try {
      sendToContent.mockResolvedValue({
        type: "collectSegmentsResult",
        taskId: "task-1",
        segments: [segment({ sourceText: "Private cancelled source." })],
      });
      translateBatch.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectProvider = reject;
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

      orchestrator.cancelTask("task-1", "userCancelled");
      rejectProvider?.(new Error("Provider request aborted."));

      await expect(running).resolves.toMatchObject({
        taskId: "task-1",
        state: "cancelled",
      });
      expect(perfTraceMetadata(infoSpy.mock.calls, "translation.batch.done")).toContainEqual(
        expect.objectContaining({
          success: false,
          reason: "aborted",
        }),
      );
      expect(
        perfTraceMetadata(infoSpy.mock.calls, "translation.batch.done"),
      ).not.toContainEqual(expect.objectContaining({ errorName: "Error" }));
      expect(renderedConsoleOutput(infoSpy.mock.calls)).not.toContain(
        "Private cancelled source.",
      );
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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

  it("detects source language before translating with Chrome Built-in AI when source is auto", async () => {
    const detectSourceLanguage = vi.fn(async () => "en");
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator({
      getActiveProfile: vi.fn(async () => chromeBuiltInProfile()),
      detectSourceLanguage,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        expect(message.deferLazyCollection).toBe(true);
        return {
          type: "collectSegmentsResult",
          taskId: "task-1",
          segments: [segment({ id: "segment-1", sourceText: "Hello world." })],
        };
      }

      if (message.type === "applyTranslations") {
        return {
          type: "contentActionResult",
          success: true,
          appliedSegmentIds: message.items.map((item) => item.segmentId),
        };
      }

      if (message.type === "finalizeLazyRecoverySourceLanguage") {
        return {
          type: "contentActionResult",
          success: true,
        };
      }

      throw new Error(`Unexpected content message: ${message.type}`);
    });
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });

    expect(detectSourceLanguage).toHaveBeenCalledWith(
      "Hello world.",
      expect.any(AbortSignal),
    );
    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
      }),
    );
    expect(sendToContent).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: "collectSegments",
        sourceLanguage: "auto",
        deferLazyCollection: true,
      }),
    );
    expect(sendToContent).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: "finalizeLazyRecoverySourceLanguage",
        sourceLanguage: "en",
      }),
    );
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });

  it("defers Chrome Built-in AI auto language detection until lazy segments are available", async () => {
    const detectSourceLanguage = vi.fn(async () => "en");
    const { orchestrator, sendToContent, translateBatch } = createOrchestrator({
      getActiveProfile: vi.fn(async () => chromeBuiltInProfile()),
      detectSourceLanguage,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: "task-1",
          segments: [],
          collectionComplete: false,
        };
      }

      if (message.type === "finalizeLazyRecoverySourceLanguage") {
        return {
          type: "contentActionResult",
          success: true,
        };
      }

      if (message.type === "applyTranslations") {
        return {
          type: "contentActionResult",
          success: true,
          appliedSegmentIds: message.items.map((item) => item.segmentId),
        };
      }

      throw new Error(`Unexpected content message: ${message.type}`);
    });
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-2", translatedText: "后续段落。" }],
    });

    const initialProgress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    expect(detectSourceLanguage).not.toHaveBeenCalled();
    expect(translateBatch).not.toHaveBeenCalled();
    expect(
      sendToContent.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.type === "finalizeLazyRecoverySourceLanguage"),
    ).toEqual([
      expect.objectContaining({
        sourceLanguage: "auto",
      }),
    ]);
    expect(initialProgress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 0,
    });

    const progress = await orchestrator.enqueueLazySegments("task-1", ["segment-2"], [], {
      tabId: 7,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: true,
      segments: [
        segment({
          id: "segment-2",
          order: 2,
          sourceText: "Later paragraph.",
          textHash: "hash-2",
          priority: "viewport",
        }),
      ],
      processedSegmentIds: [],
    });

    expect(detectSourceLanguage).toHaveBeenCalledWith(
      "Later paragraph.",
      expect.any(AbortSignal),
    );
    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
      }),
    );
    expect(
      sendToContent.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.type === "finalizeLazyRecoverySourceLanguage"),
    ).toEqual([
      expect.objectContaining({
        sourceLanguage: "auto",
      }),
      expect.objectContaining({
        sourceLanguage: "en",
      }),
    ]);
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
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
    const activeProfile = chromeBuiltInProfile();
    const getTranslationProvider = vi.fn((profile: ProviderProfile) => {
      expect(profile).toBe(activeProfile);

      return {
      translateText: vi.fn(),
      translateBatch,
      };
    });
    const { orchestrator, sendToContent } = createOrchestrator({
      getActiveProfile: async () => activeProfile,
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
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
    const firstSourceText = "Private missing source one.";
    const secondSourceText = "Private missing source two.";
    const firstTranslatedText = "Private translated one.";
    const secondTranslatedText = "Private translated two.";

    try {
      sendToContent.mockResolvedValueOnce({
        type: "collectSegmentsResult",
        taskId: "task-1",
        segments: [
          segment({ id: "segment-1", sourceText: firstSourceText }),
          segment({
            id: "segment-2",
            order: 2,
            sourceText: secondSourceText,
            textHash: "hash-2",
          }),
        ],
      });
      sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
      translateBatch
        .mockResolvedValueOnce({
          items: [{ segmentId: "segment-1", translatedText: firstTranslatedText }],
        })
        .mockResolvedValueOnce({
          items: [{ segmentId: "segment-2", translatedText: secondTranslatedText }],
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
      expect(infoSpy).toHaveBeenCalledWith(
        "[yoyo:perf] translation.batch.missing",
        expect.objectContaining({
          taskId: "task-1",
          batchId: expect.stringMatching(/^batch-/),
          attempt: 1,
          providerType: "openai-compatible",
          segmentCount: 2,
          missingCount: 1,
        }),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[yoyo:perf] translation.batch.retry",
        expect.objectContaining({
          taskId: "task-1",
          batchId: expect.stringMatching(/^batch-/),
          attempt: 1,
          providerType: "openai-compatible",
          reason: "retry",
          segmentCount: 1,
        }),
      );
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain(firstSourceText);
      expect(output).not.toContain(secondSourceText);
      expect(output).not.toContain(firstTranslatedText);
      expect(output).not.toContain(secondTranslatedText);
      expect(progress).toEqual({
        taskId: "task-1",
        state: "completed",
        total: 2,
        translated: 2,
        failed: 0,
      });
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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

  it("does not fan out cached translations across preserved whitespace segments", async () => {
    const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
    const formatted = segment({
      id: "formatted",
      order: 1,
      sourceText: "foo\nbar",
      textHash: "hash-formatted",
      preserveWhitespace: true,
    });
    const flattened = segment({
      id: "flattened",
      order: 2,
      sourceText: "foo bar",
      textHash: "hash-flattened",
      preserveWhitespace: true,
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [formatted, flattened],
        };
      }
      return { type: "contentActionResult", success: true };
    });
    translateBatch.mockResolvedValue({
      items: [
        { segmentId: "formatted", translatedText: "formatted translation" },
        { segmentId: "flattened", translatedText: "flattened translation" },
      ],
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        segments: [
          expect.objectContaining({ id: "formatted" }),
          expect.objectContaining({ id: "flattened" }),
        ],
      }),
    );
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [
        { segmentId: "formatted", translatedText: "formatted translation" },
        { segmentId: "flattened", translatedText: "flattened translation" },
      ],
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

  it("translates repeated source text once and fans out cached results without leaking private text", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const privateSource = "Private repeated source.";
    const privateTranslation = "Private repeated translation.";
    const translateBatch = vi.fn(async () => ({
      items: [{ segmentId: "segment-1", translatedText: privateTranslation }],
    }));
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    });
    const applied: Array<{ segmentId: string; translatedText: string }> = [];

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: [
              segment({ id: "segment-1", sourceText: privateSource, textHash: "same-hash" }),
              segment({
                id: "segment-2",
                order: 2,
                sourceText: privateSource,
                textHash: "same-hash",
              }),
            ],
          };
        }

        if (message.type !== "applyTranslations") {
          throw new Error(`Unexpected content message: ${message.type}`);
        }

        applied.push(...message.items);
        return { type: "contentActionResult", success: true };
      });

      await expect(
        orchestrator.translatePage({
          tabId: 7,
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        }),
      ).resolves.toMatchObject({
        state: "completed",
        translated: 2,
        failed: 0,
      });

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(translateBatch.mock.calls[0]?.[0].segments.map((item) => item.id)).toEqual([
        "segment-1",
      ]);
      expect(applied).toEqual([
        { segmentId: "segment-1", translatedText: privateTranslation },
        { segmentId: "segment-2", translatedText: privateTranslation },
      ]);
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain(privateSource);
      expect(output).not.toContain(privateTranslation);
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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
      model: "gpt-5-mini",
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

  it("does not reprocess a runtime segment already translated through streaming", async () => {
    const { orchestrator, streamText, sendToContent } = createOrchestrator();

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
    streamText.mockReturnValue(streamChunks(['{"id":"dynamic-1","text":"一。"}\n']));

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    const input = {
      taskId: "task-1",
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport" as const,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "One.",
          priority: "viewport",
        }),
      ],
    };

    await orchestrator.enqueueTranslationBatch(input);
    await orchestrator.enqueueTranslationBatch(input);

    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it("does not reprocess a runtime segment while it is already in flight", async () => {
    const { orchestrator, streamText, sendToContent } = createOrchestrator();
    let releaseStream: (() => void) | undefined;

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
    streamText.mockImplementation(
      () =>
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseStream = resolve;
          });
          yield { text: '{"id":"dynamic-1","text":"一。"}\n' };
        })(),
    );

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    const input = {
      taskId: "task-1",
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport" as const,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "One.",
          priority: "viewport",
        }),
      ],
    };

    const firstBatch = orchestrator.enqueueTranslationBatch(input);
    await vi.waitFor(() => {
      expect(streamText).toHaveBeenCalledTimes(1);
    });
    const secondBatch = orchestrator.enqueueTranslationBatch(input);
    await Promise.resolve();

    expect(streamText).toHaveBeenCalledTimes(1);
    releaseStream?.();
    await expect(Promise.all([firstBatch, secondBatch])).resolves.toEqual([
      expect.objectContaining({
        translated: 1,
      }),
      expect.objectContaining({
        translated: 1,
      }),
    ]);
    expect(streamText).toHaveBeenCalledTimes(1);
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
        model: "gpt-5-mini",
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

  it("waits for the final runtime full-page batch before completing", async () => {
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
        model: "gpt-5-mini",
      };
    });

    const firstProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
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

    expect(firstProgress).toEqual({
      taskId: "runtime-task",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });

    const finalProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "runtime-task",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "fullPage",
      collectionComplete: true,
      segments: [
        segment({
          id: "runtime-2",
          order: 2,
          sourceText: "Second runtime text.",
          textHash: "hash-runtime-2",
          priority: "normal",
        }),
      ],
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(finalProgress).toEqual({
      taskId: "runtime-task",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
    });
  });

  it("queues a runtime lazy batch without loading profile while translatePage context is pending", async () => {
    const getActiveProfile = vi.fn(
      () => new Promise<ProviderProfile | undefined>(() => {}),
    );
    const { orchestrator, generateText, sendToContent } = createOrchestrator({
      getActiveProfile,
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

    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    expect(sendToContent).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(progress).toEqual({
      taskId: "task-1",
      state: "collecting",
      total: 1,
      translated: 0,
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
      total: 1,
      translated: 0,
      failed: 1,
      errorMessage: "No active provider profile.",
    });
    expect(orchestrator.getTask("missing-task")).toBeUndefined();
    expect(orchestrator.getTaskForTab(7)).toBeUndefined();
  });

  it("keeps concurrent first runtime batches consistent when no active profile exists", async () => {
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
      expect(getActiveProfile).toHaveBeenCalledTimes(1);
    });
    resolveProfile?.(undefined);

    await expect(Promise.all([firstBatch, secondBatch])).resolves.toEqual([
      {
        taskId: "runtime-task",
        state: "failed",
        total: 2,
        translated: 0,
        failed: 2,
        errorMessage: "No active provider profile.",
      },
      {
        taskId: "runtime-task",
        state: "failed",
        total: 2,
        translated: 0,
        failed: 2,
        errorMessage: "No active provider profile.",
      },
    ]);
    expect(generateText).not.toHaveBeenCalled();
    expect(sendToContent).not.toHaveBeenCalled();
    expect(orchestrator.getTask("runtime-task")).toBeUndefined();
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
        model: "gpt-5-mini",
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
      expect(getActiveProfile).toHaveBeenCalledTimes(1);
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
    let resolveFirstProvider:
      | ((response: { text: string; model: string }) => void)
      | undefined;
    const firstProfilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveFirstProfile = resolve;
    });
    const getActiveProfile = vi.fn().mockReturnValueOnce(firstProfilePromise);
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
          model: "gpt-5-mini",
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
      expect(getActiveProfile).toHaveBeenCalledTimes(1);
    });
    resolveFirstProfile?.(providerProfile());
    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(orchestrator.getTask("runtime-task")).toMatchObject({
        state: "translating",
        total: 2,
        translated: 1,
      });
    });
    resolveFirstProvider?.({
      text: JSON.stringify({
        items: [{ id: "runtime-1", text: "Translated runtime-1" }],
      }),
      model: "gpt-5-mini",
    });
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

  it("locks standalone runtime context to the first batch before profile lookup resolves", async () => {
    let resolveFirstProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    const firstProfilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveFirstProfile = resolve;
    });
    const getActiveProfile = vi.fn()
      .mockReturnValueOnce(firstProfilePromise)
      .mockResolvedValueOnce(providerProfile({ id: "later-profile" }));
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
        model: request.profile.textModel,
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
      sourceLanguage: "ja",
      targetLanguage: "fr",
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
      expect(getActiveProfile).toHaveBeenCalled();
    });
    await Promise.resolve();
    resolveFirstProfile?.(providerProfile({ id: "first-profile" }));

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
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("Target language: fr");
    expect(generateText.mock.calls[1]?.[0].prompt).toContain("Target language: zh-CN");
    expect(generateText.mock.calls[1]?.[0].prompt).not.toContain("Target language: fr");
    expect(orchestrator.getTask("runtime-task")).toEqual({
      taskId: "runtime-task",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
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
      model: "gpt-5-mini",
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
        model: "gpt-5-mini",
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

  it("resumes a completed lazy task for dynamic runtime batches", async () => {
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
        model: "gpt-5-mini",
      };
    });

    const completedProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: true,
      segments: [
        segment({
          id: "runtime-1",
          sourceText: "Initial runtime text.",
          textHash: "hash-runtime-1",
          priority: "viewport",
        }),
      ],
    });

    expect(completedProgress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
    generateText.mockClear();
    sendToContent.mockClear();

    const resumedProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "runtime-2",
          order: 2,
          sourceText: "Inserted runtime text.",
          textHash: "hash-runtime-2",
          priority: "viewport",
        }),
      ],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: "applyTranslations",
        taskId: "task-1",
        items: [{ segmentId: "runtime-2", translatedText: "Translated runtime-2" }],
      }),
    );
    expect(resumedProgress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 2,
      translated: 2,
      failed: 0,
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
        model: "gpt-5-mini",
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
        model: "gpt-5-mini",
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
        model: "gpt-5-mini",
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

  it("preserves runtime collection completion while translatePage profile lookup is pending", async () => {
    let resolveProfile:
      | ((profile: ProviderProfile | undefined) => void)
      | undefined;
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const profilePromise = new Promise<ProviderProfile | undefined>((resolve) => {
      resolveProfile = resolve;
    });
    const getActiveProfile = vi.fn()
      .mockReturnValueOnce(profilePromise)
      .mockResolvedValueOnce(undefined);
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
        model: "gpt-5-mini",
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
    await expect(runtimeBatch).resolves.toMatchObject({
      taskId: "task-1",
      state: "collecting",
      total: 1,
      translated: 0,
      failed: 0,
    });

    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(generateText).not.toHaveBeenCalled();

    resolveProfile?.(providerProfile());
    await vi.waitFor(() => {
      expect(resolveCollect).toBeDefined();
    });
    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: false,
      segments: [],
    });
    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("Target language: fr");
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
      model: "gpt-5-mini",
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
        model: "gpt-5-mini",
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

  it("honors runtime collection completion after translatePage binds context", async () => {
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

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
        model: "gpt-5-mini",
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

    expect(runtimeProgress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });

    resolveCollect?.({
      type: "collectSegmentsResult",
      taskId: "task-1",
      collectionComplete: true,
      segments: [],
    });
    await expect(running).resolves.toEqual(runtimeProgress);
  });

  it("keeps completed progress when collection rejects after runtime completion", async () => {
    let rejectCollect:
      | ((error: Error) => void)
      | undefined;
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((_resolve, reject) => {
          rejectCollect = reject;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "runtime-1", text: "Translated runtime." }],
      }),
      model: "gpt-5-mini",
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });
    await vi.waitFor(() => {
      expect(rejectCollect).toBeDefined();
    });

    const runtimeProgress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
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
    expect(runtimeProgress).toEqual({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });

    rejectCollect?.(new Error("Collect failed late."));

    await expect(running).resolves.toEqual(runtimeProgress);
    expect(orchestrator.getTask("task-1")).toEqual(runtimeProgress);
  });

  it("keeps failed progress consistent when collection fails after runtime translation", async () => {
    let resolveCollect:
      | ((response: ContentResponse) => void)
      | undefined;
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return new Promise<ContentResponse>((resolve) => {
          resolveCollect = resolve;
        });
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "runtime-1", text: "Translated runtime." }],
      }),
      model: "gpt-5-mini",
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
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });

    resolveCollect?.({
      type: "contentActionResult",
      success: true,
    });

    await expect(running).resolves.toMatchObject({
      taskId: "task-1",
      state: "failed",
      total: 1,
      translated: 1,
      failed: 0,
      errorMessage: "Content script did not return page segments.",
    });
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "failed",
      total: 1,
      translated: 1,
      failed: 0,
    });
    const finalProgress = orchestrator.getTask("task-1");
    expect((finalProgress?.translated ?? 0) + (finalProgress?.failed ?? 0)).toBeLessThanOrEqual(
      finalProgress?.total ?? 0,
    );
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

  it("recovers a missing lazy task from a runtime batch recovery snapshot", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();
    const segments = [
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
        sourceText: "Later.",
        textHash: "hash-3",
        priority: "normal",
      }),
    ];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      expect(message.items).toEqual([
        { segmentId: "segment-3", translatedText: "Translated later." },
      ]);
      return { type: "contentActionResult", success: true };
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({
        items: [{ id: "segment-3", text: "Translated later." }],
      }),
      model: "gpt-5-mini",
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [segments[2]!],
      recovery: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        collectionComplete: true,
        segments,
        processedSegmentIds: ["segment-1", "segment-2"],
      },
    });

    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 3,
      translated: 3,
      failed: 0,
    });
  });

  it("does not double count in-flight lazy segments from runtime recovery", async () => {
    const { orchestrator, generateText, streamText, sendToContent } = createOrchestrator();
    let releaseStream:
      | (() => void)
      | undefined;

    sendToContent.mockResolvedValue({ type: "contentActionResult", success: true });
    streamText.mockImplementation(async function* streamVisibleSegment() {
      yield { text: '{"id":"segment-1","text":"Translated visible."}\n' };
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    });

    const firstBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [segment({ id: "segment-1", sourceText: "Visible.", priority: "viewport" })],
    });
    await vi.waitFor(() => {
      expect(orchestrator.getTask("task-1")).toMatchObject({
        state: "translating",
        total: 1,
        translated: 1,
      });
      expect(releaseStream).toBeDefined();
    });

    const recoveryBatch = orchestrator.enqueueTranslationBatch({
      tabId: 7,
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [],
      recovery: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        collectionComplete: true,
        segments: [segment({ id: "segment-1", sourceText: "Visible.", priority: "viewport" })],
        processedSegmentIds: ["segment-1"],
      },
    });

    await vi.waitFor(() => {
      expect(orchestrator.getTask("task-1")).toMatchObject({
        total: 1,
        translated: 1,
        failed: 0,
      });
    });

    releaseStream?.();
    await expect(firstBatch).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
    await expect(recoveryBatch).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(orchestrator.getTask("task-1")).toMatchObject({
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
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
    const collectedSegments = [
      segment({ id: "segment-1", sourceText: "One." }),
      segment({ id: "segment-2", order: 2, sourceText: "Two.", textHash: "hash-2" }),
    ];

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

      applyEvents.push(message.items.map((item) => item.segmentId).join(","));
      return { type: "contentActionResult", success: true };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamBatch).toHaveBeenCalledTimes(1);
    expect(streamBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        traceContext: expect.objectContaining({
          taskId: "task-1",
          batchId: expect.stringMatching(/^batch-/),
          stage: "lazy",
          providerType: "openai-compatible",
          segmentCount: 2,
          sourceCharCount: collectedSegments.reduce(
            (total, currentSegment) => total + currentSegment.sourceText.length,
            0,
          ),
        }),
      }),
    );
    expect(translateBatch).not.toHaveBeenCalled();
    expect(applyEvents).toEqual(["segment-1", "segment-2"]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("keeps streamed applied items and retries only missing segments after a stream error", async () => {
    const streamBatch = vi.fn(async function* () {
      yield {
        items: [{ segmentId: "segment-1", translatedText: "一。" }],
      };
      throw new Error("stream interrupted");
    });
    const translateBatch = vi.fn(async () => ({
      items: [{ segmentId: "segment-2", translatedText: "二。" }],
    }));
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({
        translateText: vi.fn(),
        translateBatch,
        streamBatch,
      }),
    });
    const applied: string[] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "One." }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Two.",
              textHash: "hash-2",
            }),
          ],
        };
      }

      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      applied.push(...message.items.map((item) => item.segmentId));
      return { type: "contentActionResult", success: true };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments.map((item) => item.id)).toEqual([
      "segment-2",
    ]);
    expect(applied).toEqual(["segment-1", "segment-2"]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });

  it("does not trace empty stream fallback as a completed batch", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{
        items: Array<{ segmentId: string; translatedText: string }>;
      }>
    >(async () => ({
      items: [{ segmentId: "segment-1", translatedText: "Private buffered translation." }],
    }));
    const streamBatch = vi.fn<
      (
        request: TranslateBatchRequest,
      ) => AsyncGenerator<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >((request) => {
      void request;
      return streamBatchResponses([]);
    });
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({
        translateText: vi.fn(),
        translateBatch,
        streamBatch,
      }),
    });

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: [segment({ id: "segment-1", sourceText: "Private stream source." })],
          };
        }

        if (message.type !== "applyTranslations") {
          throw new Error(`Unexpected content message: ${message.type}`);
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

      expect(streamBatch).toHaveBeenCalledTimes(1);
      expect(translateBatch).toHaveBeenCalledTimes(1);
      const batchStarts = perfTraceMetadata(infoSpy.mock.calls, "translation.batch.start");
      const batchDone = perfTraceMetadata(infoSpy.mock.calls, "translation.batch.done");

      expect(batchStarts).toHaveLength(2);
      expect(batchStarts[0].batchId).not.toBe(batchStarts[1].batchId);
      expect(batchDone).toEqual([
        expect.objectContaining({
          batchId: batchStarts[0].batchId,
          returnedCount: 0,
          missingCount: 1,
          success: false,
          reason: "emptyResponse",
        }),
        expect.objectContaining({
          batchId: batchStarts[1].batchId,
          returnedCount: 1,
          missingCount: 0,
          success: true,
        }),
      ]);
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain("Private stream source.");
      expect(output).not.toContain("Private buffered translation.");
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("correlates missing and retry traces with buffered fallback batch ids", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{
        items: Array<{ segmentId: string; translatedText: string }>;
      }>
    >()
      .mockResolvedValueOnce({
        items: [{ segmentId: "segment-1", translatedText: "Private first translation." }],
      })
      .mockResolvedValueOnce({
        items: [{ segmentId: "segment-2", translatedText: "Private second translation." }],
      });
    const streamBatch = vi.fn<
      (
        request: TranslateBatchRequest,
      ) => AsyncGenerator<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >((request) => {
      void request;
      return streamBatchResponses([]);
    });
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({
        translateText: vi.fn(),
        translateBatch,
        streamBatch,
      }),
    });

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: [
              segment({ id: "segment-1", sourceText: "Private fallback source one." }),
              segment({
                id: "segment-2",
                order: 2,
                sourceText: "Private fallback source two.",
                textHash: "hash-2",
              }),
            ],
          };
        }

        if (message.type !== "applyTranslations") {
          throw new Error(`Unexpected content message: ${message.type}`);
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

      expect(streamBatch).toHaveBeenCalledTimes(2);
      expect(translateBatch).toHaveBeenCalledTimes(2);
      const streamBatchIds = streamBatch.mock.calls.map(
        ([request]) => request.traceContext?.batchId,
      );
      const bufferedBatchIds = translateBatch.mock.calls.map(
        ([request]) => request.traceContext?.batchId,
      );

      expect(bufferedBatchIds[0]).toEqual(expect.stringMatching(/^batch-/));
      expect(bufferedBatchIds[0]).not.toBe(streamBatchIds[0]);
      expect(perfTraceMetadata(infoSpy.mock.calls, "translation.batch.missing")).toContainEqual(
        expect.objectContaining({
          batchId: bufferedBatchIds[0],
          missingCount: 1,
        }),
      );
      expect(perfTraceMetadata(infoSpy.mock.calls, "translation.batch.retry")).toContainEqual(
        expect.objectContaining({
          batchId: bufferedBatchIds[0],
          reason: "retry",
          segmentCount: 1,
        }),
      );
      expect(
        perfTraceMetadata(infoSpy.mock.calls, "translation.batch.missing"),
      ).not.toContainEqual(expect.objectContaining({ batchId: streamBatchIds[0] }));
      expect(
        perfTraceMetadata(infoSpy.mock.calls, "translation.batch.retry"),
      ).not.toContainEqual(expect.objectContaining({ batchId: streamBatchIds[0] }));
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain("Private fallback source one.");
      expect(output).not.toContain("Private fallback source two.");
      expect(output).not.toContain("Private first translation.");
      expect(output).not.toContain("Private second translation.");
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
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
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const translateBatch = vi.fn<
      (request: TranslateBatchRequest) => Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>
    >();
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    });
    let releaseSecondRequest: (() => void) | undefined;
    const privateSourceText = "Private rate limited source.";
    const privateTranslatedText = "Private rate limited translation.";

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: Array.from({ length: 21 }, (_value, index) =>
              segment({
                id: `segment-${index + 1}`,
                order: index + 1,
                sourceText:
                  index === 0 ? privateSourceText : `Paragraph ${index + 1}.`,
                textHash: `hash-${index + 1}`,
              }),
            ),
          };
        }

        return { type: "contentActionResult", success: true };
      });
      translateBatch
        .mockRejectedValueOnce(
          new ProviderError("rateLimited", "Provider rate limit exceeded.", 429),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseSecondRequest = () =>
                resolve({
                  items: Array.from({ length: 10 }, (_value, index) => ({
                    segmentId: `segment-${index + 11}`,
                    translatedText:
                      index === 0 ? privateTranslatedText : `Translated ${index + 11}`,
                  })),
                });
            }),
        )
        .mockImplementation(async (request) => {
          const ids = Array.from({ length: 21 }, (_value, index) => `segment-${index + 1}`)
            .filter((id) => request.segments.some((segment) => segment.id === id));
          return {
            items: ids.map((id) => ({
              segmentId: id,
              translatedText: id === "segment-1" ? privateTranslatedText : `Translated ${id}`,
            })),
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
      expect(infoSpy).toHaveBeenCalledWith(
        "[yoyo:perf] translation.concurrency.changed",
        expect.objectContaining({
          taskId: "task-1",
          previousConcurrency: 2,
          nextConcurrency: 1,
          reason: "rateLimited",
        }),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[yoyo:perf] translation.concurrency.changed",
        expect.objectContaining({
          taskId: "task-1",
          previousConcurrency: 1,
          nextConcurrency: 2,
          reason: "successfulBatches",
        }),
      );
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain(privateSourceText);
      expect(output).not.toContain(privateTranslatedText);
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
