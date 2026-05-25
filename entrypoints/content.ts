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
  createYouTubeSubtitleRuntime,
  type YouTubeCaptionPayloadResult,
} from "@/content/youtubeSubtitle/runtime";
import {
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

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

function isYouTubeSubtitleConfigChange(
  changes: StorageChanges,
  areaName: string,
): boolean {
  const relevantKeys =
    areaName === "local"
      ? [storageKeys.providerProfiles, storageKeys.activeProviderId]
      : areaName === "sync"
        ? [storageKeys.translationPreferences, storageKeys.subtitlePreferences]
        : [];

  return relevantKeys.some((key) => key in changes);
}

type YouTubePlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
};

function readInitialPlayerResponse(): YouTubePlayerResponse | undefined {
  const pageWindow = window as typeof window & {
    ytInitialPlayerResponse?: YouTubePlayerResponse;
  };
  if (pageWindow.ytInitialPlayerResponse) {
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
      return JSON.parse(objectText) as YouTubePlayerResponse;
    } catch {
      continue;
    }
  }

  return undefined;
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

async function fetchYoutubeCaptionPayload(): Promise<
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

  const tracks =
    readInitialPlayerResponse()?.captions?.playerCaptionsTracklistRenderer
      ?.captionTracks ?? [];
  const track = selectCaptionTrack(tracks);
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

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.info("[yoyo] content script ready");

    if (
      isYouTubeHost(window.location.hostname) ||
      isYouTubeSubtitleFixture(window.location)
    ) {
      const repositories = createStorageRepositories();
      const youtubeSubtitleRuntime = createYouTubeSubtitleRuntime({
        subtitlePreferences: repositories.subtitlePreferences,
        sendBackgroundMessage: (message) =>
          sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message),
        fetchCaptionPayload: fetchYoutubeCaptionPayload,
      });

      const handleSubtitleConfigStorageChange = (
        changes: StorageChanges,
        areaName: string,
      ): void => {
        if (isYouTubeSubtitleConfigChange(changes, areaName)) {
          void youtubeSubtitleRuntime.handleConfigChanged();
        }
      };

      void youtubeSubtitleRuntime.start();
      browser.storage.onChanged.addListener(handleSubtitleConfigStorageChange);
      window.addEventListener("pagehide", () => {
        browser.storage.onChanged.removeListener(handleSubtitleConfigStorageChange);
        void youtubeSubtitleRuntime.destroy();
      });
    }

    addRuntimeMessageListener<unknown, ContentResponse>(
      async (message) => {
        if (!isRuntimeMessage(message)) {
          return createContentError("Unsupported content message.");
        }

        switch (message.type) {
          case "estimatePage":
            return {
              type: "estimatePageResult",
              estimate: await estimatePage(),
            };
          case "collectSegments": {
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
            showSelectionTranslation(request);
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
