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
      textModel: "gpt-4.1-mini",
    } satisfies ContentRequest;

    expect(request).toEqual({
      type: "collectSegments",
      taskId: "task-1",
      translationMode: "lazyViewport",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      providerId: "profile-1",
      textModel: "gpt-4.1-mini",
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
        textModel: "gpt-4.1-mini",
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
      {
        type: "showSelectionTranslation",
        sourceText: "Hello",
        translatedText: "你好",
      },
      {
        type: "showSelectionTranslation",
        sourceText: "Hello",
        errorMessage: "Selection translation failed.",
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
      "showSelectionTranslation",
      "showSelectionTranslation",
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
        textModel: "gpt-4.1-mini",
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
        textModel: "gpt-4.1-mini",
        segments: [],
        processedSegmentIds: [],
        failedSegmentIds: ["seg_4"],
      },
    });
  });

  it("keeps content error responses available to runtime handlers", () => {
    const response = {
      type: "contentError",
      message: "Failed to handle message.",
    } satisfies ContentResponse;

    expectTypeOf(response).toMatchTypeOf<ContentResponse>();
    expect(response.message).toBe("Failed to handle message.");
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
