import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
  OptionsOpenSource,
  OptionsSection,
} from "@/messaging/contracts";
import type { ProviderReadiness } from "@/provider/readiness";

describe("messaging contracts", () => {
  it("supports collecting page segments from the content entrypoint", () => {
    const request = {
      type: "collectSegments",
      taskId: "task-1",
      translationMode: "lazyViewport",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      providerId: "profile-1",
      textModel: "gpt-5-mini",
    } satisfies ContentRequest;

    expect(request).toEqual({
      type: "collectSegments",
      taskId: "task-1",
      translationMode: "lazyViewport",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      providerId: "profile-1",
      textModel: "gpt-5-mini",
    });
  });

  it("covers content entrypoint request variants", () => {
    const requests = [
      { type: "estimatePage" },
      {
        type: "collectSegments",
        taskId: "task-1",
        translationMode: "lazyViewport",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        providerId: "profile-1",
        textModel: "gpt-5-mini",
      },
      { type: "applyTranslations", taskId: "task-1", items: [] },
      {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "cancelled",
          total: 1,
          translated: 0,
          failed: 0,
        },
      },
      { type: "hideTranslations", taskId: "task-1" },
      { type: "showTranslations", taskId: "task-1" },
      { type: "removeTranslations", taskId: "task-1" },
      { type: "getPageRuntimeState" },
      { type: "collectSummarySource" },
      { type: "siteRulesChanged" },
      { type: "youtubeSubtitleConfigChanged" },
      {
        type: "showSelectionTranslation",
        requestId: "selection-request-1",
        state: "translated",
        sourceText: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        selectedProviderId: "provider-1",
        providerOptions: [
          {
            id: "provider-1",
            label: "DeepSeek / deepseek-v4-flash",
            providerMode: "remote",
          },
        ],
        translatedText: "你好",
      },
      {
        type: "showSelectionTranslation",
        requestId: "selection-request-2",
        state: "failed",
        sourceText: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        selectedProviderId: "provider-1",
        providerOptions: [
          {
            id: "provider-1",
            label: "DeepSeek / deepseek-v4-flash",
            providerMode: "remote",
          },
        ],
        errorMessage: "Selection translation failed.",
      },
      {
        type: "showPageSummary",
        targetLanguage: "zh-CN",
        summaryText: "This page explains the product architecture.",
      },
      {
        type: "showPageSummary",
        targetLanguage: "zh-CN",
        errorMessage: "Summary failed.",
      },
    ] satisfies ContentRequest[];

    expect(requests.map((request) => request.type)).toEqual([
      "estimatePage",
      "collectSegments",
      "applyTranslations",
      "taskProgress",
      "hideTranslations",
      "showTranslations",
      "removeTranslations",
      "getPageRuntimeState",
      "collectSummarySource",
      "siteRulesChanged",
      "youtubeSubtitleConfigChanged",
      "showSelectionTranslation",
      "showSelectionTranslation",
      "showPageSummary",
      "showPageSummary",
    ]);
  });

  it("supports selection translation requests to the background", () => {
    const request = {
      type: "translateSelection",
      tabId: 42,
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    } satisfies BackgroundRequest;

    expect(request).toEqual({
      type: "translateSelection",
      tabId: 42,
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });
  });

  it("supports selection translation popup configuration", () => {
    const request = {
      type: "getSelectionTranslationConfig",
    } satisfies BackgroundRequest;

    const response = {
      type: "selectionTranslationConfig",
      configured: true,
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: [
        {
          id: "provider-1",
          label: "DeepSeek / deepseek-v4-flash",
          providerMode: "remote",
        },
        {
          id: "chrome-built-in-ai",
          label: "Chrome Built-in AI",
          providerMode: "local-only",
        },
      ],
    } satisfies BackgroundResponse;
    const missingProviderResponse = {
      type: "selectionTranslationConfig",
      configured: false,
      targetLanguage: "zh-CN",
      providerOptions: [],
      message: "No translation provider is configured.",
    } satisfies BackgroundResponse;

    expect(request.type).toBe("getSelectionTranslationConfig");
    expect(response.providerOptions[0]?.label).toBe(
      "DeepSeek / deepseek-v4-flash",
    );
    expect(missingProviderResponse.configured).toBe(false);
    expect(missingProviderResponse.providerOptions).toEqual([]);
  });

  it("supports saving the selection translation provider", () => {
    const request = {
      type: "setSelectionTranslationProvider",
      providerId: "provider-1",
    } satisfies BackgroundRequest;

    expect(request).toEqual({
      type: "setSelectionTranslationProvider",
      providerId: "provider-1",
    });
  });

  it("supports provider-specific selection translation requests", () => {
    const request = {
      type: "translateSelectionWithProvider",
      requestId: "selection-request-1",
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      providerId: "provider-1",
    } satisfies BackgroundRequest;

    const result = {
      type: "selectionTranslationResult",
      requestId: "selection-request-1",
      providerId: "provider-1",
      translatedText: "你好",
    } satisfies BackgroundResponse;

    const error = {
      type: "selectionTranslationError",
      requestId: "selection-request-2",
      providerId: "provider-1",
      message: "Provider failed.",
    } satisfies BackgroundResponse;

    expect(request.providerId).toBe("provider-1");
    expect(result.translatedText).toBe("你好");
    expect(error.message).toBe("Provider failed.");
  });

  it("supports selection translation popup states in content messages", () => {
    const loading = {
      type: "showSelectionTranslation",
      requestId: "selection-request-1",
      state: "loading",
      sourceText: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: [
        {
          id: "provider-1",
          label: "DeepSeek / deepseek-v4-flash",
          providerMode: "remote",
        },
      ],
    } satisfies ContentRequest;

    const translated = {
      ...loading,
      state: "translated",
      translatedText: "你好",
    } satisfies ContentRequest;

    const failed = {
      ...loading,
      state: "failed",
      errorMessage: "Provider failed.",
    } satisfies ContentRequest;

    expect(loading.state).toBe("loading");
    expect(translated.translatedText).toBe("你好");
    expect(failed.errorMessage).toBe("Provider failed.");
  });

  it("supports page summary requests to the background", () => {
    const request = {
      type: "summarizePage",
      tabId: 123,
      targetLanguage: "zh-CN",
    } satisfies BackgroundRequest;

    expect(request).toEqual({
      type: "summarizePage",
      tabId: 123,
      targetLanguage: "zh-CN",
    });
  });

  it("supports lazy segment enqueue requests from content scripts", () => {
    const request = {
      type: "enqueueLazySegments",
      taskId: "task-1",
      segmentIds: ["seg_3"],
      failedSegmentIds: ["seg_4"],
      recovery: {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        providerId: "profile-1",
        textModel: "gpt-5-mini",
        segments: [],
        processedSegmentIds: [],
        failedSegmentIds: ["seg_4"],
      },
    } satisfies BackgroundRequest;

    expect(request).toEqual({
      type: "enqueueLazySegments",
      taskId: "task-1",
      segmentIds: ["seg_3"],
      failedSegmentIds: ["seg_4"],
      recovery: {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        providerId: "profile-1",
        textModel: "gpt-5-mini",
        segments: [],
        processedSegmentIds: [],
        failedSegmentIds: ["seg_4"],
      },
    });
  });

  it("supports runtime translation batch requests from content scripts", () => {
    const request = {
      type: "enqueueTranslationBatch",
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      failedSegmentIds: ["seg_2"],
      recovery: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        segments: [],
        processedSegmentIds: [],
      },
      segments: [
        {
          id: "seg_1",
          order: 1,
          sourceText: "Visible dynamic text.",
          kind: "paragraph",
          pathHint: "body.p[1]",
          textHash: "hash-1",
          priority: "viewport",
        },
      ],
    } satisfies BackgroundRequest;

    expect(request.segments[0]?.priority).toBe("viewport");
    expect(request).toEqual({
      type: "enqueueTranslationBatch",
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      failedSegmentIds: ["seg_2"],
      recovery: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        segments: [],
        processedSegmentIds: [],
      },
      segments: [
        {
          id: "seg_1",
          order: 1,
          sourceText: "Visible dynamic text.",
          kind: "paragraph",
          pathHint: "body.p[1]",
          textHash: "hash-1",
          priority: "viewport",
        },
      ],
    });
  });

  it("supports subtitle translation batch requests", () => {
    const request = {
      type: "translateSubtitleBatch",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      videoId: "video-1",
      trackKey: "video-1|en|asr",
      sourceLanguage: { kind: "known", code: "en" },
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "gpt-5-mini",
      promptVersion: "subtitle-translation-v1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime",
      segments: [
        {
          segmentId: "seg-1",
          sourceCueIds: ["cue-1"],
          sourceCueStartIndex: 0,
          sourceCueEndIndex: 0,
          startMs: 1000,
          endMs: 2500,
          sourceText: "Hello world.",
          textHash: "hash-1",
        },
      ],
    } satisfies BackgroundRequest;

    expect(request.type).toBe("translateSubtitleBatch");
  });

  it("keeps content error responses available to runtime handlers", () => {
    const response = {
      type: "contentError",
      message: "Failed to handle message.",
    } satisfies ContentResponse;

    expectTypeOf(response).toMatchTypeOf<ContentResponse>();
    expect(response.message).toBe("Failed to handle message.");
  });

  it("supports summary source results from content scripts", () => {
    const response = {
      type: "summarySourceResult",
      title: "Article title",
      sourceText: "Article body.",
      sourceCharCount: 13,
      segmentCount: 2,
    } satisfies ContentResponse;

    expectTypeOf(response).toMatchTypeOf<ContentResponse>();
    expect(response.type).toBe("summarySourceResult");
  });

  it("supports querying provider configuration state from the popup", () => {
    const request = { type: "getProviderStatus" } satisfies BackgroundRequest;
    const response = {
      type: "providerStatus",
      configured: false,
      readiness: "missingProvider",
      providerLabel: "未配置翻译服务",
      providerMode: "remote",
    } satisfies BackgroundResponse;
    const readyResponse = {
      type: "providerStatus",
      configured: true,
      readiness: "ready",
      providerLabel: "Work Provider / api.example.com",
      providerMode: "remote",
    } satisfies BackgroundResponse;
    const localOnlyResponse = {
      type: "providerStatus",
      configured: true,
      readiness: "ready",
      providerLabel: "Chrome Built-in AI / Local only",
      providerMode: "local-only",
    } satisfies BackgroundResponse;

    expect(request.type).toBe("getProviderStatus");
    expect(response.configured).toBe(false);
    expect(response.readiness).toBe("missingProvider");
    expectTypeOf(response.readiness).toMatchTypeOf<ProviderReadiness>();
    expect(readyResponse.configured).toBe(true);
    expect(readyResponse.readiness).toBe("ready");
    expect(readyResponse.providerLabel).toBe("Work Provider / api.example.com");
    expect(localOnlyResponse.providerMode).toBe("local-only");
  });

  it("accepts options routing metadata in background requests", () => {
    const section: OptionsSection = "provider";
    const source: OptionsOpenSource = "first-run";
    const requests = [
      { type: "openOptions" },
      { type: "openOptions", section },
      { type: "openOptions", section, source },
      { type: "openOptions", source: "popup" },
      { type: "openOptions", source: "manual" },
    ] satisfies BackgroundRequest[];

    expect(requests).toEqual([
      { type: "openOptions" },
      { type: "openOptions", section: "provider" },
      { type: "openOptions", section: "provider", source: "first-run" },
      { type: "openOptions", source: "popup" },
      { type: "openOptions", source: "manual" },
    ]);
  });

  it("includes optional page translation visibility in runtime state responses", () => {
    const response = {
      type: "pageRuntimeState",
      hasTranslations: true,
      taskId: "task-1",
      visibility: "hidden",
    } satisfies ContentResponse;

    expect(response.visibility).toBe("hidden");
  });
});
