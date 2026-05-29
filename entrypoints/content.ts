import {
  applyTranslationResults,
  collectSegments,
  collectSummarySource,
  estimatePage,
  getPageRuntimeState,
  handleTaskProgress,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
  finalizeLazyRecoverySourceLanguage,
} from "@/content/pageRuntime";
import { showSelectionTranslation } from "@/content/selectionPanel";
import { showPageSummary } from "@/content/summaryPanel";
import {
  getSiteRuleBlockReason,
  isUrlBlockedBySiteRules,
} from "@/content/siteRules";
import {
  createYouTubeSubtitleRuntime,
  type YouTubeCaptionPayloadResult,
} from "@/content/youtubeSubtitle/runtime";
import {
  buildTrackKey,
  selectCaptionTrack,
  type YouTubeCaptionTrack,
} from "@/content/youtubeSubtitle/trackSelection";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
} from "@/messaging/contracts";
import {
  addRuntimeMessageListener,
  sendRuntimeMessage,
} from "@/messaging/runtime";
import { createStorageRepositories } from "@/storage/repositories";
import { storageKeys } from "@/storage/storageKeys";

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContentError(message: string): ContentResponse {
  return { type: "contentError", message };
}

function isRuntimeMessage(message: unknown): message is { type?: unknown } {
  return typeof message === "object" && message !== null;
}

function isYouTubeHost(hostname: string): boolean {
  return hostname === "youtube.com" || hostname === "www.youtube.com";
}

function isYouTubeSubtitleFixture(location: Location): boolean {
  const fixtureHostnames = new Set(["localhost", "127.0.0.1"]);
  const url = new URL(location.href);
  return (
    fixtureHostnames.has(url.hostname) &&
    url.searchParams.get("yoyoSubtitleFixture") === "1"
  );
}

function isYouTubeVideoPage(location: Location): boolean {
  if (isYouTubeSubtitleFixture(location)) {
    return true;
  }
  if (!isYouTubeHost(location.hostname)) {
    return false;
  }

  return (
    (location.pathname === "/watch" && new URL(location.href).searchParams.has("v")) ||
    /^\/shorts\/[^/]+/.test(location.pathname) ||
    /^\/embed\/[^/]+/.test(location.pathname)
  );
}

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

function isYouTubeSubtitleConfigChange(
  changes: StorageChanges,
  areaName: string,
): boolean {
  const relevantKeys =
    areaName === "local"
      ? [storageKeys.providerProfiles, storageKeys.activeProviderId, storageKeys.siteRules]
      : areaName === "sync"
        ? [storageKeys.translationPreferences, storageKeys.subtitlePreferences]
        : [];

  return relevantKeys.some((key) => key in changes);
}

type YouTubePlayerResponse = {
  videoDetails?: {
    videoId?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
};

type YouTubePlayerElement = HTMLElement & {
  getPlayerResponse?: () => unknown;
  getOption?: (module: string, option: string) => unknown;
};

type CaptionTrackPreference = {
  languageCode?: string;
  kind?: string | null;
  vssId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findYouTubePlayer(): YouTubePlayerElement | null {
  return document.querySelector<YouTubePlayerElement>("#movie_player");
}

function readVideoKeyFromLocation(location: Location): string {
  const url = new URL(location.href);
  if (url.pathname === "/watch") {
    return url.searchParams.get("v") ?? url.pathname;
  }
  const pathMatch = url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/);
  return pathMatch?.[1] ?? url.pathname;
}

function isMatchingPlayerResponse(
  response: YouTubePlayerResponse,
  videoKey: string,
): boolean {
  const responseVideoId = response.videoDetails?.videoId;
  return !responseVideoId || responseVideoId === videoKey;
}

function toPlayerResponse(value: unknown): YouTubePlayerResponse | undefined {
  return isRecord(value) ? (value as YouTubePlayerResponse) : undefined;
}

function readCurrentPlayerResponse(videoKey: string): YouTubePlayerResponse | undefined {
  const playerResponse = toPlayerResponse(findYouTubePlayer()?.getPlayerResponse?.());
  if (playerResponse && isMatchingPlayerResponse(playerResponse, videoKey)) {
    return playerResponse;
  }

  return readInitialPlayerResponse(videoKey);
}

function readInitialPlayerResponse(videoKey: string): YouTubePlayerResponse | undefined {
  const pageWindow = window as typeof window & {
    ytInitialPlayerResponse?: YouTubePlayerResponse;
  };
  if (
    pageWindow.ytInitialPlayerResponse &&
    isMatchingPlayerResponse(pageWindow.ytInitialPlayerResponse, videoKey)
  ) {
    return pageWindow.ytInitialPlayerResponse;
  }

  for (const script of document.scripts) {
    const text = script.textContent ?? "";
    const marker = "ytInitialPlayerResponse";
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }
    const objectStart = text.indexOf("{", markerIndex);
    if (objectStart < 0) {
      continue;
    }
    const objectText = extractJsonObject(text, objectStart);
    if (!objectText) {
      continue;
    }
    try {
      const parsed = JSON.parse(objectText) as YouTubePlayerResponse;
      if (isMatchingPlayerResponse(parsed, videoKey)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function readActiveCaptionTrackPreference(): CaptionTrackPreference {
  const activeTrack = findYouTubePlayer()?.getOption?.("captions", "track");
  if (!isRecord(activeTrack)) {
    return {};
  }

  return {
    languageCode:
      typeof activeTrack.languageCode === "string"
        ? activeTrack.languageCode
        : undefined,
    kind:
      typeof activeTrack.kind === "string"
        ? activeTrack.kind || null
        : undefined,
    vssId: typeof activeTrack.vssId === "string" ? activeTrack.vssId : undefined,
  };
}

function readCurrentCaptionTrack(videoKey: string): YouTubeCaptionTrack | undefined {
  const tracks =
    readCurrentPlayerResponse(videoKey)?.captions?.playerCaptionsTracklistRenderer
      ?.captionTracks ?? [];
  return selectCaptionTrack(tracks, readActiveCaptionTrackPreference());
}

function extractJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

async function fetchYoutubeCaptionPayload(
  request?: { videoKey: string },
): Promise<
  YouTubeCaptionPayloadResult | undefined
> {
  if (isYouTubeSubtitleFixture(window.location)) {
    const url = new URL("/api/timedtext", window.location.href);
    return {
      payload: await fetch(url).then((response) => response.json()),
      track: {
        languageCode: "en",
        kind: "asr",
        name: "Fixture English",
        baseUrl: url.toString(),
      },
      sourceLanguage: { kind: "known", code: "en" },
    };
  }

  const track = readCurrentCaptionTrack(
    request?.videoKey ?? readVideoKeyFromLocation(window.location),
  );
  if (!track?.baseUrl) {
    return undefined;
  }

  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  return {
    payload: await fetch(url).then((response) => response.json()),
    track: { ...track, baseUrl: url.toString() },
    sourceLanguage: track.languageCode
      ? { kind: "known", code: track.languageCode }
      : { kind: "unknown" },
  };
}

async function getYoutubeCaptionTrackKey(request: {
  videoKey: string;
}): Promise<string | undefined> {
  const track = readCurrentCaptionTrack(request.videoKey);
  return track ? buildTrackKey(request.videoKey, track) : undefined;
}

function installYouTubeSubtitleRuntimeManager(input?: {
  shouldBlockCurrentSite?: () => Promise<boolean>;
}): void {
  const repositories = createStorageRepositories();
  const shouldBlockCurrentSite = input?.shouldBlockCurrentSite ?? (async () => false);
  let youtubeSubtitleRuntime: ReturnType<typeof createYouTubeSubtitleRuntime> | undefined;

  const handleSubtitleConfigStorageChange = (
    changes: StorageChanges,
    areaName: string,
  ): void => {
    if (isYouTubeSubtitleConfigChange(changes, areaName)) {
      void ensureRuntime();
    }
  };

  async function stopRuntime(): Promise<void> {
    const runtime = youtubeSubtitleRuntime;
    youtubeSubtitleRuntime = undefined;
    await runtime?.destroy();
  }

  async function ensureRuntime(): Promise<void> {
    if (!isYouTubeVideoPage(window.location)) {
      await stopRuntime();
      return;
    }

    if (await shouldBlockCurrentSite()) {
      await stopRuntime();
      return;
    }

    if (youtubeSubtitleRuntime) {
      await youtubeSubtitleRuntime.handleConfigChanged();
      return;
    }

    youtubeSubtitleRuntime = createYouTubeSubtitleRuntime({
      subtitlePreferences: repositories.subtitlePreferences,
      sendBackgroundMessage: (message) =>
        sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message),
      fetchCaptionPayload: fetchYoutubeCaptionPayload,
      getCaptionTrackKey: getYoutubeCaptionTrackKey,
    });
    await youtubeSubtitleRuntime.start();
  }

  const notifyLocationChanged = (): void => {
    window.dispatchEvent(new Event("yoyo:locationchange"));
  };
  const handleLocationChanged = (): void => {
    void ensureRuntime();
  };
  const patchHistoryMethod = (method: "pushState" | "replaceState"): void => {
    const original = window.history[method];
    window.history[method] = function patchedHistoryMethod(
      ...args: Parameters<typeof original>
    ) {
      const result = original.apply(this, args);
      queueMicrotask(notifyLocationChanged);
      return result;
    };
  };

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", notifyLocationChanged);
  window.addEventListener("yoyo:locationchange", handleLocationChanged);
  browser.storage.onChanged.addListener(handleSubtitleConfigStorageChange);

  const handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      void ensureRuntime();
    }
  };
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      return;
    }
    browser.storage.onChanged.removeListener(handleSubtitleConfigStorageChange);
    window.removeEventListener("popstate", notifyLocationChanged);
    window.removeEventListener("yoyo:locationchange", handleLocationChanged);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("pagehide", handlePageHide);
    void stopRuntime();
  };

  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("pagehide", handlePageHide);

  void ensureRuntime();
}

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.info("[yoyo] content script ready");
    const repositories = createStorageRepositories();

    async function isCurrentSiteBlocked(): Promise<boolean> {
      const rules = await repositories.siteRules.get();
      return isUrlBlockedBySiteRules(window.location.href, rules);
    }

    async function assertCurrentSiteAllowed(): Promise<void> {
      if (await isCurrentSiteBlocked()) {
        throw new Error(getSiteRuleBlockReason());
      }
    }

    if (isYouTubeHost(window.location.hostname) || isYouTubeSubtitleFixture(window.location)) {
      installYouTubeSubtitleRuntimeManager({
        shouldBlockCurrentSite: isCurrentSiteBlocked,
      });
    }

    addRuntimeMessageListener<unknown, ContentResponse>(
      async (message) => {
        if (!isRuntimeMessage(message)) {
          return createContentError("Unsupported content message.");
        }

        switch (message.type) {
          case "estimatePage":
            if (await isCurrentSiteBlocked()) {
              return {
                type: "estimatePageResult",
                estimate: {
                  canTranslate: false,
                  estimatedSegments: 0,
                  estimatedChars: 0,
                  reason: getSiteRuleBlockReason(),
                },
              };
            }
            return {
              type: "estimatePageResult",
              estimate: await estimatePage(),
            };
          case "collectSegments": {
            await assertCurrentSiteAllowed();
            const request = message as Extract<
              ContentRequest,
              { type: "collectSegments" }
            >;
            const segments = await collectSegments(
              request.taskId,
              request.translationMode,
              request.sourceLanguage,
              request.targetLanguage,
              request.providerId,
              request.textModel,
              request.deferLazyCollection,
            );
            return {
              type: "collectSegmentsResult",
              taskId: request.taskId,
              segments,
              collectionComplete: request.translationMode !== "lazyViewport",
            };
          }
          case "finalizeLazyRecoverySourceLanguage": {
            const request = message as Extract<
              ContentRequest,
              { type: "finalizeLazyRecoverySourceLanguage" }
            >;
            const success = finalizeLazyRecoverySourceLanguage(
              request.taskId,
              request.sourceLanguage,
            );
            return { type: "contentActionResult", success };
          }
          case "applyTranslations": {
            const request = message as Extract<
              ContentRequest,
              { type: "applyTranslations" }
            >;
            const result = applyTranslationResults(request.taskId, request.items);
            return {
              type: "contentActionResult",
              success: result.failedSegmentIds.length === 0,
              ...result,
            };
          }
          case "hideTranslations": {
            const request = message as Extract<
              ContentRequest,
              { type: "hideTranslations" }
            >;
            hidePageTranslations(request.taskId);
            return { type: "contentActionResult", success: true };
          }
          case "showTranslations": {
            const request = message as Extract<
              ContentRequest,
              { type: "showTranslations" }
            >;
            showPageTranslations(request.taskId);
            return { type: "contentActionResult", success: true };
          }
          case "removeTranslations": {
            const request = message as Extract<
              ContentRequest,
              { type: "removeTranslations" }
            >;
            removePageTranslations(request.taskId);
            return { type: "contentActionResult", success: true };
          }
          case "getPageRuntimeState":
            return {
              type: "pageRuntimeState",
              ...getPageRuntimeState(),
            };
          case "collectSummarySource":
            await assertCurrentSiteAllowed();
            return {
              type: "summarySourceResult",
              ...(await collectSummarySource()),
            };
          case "taskProgress": {
            const request = message as Extract<
              ContentRequest,
              { type: "taskProgress" }
            >;
            handleTaskProgress(request.progress);
            return { type: "contentActionResult", success: true };
          }
          case "showSelectionTranslation": {
            const request = message as Extract<
              ContentRequest,
              { type: "showSelectionTranslation" }
            >;
            showSelectionTranslation(request, {
              sendBackgroundMessage: (backgroundMessage) =>
                sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(
                  backgroundMessage,
                ),
            });
            return { type: "contentActionResult", success: true };
          }
          case "showPageSummary": {
            const request = message as Extract<
              ContentRequest,
              { type: "showPageSummary" }
            >;
            showPageSummary(request);
            return { type: "contentActionResult", success: true };
          }
          default:
            return createContentError("Unsupported content message.");
        }
      },
      {
        createErrorResponse: (error) => createContentError(normalizeError(error)),
      },
    );
  },
});
