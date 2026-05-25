import {
  mountYoutubeSubtitleOverlay,
  type YoutubeSubtitleOverlay,
} from "@/content/youtubeSubtitle/overlay";
import {
  mountYoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButtonStatus,
} from "@/content/youtubeSubtitle/playerButton";
import {
  defaultSubtitleSchedulerOptions,
  SubtitleScheduler,
} from "@/content/youtubeSubtitle/scheduler";
import { SubtitleSessionCache } from "@/content/youtubeSubtitle/sessionCache";
import type {
  BackgroundRequest,
  BackgroundResponse,
} from "@/messaging/contracts";
import type { SubtitlePreferences } from "@/subtitle/types";

export type YouTubeSubtitleStopReason = Extract<
  BackgroundRequest,
  { type: "cancelSubtitleRequests" }
>["reason"];

export type YouTubeSubtitleRuntimeState = {
  started: boolean;
  enabled: boolean;
  runtimeSessionId: string;
  configVersion: number;
  videoKey: string;
};

export type YouTubeCaptionPayloadRequest = {
  runtimeSessionId: string;
  configVersion: number;
  videoKey: string;
};

export type YouTubeSubtitleRuntimeDependencies = {
  subtitlePreferences: {
    get: () => Promise<SubtitlePreferences>;
    save: (preferences: SubtitlePreferences) => Promise<void>;
  };
  sendBackgroundMessage: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  fetchCaptionPayload?: (
    request: YouTubeCaptionPayloadRequest,
  ) => Promise<unknown>;
  document?: Document;
  getCurrentUrl?: () => string;
  createMutationObserver?: (callback: MutationCallback) => MutationObserver;
};

export type YouTubeSubtitleRuntime = {
  start: () => Promise<void>;
  stop: (reason: YouTubeSubtitleStopReason) => Promise<void>;
  destroy: () => Promise<void>;
  getState: () => YouTubeSubtitleRuntimeState;
};

const PLAYER_SELECTOR = "#movie_player";
const CONTROLS_SELECTOR = ".ytp-right-controls";
const SESSION_ID_PREFIX = "youtube-subtitle-session";

export function createYouTubeSubtitleRuntime(
  dependencies: YouTubeSubtitleRuntimeDependencies,
): YouTubeSubtitleRuntime {
  const rootDocument = dependencies.document ?? document;
  const createObserver =
    dependencies.createMutationObserver ??
    ((callback: MutationCallback) => new MutationObserver(callback));
  const getCurrentUrl =
    dependencies.getCurrentUrl ?? (() => rootDocument.location.href);

  let preferences: SubtitlePreferences | undefined;
  let started = false;
  let destroyed = false;
  let stopped = false;
  let startPromise: Promise<void> | undefined;
  let observer: MutationObserver | undefined;
  let reconcileQueued = false;
  let button: YoutubeSubtitlePlayerButton | undefined;
  let buttonStatus: YoutubeSubtitlePlayerButtonStatus | undefined;
  let overlay: YoutubeSubtitleOverlay | undefined;
  let sessionIndex = 1;
  let configVersion = 1;
  let videoKey = readVideoKey(getCurrentUrl());
  let scheduler = createScheduler(preferences);
  let sessionCache = new SubtitleSessionCache();
  let operationQueue = Promise.resolve();

  async function start(): Promise<void> {
    if (destroyed) {
      return;
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      preferences = await dependencies.subtitlePreferences.get();
      scheduler = createScheduler(preferences);
      sessionCache = new SubtitleSessionCache();
      videoKey = readVideoKey(getCurrentUrl());
      started = true;
      stopped = false;
      ensureObserver();
      await reconcile();
    })();

    return startPromise;
  }

  async function stop(reason: YouTubeSubtitleStopReason): Promise<void> {
    await stopSession(reason, true);
  }

  async function stopSession(
    reason: YouTubeSubtitleStopReason,
    suspendRuntime: boolean,
  ): Promise<void> {
    if (!started && !startPromise) {
      return;
    }

    if (suspendRuntime) {
      stopped = true;
    }
    overlay?.destroy();
    overlay = undefined;
    scheduler.clearInFlight();
    sessionCache.clear();

    await dependencies.sendBackgroundMessage({
      type: "cancelSubtitleRequests",
      runtimeSessionId: currentRuntimeSessionId(),
      reason,
    });

    advanceSession();
  }

  async function destroy(): Promise<void> {
    if (destroyed) {
      return;
    }
    destroyed = true;
    observer?.disconnect();
    observer = undefined;
    await stopSession("pageUnloaded", true);
    button?.destroy();
    button = undefined;
    buttonStatus = undefined;
    overlay?.destroy();
    overlay = undefined;
    started = false;
  }

  async function reconcile(): Promise<void> {
    if (!started || destroyed) {
      return;
    }

    const nextVideoKey = readVideoKey(getCurrentUrl());
    if (videoKey && nextVideoKey !== videoKey) {
      await stopSession("videoChanged", false);
      stopped = false;
    }
    videoKey = nextVideoKey;

    const player = findPlayer(rootDocument);
    const controls = findControls(player);
    const enabled = (preferences?.youtubeEnabled ?? false) && !stopped;

    if (button && button.element.parentElement !== controls) {
      button.destroy();
      button = undefined;
      buttonStatus = undefined;
    }

    if (controls) {
      const nextButtonStatus = statusFor(enabled, player);
      if (button) {
        updateButtonStatus(nextButtonStatus);
      } else {
        button = mountYoutubeSubtitlePlayerButton({
          controls,
          status: nextButtonStatus,
          onToggle: () => {
            void enqueueOperation(toggleEnabled);
          },
        });
        buttonStatus = nextButtonStatus;
      }
    } else if (button) {
      button.destroy();
      button = undefined;
      buttonStatus = undefined;
    }

    if (overlay && overlay.element.parentElement !== player) {
      overlay.destroy();
      overlay = undefined;
    }

    if (enabled && player) {
      overlay = mountYoutubeSubtitleOverlay({ player });
      updateButtonStatus("enabled");
    } else {
      overlay?.destroy();
      overlay = undefined;
      updateButtonStatus(statusFor(enabled, player));
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (!preferences) {
      return;
    }

    if (preferences.youtubeEnabled) {
      preferences = { ...preferences, youtubeEnabled: false };
      await dependencies.subtitlePreferences.save(preferences);
      await stop("userDisabled");
      await reconcile();
      return;
    }

    preferences = { ...preferences, youtubeEnabled: true };
    await dependencies.subtitlePreferences.save(preferences);
    stopped = false;
    advanceSession();
    await reconcile();
  }

  function ensureObserver(): void {
    if (observer) {
      return;
    }

    observer = createObserver(() => {
      queueReconcile();
    });
    observer.observe(rootDocument.body ?? rootDocument.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function queueReconcile(): void {
    if (reconcileQueued || destroyed) {
      return;
    }
    reconcileQueued = true;
    queueMicrotask(() => {
      reconcileQueued = false;
      void enqueueOperation(reconcile);
    });
  }

  function enqueueOperation(operation: () => Promise<void>): Promise<void> {
    operationQueue = operationQueue.then(operation, operation);
    return operationQueue;
  }

  function advanceSession(): void {
    sessionIndex += 1;
    configVersion += 1;
    scheduler = createScheduler(preferences);
    sessionCache = new SubtitleSessionCache();
  }

  function updateButtonStatus(status: YoutubeSubtitlePlayerButtonStatus): void {
    if (!button || buttonStatus === status) {
      return;
    }
    button.update({ status });
    buttonStatus = status;
  }

  return {
    start,
    stop,
    destroy,
    getState: () => ({
      started,
      enabled: (preferences?.youtubeEnabled ?? false) && !stopped,
      runtimeSessionId: currentRuntimeSessionId(),
      configVersion,
      videoKey,
    }),
  };

  function currentRuntimeSessionId(): string {
    return `${SESSION_ID_PREFIX}-${sessionIndex}`;
  }
}

function createScheduler(
  preferences: SubtitlePreferences | undefined,
): SubtitleScheduler {
  return new SubtitleScheduler({
    ...defaultSubtitleSchedulerOptions,
    prefetchBeforeMs:
      preferences?.prefetchBeforeMs ?? defaultSubtitleSchedulerOptions.prefetchBeforeMs,
    prefetchAfterMs:
      preferences?.prefetchAfterMs ?? defaultSubtitleSchedulerOptions.prefetchAfterMs,
    maxRetryCount:
      preferences?.maxRetryCount ?? defaultSubtitleSchedulerOptions.maxRetryCount,
  });
}

function findPlayer(rootDocument: Document): HTMLElement | null {
  return rootDocument.querySelector<HTMLElement>(PLAYER_SELECTOR);
}

function findControls(player: HTMLElement | null): HTMLElement | null {
  return player?.querySelector<HTMLElement>(CONTROLS_SELECTOR) ?? null;
}

function statusFor(
  enabled: boolean,
  player: HTMLElement | null,
): YoutubeSubtitlePlayerButtonStatus {
  if (!enabled) {
    return "disabled";
  }
  return player ? "enabled" : "warning";
}

function readVideoKey(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.endsWith("youtube.com")) {
      return parsedUrl.searchParams.get("v") ?? parsedUrl.pathname;
    }
    return `${parsedUrl.hostname}${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return url;
  }
}
