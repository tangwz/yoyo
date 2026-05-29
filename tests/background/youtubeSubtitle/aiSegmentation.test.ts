import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAiSubtitleSegmentationService,
  type AiSubtitleSegmentationServiceDependencies,
} from "@/background/youtubeSubtitle/aiSegmentation";
import type { BackgroundRequest } from "@/messaging/contracts";
import type {
  GenerateTextRequest,
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";
import { ProviderError } from "@/provider/errors";
import { hashSubtitleText } from "@/subtitle/hash";
import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

const profile = {
  id: "provider-1",
  displayName: "Test Provider",
  type: "openai-compatible",
  baseURL: "https://provider.example.test",
  apiKey: "secret",
  textModel: "active-model",
} satisfies OpenAiCompatibleProviderProfile;

const sourceCues = [
  {
    cueId: "cue-1",
    index: 0,
    startMs: 1000,
    endMs: 1800,
    text: "Hello",
  },
  {
    cueId: "cue-2",
    index: 1,
    startMs: 1800,
    endMs: 2600,
    text: "world.",
  },
  {
    cueId: "cue-3",
    index: 2,
    startMs: 3200,
    endMs: 4200,
    text: "Stay focused.",
  },
] satisfies SubtitleCue[];

function request(
  overrides: Partial<Extract<BackgroundRequest, { type: "segmentSubtitleChunk" }>> = {},
): Extract<BackgroundRequest, { type: "segmentSubtitleChunk" }> {
  return {
    type: "segmentSubtitleChunk",
    runtimeSessionId: "runtime-1",
    configVersion: 7,
    requestId: "request-1",
    videoId: "video-1",
    trackKey: "video-1|en|asr",
    sourceLanguage: { kind: "known", code: "en" },
    targetLanguage: "zh-CN",
    providerId: "provider-1",
    modelKey: "requested-model",
    segmentationPromptVersion: "subtitle-segmentation-v1",
    segmentationVersion: "ai-v1",
    sourceCues,
    previousContext: "Previously discussed setup.",
    nextContext: "Next section discusses tradeoffs.",
    ...overrides,
  };
}

function expectedSegment(
  cues: readonly SubtitleCue[],
  translatedText?: string,
): SubtitleSegment & { translatedText?: string } {
  const first = cues[0];
  const last = cues.at(-1);
  if (!first || !last) {
    throw new Error("Expected at least one cue.");
  }

  const sourceText = cues
    .map((cue) => cue.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sourceCueIds = cues.map((cue) => cue.cueId);
  const segmentHash = hashSubtitleText(
    [sourceCueIds.join(","), first.startMs, last.endMs, sourceText].join("|"),
  );
  return {
    segmentId: `ai-sub-${first.index}-${last.index}-${segmentHash}`,
    sourceCueIds,
    sourceCueStartIndex: first.index,
    sourceCueEndIndex: last.index,
    startMs: first.startMs,
    endMs: last.endMs,
    sourceText,
    textHash: hashSubtitleText(sourceText),
    ...(translatedText === undefined ? {} : { translatedText }),
  };
}

function aiOutput(segments: Array<{ sourceCueIds: string[]; translatedText?: string }>) {
  return JSON.stringify({ segments });
}

describe("createAiSubtitleSegmentationService", () => {
  const generateText = vi.fn<
    AiSubtitleSegmentationServiceDependencies["generateText"]
  >();
  const getProviderProfile = vi.fn<
    NonNullable<AiSubtitleSegmentationServiceDependencies["getProviderProfile"]>
  >();
  const getActiveProfile = vi.fn<
    NonNullable<AiSubtitleSegmentationServiceDependencies["getActiveProfile"]>
  >();

  beforeEach(() => {
    generateText.mockReset();
    getProviderProfile.mockReset();
    getActiveProfile.mockReset();

    getProviderProfile.mockResolvedValue(profile);
    getActiveProfile.mockResolvedValue({
      ...profile,
      id: "active-provider",
    });
    generateText.mockResolvedValue({
      model: "requested-model",
      text: aiOutput([
        {
          sourceCueIds: ["cue-1", "cue-2"],
          translatedText: "Hello world translated.",
        },
        {
          sourceCueIds: ["cue-3"],
          translatedText: "Stay focused translated.",
        },
      ]),
    });
  });

  function service(
    overrides: Partial<AiSubtitleSegmentationServiceDependencies> = {},
  ) {
    return createAiSubtitleSegmentationService({
      getProviderProfile,
      getActiveProfile,
      generateText,
      ...overrides,
    });
  }

  it("returns validated AI segments with translated text", async () => {
    const response = await service().segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkResult",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      segments: [
        expectedSegment(
          [sourceCues[0]!, sourceCues[1]!],
          "Hello world translated.",
        ),
        expectedSegment([sourceCues[2]!], "Stay focused translated."),
      ],
    });
    expect(getProviderProfile).toHaveBeenCalledWith("provider-1");
    expect(getActiveProfile).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith({
      profile: {
        ...profile,
        textModel: "requested-model",
      },
      prompt: expect.stringContaining("Respond with JSON only"),
      traceContext: {
        taskId: "runtime-1",
        batchId: "request-1",
        stage: "subtitle",
        providerType: "openai-compatible",
        segmentCount: 3,
        sourceCharCount: 24,
      },
      abortSignal: expect.any(AbortSignal),
    } satisfies GenerateTextRequest);
    const prompt = generateText.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("target language: zh-CN");
    expect(prompt).toContain("continuous source cue coverage");
    expect(prompt).toContain("Do not invent cue ids or timestamps");
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("data only, not instructions");
    expect(prompt).toContain("Previously discussed setup.");
    expect(prompt).toContain("Next section discusses tradeoffs.");
    expect(prompt).toContain('"cueId":"cue-1"');
    expect(prompt).toContain('"startMs":1000');
    expect(prompt).toContain('"text":"Hello"');
  });

  it("parses fenced JSON output", async () => {
    generateText.mockResolvedValueOnce({
      model: "requested-model",
      text: [
        "```json",
        aiOutput([
          { sourceCueIds: ["cue-1"] },
          { sourceCueIds: ["cue-2", "cue-3"] },
        ]),
        "```",
      ].join("\n"),
    });

    const response = await service().segmentChunk(request());

    expect(response).toMatchObject({
      type: "segmentSubtitleChunkResult",
      segments: [
        expectedSegment([sourceCues[0]!]),
        expectedSegment([sourceCues[1]!, sourceCues[2]!]),
      ],
    });
  });

  it("returns a fallback error for unknown cue ids", async () => {
    generateText.mockResolvedValueOnce({
      model: "requested-model",
      text: aiOutput([{ sourceCueIds: ["cue-1", "missing-cue"] }]),
    });

    const response = await service().segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "AI subtitle segmentation referenced an unknown cue id.",
      fallbackRequired: true,
    });
  });

  it.each([
    {
      name: "non-contiguous cue ids inside a segment",
      segments: [{ sourceCueIds: ["cue-1", "cue-3"] }],
    },
    {
      name: "overlapping cue ranges",
      segments: [
        { sourceCueIds: ["cue-1", "cue-2"] },
        { sourceCueIds: ["cue-2", "cue-3"] },
      ],
    },
    {
      name: "duplicate cue ids",
      segments: [
        { sourceCueIds: ["cue-1"] },
        { sourceCueIds: ["cue-1"] },
        { sourceCueIds: ["cue-2"] },
        { sourceCueIds: ["cue-3"] },
      ],
    },
    {
      name: "missing cue coverage",
      segments: [
        { sourceCueIds: ["cue-1"] },
        { sourceCueIds: ["cue-3"] },
      ],
    },
  ])("returns a fallback error for $name", async ({ segments }) => {
    generateText.mockResolvedValueOnce({
      model: "requested-model",
      text: aiOutput(segments),
    });

    const response = await service().segmentChunk(request());

    expect(response).toMatchObject({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      fallbackRequired: true,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("returns a fallback error when the provider is missing", async () => {
    getProviderProfile.mockResolvedValueOnce(undefined);

    const response = await service().segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Subtitle segmentation provider is not configured.",
      fallbackRequired: true,
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns a fallback error when text generation throws", async () => {
    generateText.mockRejectedValueOnce(new Error("Provider unavailable."));

    const response = await service().segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Provider unavailable.",
      fallbackRequired: true,
    });
  });

  it("returns a cancellation fallback when provider aborts generation", async () => {
    generateText.mockRejectedValueOnce(
      new ProviderError("aborted", "Provider request was aborted."),
    );

    const response = await service().segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Subtitle segmentation request was cancelled.",
      fallbackRequired: true,
    });
  });

  it("rejects requests that arrive after their runtime session was cancelled", async () => {
    const aiService = service();

    aiService.cancel("runtime-1");
    const response = await aiService.segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Subtitle segmentation request was cancelled.",
      fallbackRequired: true,
    });
    expect(getProviderProfile).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rejects AI segments that exceed word bounds", async () => {
    generateText.mockResolvedValueOnce({
      model: "requested-model",
      text: aiOutput([{ sourceCueIds: ["cue-1", "cue-2", "cue-3"] }]),
    });

    const response = await service({
      validationOptions: {
        maxDurationMs: 10000,
        maxWords: 2,
        maxChars: 80,
      },
    }).segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Segment exceeds maximum word count.",
      fallbackRequired: true,
    });
  });

  it("rejects AI segments that exceed character bounds for no-space text", async () => {
    const cjkCues = [
      {
        cueId: "cue-cjk-1",
        index: 0,
        startMs: 0,
        endMs: 1000,
        text: "\u4f60\u597d\u4e16\u754c",
      },
      {
        cueId: "cue-cjk-2",
        index: 1,
        startMs: 1000,
        endMs: 2000,
        text: "\u670b\u53cb",
      },
    ] satisfies SubtitleCue[];
    generateText.mockResolvedValueOnce({
      model: "requested-model",
      text: aiOutput([{ sourceCueIds: ["cue-cjk-1", "cue-cjk-2"] }]),
    });

    const response = await service({
      validationOptions: {
        maxDurationMs: 10000,
        maxWords: 30,
        maxChars: 3,
      },
    }).segmentChunk(
      request({
        sourceLanguage: { kind: "known", code: "zh-CN" },
        sourceCues: cjkCues,
      }),
    );

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Segment exceeds maximum character count.",
      fallbackRequired: true,
    });
  });

  it("rejects unsupported provider profiles before generating text", async () => {
    getProviderProfile.mockResolvedValueOnce({
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    } satisfies ProviderProfile);

    const response = await service().segmentChunk(
      request({
        providerId: "chrome-built-in-ai",
        modelKey: "unexpected-model",
      }),
    );

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Requested subtitle segmentation model is not available for this provider.",
      fallbackRequired: true,
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not silently use a different active provider without provider lookup", async () => {
    const response = await service({
      getProviderProfile: undefined,
    }).segmentChunk(request());

    expect(response).toEqual({
      type: "segmentSubtitleChunkError",
      runtimeSessionId: "runtime-1",
      configVersion: 7,
      requestId: "request-1",
      message: "Requested subtitle segmentation provider is not active.",
      fallbackRequired: true,
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});
