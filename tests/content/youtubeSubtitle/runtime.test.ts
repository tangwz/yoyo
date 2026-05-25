import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createYouTubeSubtitleRuntime,
  type YouTubeCaptionPayloadResult,
  type YouTubeSubtitleRuntimeDependencies,
} from "@/content/youtubeSubtitle/runtime";
import { buildTrackKey } from "@/content/youtubeSubtitle/trackSelection";
import type {
  BackgroundRequest,
  BackgroundResponse,
} from "@/messaging/contracts";
import {
  defaultSubtitlePreferences,
  type SubtitleCue,
  type SubtitlePreferences,
} from "@/subtitle/types";

type TestRuntime = ReturnType<typeof createYouTubeSubtitleRuntime>;

function createPlayerDom(options: { video?: boolean } = {}): HTMLElement {
  const player = document.createElement("div");
  player.id = "movie_player";
  if (options.video ?? true) {
    const video = document.createElement("video");
    video.currentTime = 0;
    player.append(video);
  }
  const controls = document.createElement("div");
  controls.className = "ytp-right-controls";
  player.append(controls);
  document.body.append(player);
  return player;
}

function createPreferences(
  overrides: Partial<SubtitlePreferences> = {},
): SubtitlePreferences {
  return {
    ...defaultSubtitlePreferences,
    ...overrides,
  };
}

function createRuntimeHarness(options: {
  preferences?: SubtitlePreferences;
  currentUrl?: string;
  loadPreferences?: () => Promise<SubtitlePreferences>;
  sendBackgroundMessage?: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  fetchCaptionPayload?: () => Promise<YouTubeCaptionPayloadResult | undefined>;
  getCaptionTrackKey?: () => Promise<string | undefined>;
  createRuntimeSessionIdBase?: () => string;
} = {}): {
  runtime: TestRuntime;
  preferences: SubtitlePreferences;
  savedPreferences: SubtitlePreferences[];
  sentMessages: BackgroundRequest[];
  setCurrentUrl: (url: string) => void;
} {
  let preferences = options.preferences ?? createPreferences();
  let currentUrl = options.currentUrl ?? "https://www.youtube.com/watch?v=video-a";
  const savedPreferences: SubtitlePreferences[] = [];
  const sentMessages: BackgroundRequest[] = [];

  const dependencies: YouTubeSubtitleRuntimeDependencies = {
    subtitlePreferences: {
      get: vi.fn(options.loadPreferences ?? (async () => preferences)),
      save: vi.fn(async (nextPreferences) => {
        preferences = nextPreferences;
        savedPreferences.push(nextPreferences);
      }),
    },
    sendBackgroundMessage: vi.fn(async (message) => {
      sentMessages.push(message);
      if (options.sendBackgroundMessage) {
        return options.sendBackgroundMessage(message);
      }
      return createBackgroundResponse(message);
    }) as (message: BackgroundRequest) => Promise<BackgroundResponse>,
    fetchCaptionPayload: vi.fn(
      options.fetchCaptionPayload ?? createCaptionPayload,
    ),
    getCaptionTrackKey: options.getCaptionTrackKey
      ? vi.fn(options.getCaptionTrackKey)
      : undefined,
    createRuntimeSessionIdBase:
      options.createRuntimeSessionIdBase ??
      (() => "youtube-subtitle-session"),
    getCurrentUrl: () => currentUrl,
  };

  return {
    runtime: createYouTubeSubtitleRuntime(dependencies),
    get preferences() {
      return preferences;
    },
    savedPreferences,
    sentMessages,
    setCurrentUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

async function flushRuntime(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function createCaptionPayload(): Promise<YouTubeCaptionPayloadResult> {
  return Promise.resolve({
    payload: {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 2000,
          segs: [{ utf8: "Hello world." }],
        },
        {
          tStartMs: 2500,
          dDurationMs: 1800,
          segs: [{ utf8: "Second cue." }],
        },
      ],
    },
    track: {
      languageCode: "en",
      kind: "asr",
      name: "English",
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-a&lang=en",
    },
    sourceLanguage: { kind: "known", code: "en" },
  });
}

function createBackgroundResponse(
  message: BackgroundRequest,
): BackgroundResponse {
  if (message.type === "getSubtitleRuntimeConfig") {
    return {
      type: "subtitleRuntimeConfig",
      configured: true,
      providerId: "test-provider",
      modelKey: "test-model",
      targetLanguage: "zh-CN",
    };
  }

  if (message.type === "translateSubtitleBatch") {
    return {
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: message.runtimeSessionId,
      configVersion: message.configVersion,
      requestId: message.requestId,
      items: message.segments.map((segment) => ({
        segmentId: segment.segmentId,
        translatedText: `Translated: ${segment.sourceText}`,
      })),
    };
  }

  if (message.type === "segmentSubtitleChunk") {
    const firstCue = message.sourceCues[0];
    const lastCue = message.sourceCues.at(-1);
    if (!firstCue || !lastCue) {
      throw new Error("Expected source cues.");
    }

    return {
      type: "segmentSubtitleChunkResult",
      runtimeSessionId: message.runtimeSessionId,
      configVersion: message.configVersion,
      requestId: message.requestId,
      segments: [
        {
          segmentId: "ai-segment-1",
          sourceCueIds: message.sourceCues.map((cue: SubtitleCue) => cue.cueId),
          sourceCueStartIndex: firstCue.index,
          sourceCueEndIndex: lastCue.index,
          startMs: firstCue.startMs,
          endMs: lastCue.endMs,
          sourceText: "AI segmented text.",
          textHash: "ai-segmented-text",
        },
      ],
    };
  }

  return { type: "backgroundActionResult", success: true };
}

function cancelMessages(
  messages: readonly BackgroundRequest[],
): Extract<BackgroundRequest, { type: "cancelSubtitleRequests" }>[] {
  return messages.filter(
    (
      message,
    ): message is Extract<
      BackgroundRequest,
      { type: "cancelSubtitleRequests" }
    > => message.type === "cancelSubtitleRequests",
  );
}

function translateMessages(
  messages: readonly BackgroundRequest[],
): Extract<BackgroundRequest, { type: "translateSubtitleBatch" }>[] {
  return messages.filter(
    (
      message,
    ): message is Extract<
      BackgroundRequest,
      { type: "translateSubtitleBatch" }
    > => message.type === "translateSubtitleBatch",
  );
}

function segmentationMessages(
  messages: readonly BackgroundRequest[],
): Extract<BackgroundRequest, { type: "segmentSubtitleChunk" }>[] {
  return messages.filter(
    (
      message,
    ): message is Extract<
      BackgroundRequest,
      { type: "segmentSubtitleChunk" }
    > => message.type === "segmentSubtitleChunk",
  );
}

function mountedButtons(): NodeListOf<HTMLButtonElement> {
  return document.querySelectorAll<HTMLButtonElement>(
    '[data-yoyo-youtube-subtitle-button="true"]',
  );
}

function mountedButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-yoyo-youtube-subtitle-button="true"]',
  );
  if (!button) {
    throw new Error("Expected subtitle button to be mounted.");
  }
  return button;
}

function mountedOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-yoyo-youtube-subtitle-overlay="true"]',
  );
}

function mountedVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>("#movie_player video");
  if (!video) {
    throw new Error("Expected video to be mounted.");
  }
  return video;
}

function buttonStatus(): string | undefined {
  return mountedButton().querySelector<HTMLElement>(
    '[data-yoyo-youtube-subtitle-badge="true"]',
  )?.dataset.status;
}

describe("createYouTubeSubtitleRuntime", () => {
  const runtimes: TestRuntime[] = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.destroy()));
    runtimes.length = 0;
  });

  function trackRuntime(runtime: TestRuntime): TestRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  it("mounts one player button across idempotent starts", async () => {
    createPlayerDom();
    const { runtime } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await runtime.start();
    await flushRuntime();

    expect(mountedButtons()).toHaveLength(1);
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("fetches captions, translates a window, and renders the active bilingual segment", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(translateMessages(sentMessages)).toHaveLength(1);
    expect(translateMessages(sentMessages)[0]).toMatchObject({
      type: "translateSubtitleBatch",
      runtimeSessionId: "youtube-subtitle-session-1",
      configVersion: 1,
      videoId: "video-a",
      sourceLanguage: { kind: "known", code: "en" },
      targetLanguage: "zh-CN",
      providerId: "test-provider",
      modelKey: "test-model",
      promptVersion: "subtitle-translation-v1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime",
    });
    expect(mountedOverlay()?.textContent).toContain("Hello world.");
    expect(mountedOverlay()?.textContent).toContain("Translated: Hello world.");
  });

  it("derives video keys from YouTube shorts and embed URLs", async () => {
    createPlayerDom();
    const shorts = createRuntimeHarness({
      currentUrl: "https://www.youtube.com/shorts/short-video-id",
    }).runtime;
    const embed = createRuntimeHarness({
      currentUrl: "https://www.youtube.com/embed/embed-video-id",
    }).runtime;
    trackRuntime(shorts);
    trackRuntime(embed);

    await shorts.start();
    await embed.start();
    await flushRuntime();

    expect(shorts.getState().videoKey).toBe("short-video-id");
    expect(embed.getState().videoKey).toBe("embed-video-id");
  });

  it("hides the overlay when playback is outside subtitle segment ranges", async () => {
    createPlayerDom();
    const { runtime } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    mountedVideo().currentTime = 2.2;
    mountedVideo().dispatchEvent(new Event("timeupdate"));
    await flushRuntime();

    expect(mountedOverlay()?.hidden).toBe(true);
  });

  it("binds playback listeners when the video element appears after pipeline init", async () => {
    const player = createPlayerDom({ video: false });
    const { runtime } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    const video = document.createElement("video");
    video.currentTime = 3;
    player.prepend(video);
    await flushRuntime();
    video.dispatchEvent(new Event("timeupdate"));
    await flushRuntime();

    expect(mountedOverlay()?.textContent).toContain("Second cue.");
    expect(mountedOverlay()?.textContent).toContain("Translated: Second cue.");
  });

  it("uses unique runtime session ids by default", () => {
    createPlayerDom();
    const dependencies: YouTubeSubtitleRuntimeDependencies = {
      subtitlePreferences: {
        get: vi.fn(async () => createPreferences()),
        save: vi.fn(),
      },
      sendBackgroundMessage: vi.fn(async (message: BackgroundRequest) =>
        createBackgroundResponse(message),
      ),
      fetchCaptionPayload: vi.fn(createCaptionPayload),
      getCurrentUrl: () => "https://www.youtube.com/watch?v=video-a",
    };
    const first = createYouTubeSubtitleRuntime(dependencies);
    const second = createYouTubeSubtitleRuntime(dependencies);
    trackRuntime(first);
    trackRuntime(second);

    expect(first.getState().runtimeSessionId).not.toBe(
      second.getState().runtimeSessionId,
    );
  });

  it("skips provider translation when source language already matches target language", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "getSubtitleRuntimeConfig") {
          return {
            type: "subtitleRuntimeConfig",
            configured: true,
            providerId: "test-provider",
            modelKey: "test-model",
            targetLanguage: "en",
          };
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(translateMessages(sentMessages)).toHaveLength(0);
    expect(mountedOverlay()?.textContent).toContain("Hello world.");
  });

  it("reinitializes the pipeline when the active caption track changes", async () => {
    createPlayerDom();
    let track = {
      languageCode: "en",
      kind: "asr",
      name: "English",
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-a&lang=en",
    };
    const { runtime, sentMessages } = createRuntimeHarness({
      fetchCaptionPayload: async () => ({
        ...(await createCaptionPayload()),
        track,
      }),
      getCaptionTrackKey: async () => buildTrackKey("video-a", track),
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    track = {
      languageCode: "ja",
      kind: "manual",
      name: "Japanese",
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-a&lang=ja",
    };
    document.body.append(document.createElement("span"));
    await flushRuntime();

    expect(cancelMessages(sentMessages)).toContainEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "configChanged",
    });
    expect(runtime.getState()).toMatchObject({
      runtimeSessionId: "youtube-subtitle-session-2",
      configVersion: 2,
    });
    expect(translateMessages(sentMessages).at(-1)).toMatchObject({
      runtimeSessionId: "youtube-subtitle-session-2",
      configVersion: 2,
    });
  });

  it("uses AI segmentation when the subtitle preference is enabled", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      preferences: createPreferences({ aiSegmentationEnabled: true }),
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(segmentationMessages(sentMessages)).toHaveLength(1);
    expect(segmentationMessages(sentMessages)[0]).toMatchObject({
      type: "segmentSubtitleChunk",
      runtimeSessionId: "youtube-subtitle-session-1",
      configVersion: 1,
      segmentationPromptVersion: "subtitle-segmentation-v1",
      segmentationVersion: "ai-v1",
    });
    expect(translateMessages(sentMessages)[0]).toMatchObject({
      type: "translateSubtitleBatch",
      segmentationVersion: "ai-v1",
      segments: [expect.objectContaining({ segmentId: "ai-segment-1" })],
    });
    expect(mountedOverlay()?.textContent).toContain("AI segmented text.");
    expect(mountedOverlay()?.textContent).toContain(
      "Translated: AI segmented text.",
    );
  });

  it("falls back to built-in segmentation when AI segmentation fails", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      preferences: createPreferences({ aiSegmentationEnabled: true }),
      sendBackgroundMessage: async (message) => {
        if (message.type === "segmentSubtitleChunk") {
          return {
            type: "segmentSubtitleChunkError",
            runtimeSessionId: message.runtimeSessionId,
            configVersion: message.configVersion,
            requestId: message.requestId,
            message: "AI segmentation failed.",
            fallbackRequired: true,
          };
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(segmentationMessages(sentMessages)).toHaveLength(1);
    expect(translateMessages(sentMessages)[0]).toMatchObject({
      type: "translateSubtitleBatch",
      segmentationVersion: "builtin-v1",
    });
    expect(mountedOverlay()?.textContent).toContain("Hello world.");
    expect(mountedOverlay()?.textContent).toContain("Translated: Hello world.");
  });

  it("ignores stale AI segmentation responses before falling back", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      preferences: createPreferences({ aiSegmentationEnabled: true }),
      sendBackgroundMessage: async (message) => {
        if (message.type === "segmentSubtitleChunk") {
          return {
            type: "segmentSubtitleChunkResult",
            runtimeSessionId: message.runtimeSessionId,
            configVersion: message.configVersion + 1,
            requestId: message.requestId,
            segments: [
              {
                segmentId: "stale-ai-segment",
                sourceCueIds: ["cue-1"],
                sourceCueStartIndex: 0,
                sourceCueEndIndex: 0,
                startMs: 0,
                endMs: 2000,
                sourceText: "Stale AI text.",
                textHash: "stale-ai-text",
              },
            ],
          };
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(segmentationMessages(sentMessages)).toHaveLength(1);
    expect(translateMessages(sentMessages)[0]).toMatchObject({
      type: "translateSubtitleBatch",
      segmentationVersion: "builtin-v1",
    });
    expect(mountedOverlay()?.textContent).not.toContain("Stale AI text.");
    expect(mountedOverlay()?.textContent).toContain("Hello world.");
  });

  it("persists disabled preference and cancels the active session on click", async () => {
    createPlayerDom();
    const { runtime, savedPreferences, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    mountedButton().click();
    await flushRuntime();

    expect(savedPreferences.at(-1)?.youtubeEnabled).toBe(false);
    expect(cancelMessages(sentMessages)).toContainEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "userDisabled",
    });
    expect(buttonStatus()).toBe("disabled");
    expect(mountedOverlay()).toBeNull();
  });

  it("persists enabled preference and remounts the overlay from disabled state", async () => {
    createPlayerDom();
    const { runtime, savedPreferences, sentMessages } = createRuntimeHarness({
      preferences: createPreferences({ youtubeEnabled: false }),
    });
    trackRuntime(runtime);

    await runtime.start();

    expect(buttonStatus()).toBe("disabled");
    expect(mountedOverlay()).toBeNull();

    mountedButton().click();
    await flushRuntime();

    expect(savedPreferences.at(-1)?.youtubeEnabled).toBe(true);
    expect(cancelMessages(sentMessages)).toHaveLength(0);
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("cancels on stop and removes button and overlay on destroy", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    await runtime.stop("configChanged");

    expect(cancelMessages(sentMessages).at(-1)).toEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "configChanged",
    });
    expect(mountedOverlay()).toBeNull();
    expect(mountedButtons()).toHaveLength(1);

    await runtime.destroy();
    await runtime.destroy();

    expect(cancelMessages(sentMessages)).toHaveLength(1);
    expect(mountedOverlay()).toBeNull();
    expect(mountedButtons()).toHaveLength(0);
  });

  it("ignores repeated stop calls after the active session is already cancelled", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    await runtime.stop("configChanged");
    await runtime.stop("configChanged");

    expect(cancelMessages(sentMessages)).toHaveLength(1);
    expect(runtime.getState().runtimeSessionId).toBe("youtube-subtitle-session-2");
  });

  it("remounts after YouTube recreates player controls", async () => {
    const player = createPlayerDom();
    const { runtime } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    const firstButton = mountedButton();
    player.querySelector(".ytp-right-controls")?.remove();

    const nextControls = document.createElement("div");
    nextControls.className = "ytp-right-controls";
    player.append(nextControls);
    await flushRuntime();

    expect(mountedButtons()).toHaveLength(1);
    expect(mountedButton()).not.toBe(firstButton);
    expect(mountedButton().parentElement).toBe(nextControls);
  });

  it("invalidates the session when the YouTube video URL changes", async () => {
    createPlayerDom();
    const { runtime, sentMessages, setCurrentUrl } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    setCurrentUrl("https://www.youtube.com/watch?v=video-b");
    document.body.append(document.createElement("span"));
    await flushRuntime();

    expect(cancelMessages(sentMessages)).toContainEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "videoChanged",
    });
    expect(runtime.getState().runtimeSessionId).toBe("youtube-subtitle-session-2");
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("invalidates in-flight state when provider or language config changes", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    await runtime.handleConfigChanged();
    await flushRuntime();

    expect(cancelMessages(sentMessages)).toContainEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "configChanged",
    });
    expect(runtime.getState()).toMatchObject({
      runtimeSessionId: "youtube-subtitle-session-2",
      configVersion: 2,
      enabled: true,
    });
    expect(translateMessages(sentMessages).at(-1)).toMatchObject({
      type: "translateSubtitleBatch",
      runtimeSessionId: "youtube-subtitle-session-2",
      configVersion: 2,
    });
    expect(mountedOverlay()?.textContent).toContain("Translated: Hello world.");
  });

  it("reloads disabled subtitle preferences on config changes", async () => {
    createPlayerDom();
    const { runtime, preferences } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    preferences.youtubeEnabled = false;
    await runtime.handleConfigChanged();
    await flushRuntime();

    expect(runtime.getState()).toMatchObject({
      enabled: false,
      runtimeSessionId: "youtube-subtitle-session-2",
    });
    expect(buttonStatus()).toBe("disabled");
    expect(mountedOverlay()).toBeNull();
  });

  it("keeps local disable state when background cancel rejects", async () => {
    createPlayerDom();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime, savedPreferences } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "cancelSubtitleRequests") {
          throw new Error("Cancel failed.");
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    mountedButton().click();
    await flushRuntime();

    expect(savedPreferences.at(-1)?.youtubeEnabled).toBe(false);
    expect(runtime.getState().runtimeSessionId).toBe("youtube-subtitle-session-2");
    expect(buttonStatus()).toBe("disabled");
    expect(mountedOverlay()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps local video-change invalidation when background cancel rejects", async () => {
    createPlayerDom();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime, setCurrentUrl } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "cancelSubtitleRequests") {
          throw new Error("Cancel failed.");
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    setCurrentUrl("https://www.youtube.com/watch?v=video-b");
    document.body.append(document.createElement("span"));
    await flushRuntime();

    expect(runtime.getState().runtimeSessionId).toBe("youtube-subtitle-session-2");
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("removes UI and ignores later stop calls when destroy cancellation rejects", async () => {
    createPlayerDom();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime, sentMessages } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "cancelSubtitleRequests") {
          throw new Error("Cancel failed.");
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    await runtime.destroy();
    await runtime.stop("configChanged");

    expect(cancelMessages(sentMessages)).toHaveLength(1);
    expect(mountedButtons()).toHaveLength(0);
    expect(mountedOverlay()).toBeNull();
  });

  it("does not mount observers or UI after destroy wins a pending start", async () => {
    createPlayerDom();
    let resolvePreferences: (preferences: SubtitlePreferences) => void = () => undefined;
    let observeCalls = 0;
    const runtime = createYouTubeSubtitleRuntime({
      subtitlePreferences: {
        get: vi.fn(
          () =>
            new Promise<SubtitlePreferences>((resolve) => {
              resolvePreferences = resolve;
            }),
        ),
        save: vi.fn(),
      },
      sendBackgroundMessage: vi.fn(
        async (): Promise<BackgroundResponse> => ({
          type: "backgroundActionResult",
          success: true,
        }),
      ),
      createMutationObserver: (callback) =>
        ({
          observe: () => {
            observeCalls += 1;
            callback([], {} as MutationObserver);
          },
          disconnect: vi.fn(),
          takeRecords: vi.fn(() => []),
        }) as unknown as MutationObserver,
    });

    const pendingStart = runtime.start();
    await runtime.destroy();
    resolvePreferences(createPreferences());
    await pendingStart;
    await flushRuntime();

    expect(observeCalls).toBe(0);
    expect(mountedButtons()).toHaveLength(0);
    expect(mountedOverlay()).toBeNull();
  });
});
