import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubtitleTranslationService,
  type SubtitleTranslationServiceDependencies,
} from "@/background/youtubeSubtitle/service";
import type { BackgroundRequest } from "@/messaging/contracts";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";
import type { SubtitleSegment } from "@/subtitle/types";

const profile = {
  id: "provider-1",
  displayName: "Test Provider",
  type: "openai-compatible",
  baseURL: "https://provider.example.test",
  apiKey: "secret",
  textModel: "gpt-5-mini",
} satisfies ProviderProfile;

function subtitleSegment(overrides: Partial<SubtitleSegment> = {}): SubtitleSegment {
  return {
    segmentId: "segment-1",
    sourceCueIds: ["cue-1"],
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    startMs: 1000,
    endMs: 2000,
    sourceText: "Hello world.",
    textHash: "hash-1",
    ...overrides,
  };
}

function request(
  overrides: Partial<Extract<BackgroundRequest, { type: "translateSubtitleBatch" }>> = {},
): Extract<BackgroundRequest, { type: "translateSubtitleBatch" }> {
  return {
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
    segments: [subtitleSegment()],
    ...overrides,
  };
}

describe("createSubtitleTranslationService", () => {
  const translateBatch = vi.fn<TranslationProvider["translateBatch"]>();
  const getProviderProfile = vi.fn<
    NonNullable<SubtitleTranslationServiceDependencies["getProviderProfile"]>
  >();
  const getTranslationProvider = vi.fn<
    SubtitleTranslationServiceDependencies["getTranslationProvider"]
  >();
  const detectSourceLanguage = vi.fn<
    SubtitleTranslationServiceDependencies["detectSourceLanguage"]
  >();

  beforeEach(() => {
    translateBatch.mockReset();
    getProviderProfile.mockReset();
    getTranslationProvider.mockReset();
    detectSourceLanguage.mockReset();

    getProviderProfile.mockResolvedValue(profile);
    getTranslationProvider.mockReturnValue({
      translateText: vi.fn(),
      translateBatch,
    });
    translateBatch.mockResolvedValue({
      items: [{ segmentId: "segment-1", translatedText: "Hello translated." }],
    });
    detectSourceLanguage.mockResolvedValue("en");
  });

  function service(overrides: Partial<SubtitleTranslationServiceDependencies> = {}) {
    return createSubtitleTranslationService({
      getProviderProfile,
      getTranslationProvider,
      detectSourceLanguage,
      ...overrides,
    });
  }

  it("translates subtitle segments with the requested provider profile", async () => {
    const response = await service().translateBatch(request());

    expect(response).toEqual({
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      items: [{ segmentId: "segment-1", translatedText: "Hello translated." }],
    });
    expect(getProviderProfile).toHaveBeenCalledWith("provider-1");
    expect(translateBatch).toHaveBeenCalledWith({
      profile,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      segments: [
        {
          id: "segment-1",
          order: 0,
          sourceText: "Hello world.",
          kind: "paragraph",
          priority: "viewport",
          pathHint: "youtube.subtitle.segment-1",
          textHash: "hash-1",
        },
      ],
      traceContext: {
        taskId: "runtime-1",
        batchId: "request-1",
        stage: "subtitle",
        providerType: "openai-compatible",
        segmentCount: 1,
        sourceCharCount: 12,
      },
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("returns cached translations without calling the provider again", async () => {
    const subtitleService = service();

    await subtitleService.translateBatch(request());
    translateBatch.mockClear();

    const response = await subtitleService.translateBatch(request());

    expect(response).toMatchObject({
      type: "subtitleTranslateBatchResult",
      items: [{ segmentId: "segment-1", translatedText: "Hello translated." }],
    });
    expect(translateBatch).not.toHaveBeenCalled();
  });

  it("detects unknown source language and falls back to auto when detection fails", async () => {
    detectSourceLanguage.mockRejectedValue(new Error("Language detection failed."));

    await service().translateBatch(
      request({
        sourceLanguage: { kind: "unknown" },
        segments: [
          subtitleSegment({ segmentId: "segment-1", sourceText: "Hello." }),
          subtitleSegment({
            segmentId: "segment-2",
            sourceText: "How are you?",
            textHash: "hash-2",
          }),
        ],
      }),
    );

    expect(detectSourceLanguage).toHaveBeenCalledWith(
      "Hello.\nHow are you?",
      expect.any(AbortSignal),
    );
    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "auto",
      }),
    );
  });

  it("returns a non-retryable error when the requested provider profile is missing", async () => {
    getProviderProfile.mockResolvedValue(undefined);

    const response = await service().translateBatch(request());

    expect(response).toEqual({
      type: "subtitleTranslateBatchError",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      message: "Translation provider is not configured.",
      retryable: false,
    });
    expect(translateBatch).not.toHaveBeenCalled();
  });

  it("returns a retryable error when the provider fails", async () => {
    translateBatch.mockRejectedValue(new Error("Provider unavailable."));

    const response = await service().translateBatch(request());

    expect(response).toEqual({
      type: "subtitleTranslateBatchError",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      message: "Provider unavailable.",
      retryable: true,
    });
  });

  it("returns a non-retryable cancellation error after canceling a runtime session", async () => {
    translateBatch.mockImplementation(
      async ({ abortSignal }) =>
        new Promise((resolve, reject) => {
          abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("Request cancelled.", "AbortError"));
          });
          setTimeout(() => {
            resolve({ items: [] });
          }, 50);
        }),
    );
    const subtitleService = service();

    const pending = subtitleService.translateBatch(request());
    subtitleService.cancel("runtime-1");

    await expect(pending).resolves.toEqual({
      type: "subtitleTranslateBatchError",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      message: "Subtitle translation request was cancelled.",
      retryable: false,
    });
  });

  it("returns an empty result without calling the provider", async () => {
    const response = await service().translateBatch(request({ segments: [] }));

    expect(response).toEqual({
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      items: [],
    });
    expect(translateBatch).not.toHaveBeenCalled();
  });
});
