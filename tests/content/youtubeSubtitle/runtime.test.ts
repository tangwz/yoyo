import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createYouTubeSubtitleRuntime,
  type YouTubeSubtitleRuntimeDependencies,
} from "@/content/youtubeSubtitle/runtime";
import type {
  BackgroundRequest,
  BackgroundResponse,
} from "@/messaging/contracts";
import {
  defaultSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";

type TestRuntime = ReturnType<typeof createYouTubeSubtitleRuntime>;

function createPlayerDom(): HTMLElement {
  const player = document.createElement("div");
  player.id = "movie_player";
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
      return { type: "backgroundActionResult", success: true };
    }) as (message: BackgroundRequest) => Promise<BackgroundResponse>,
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
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
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

    expect(mountedButtons()).toHaveLength(1);
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("persists disabled preference and cancels the active session on click", async () => {
    createPlayerDom();
    const { runtime, savedPreferences, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    mountedButton().click();
    await flushRuntime();

    expect(savedPreferences.at(-1)?.youtubeEnabled).toBe(false);
    expect(sentMessages).toContainEqual({
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
    expect(sentMessages).toHaveLength(0);
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
  });

  it("cancels on stop and removes button and overlay on destroy", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
    await runtime.stop("configChanged");

    expect(sentMessages.at(-1)).toEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "configChanged",
    });
    expect(mountedOverlay()).toBeNull();
    expect(mountedButtons()).toHaveLength(1);

    await runtime.destroy();
    await runtime.destroy();

    expect(sentMessages.at(-1)).toEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-2",
      reason: "pageUnloaded",
    });
    expect(mountedOverlay()).toBeNull();
    expect(mountedButtons()).toHaveLength(0);
  });

  it("remounts after YouTube recreates player controls", async () => {
    const player = createPlayerDom();
    const { runtime } = createRuntimeHarness();
    trackRuntime(runtime);

    await runtime.start();
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
    setCurrentUrl("https://www.youtube.com/watch?v=video-b");
    document.body.append(document.createElement("span"));
    await flushRuntime();

    expect(sentMessages).toContainEqual({
      type: "cancelSubtitleRequests",
      runtimeSessionId: "youtube-subtitle-session-1",
      reason: "videoChanged",
    });
    expect(runtime.getState().runtimeSessionId).toBe("youtube-subtitle-session-2");
    expect(buttonStatus()).toBe("enabled");
    expect(mountedOverlay()).not.toBeNull();
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
