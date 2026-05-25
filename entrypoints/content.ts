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
import { createYouTubeSubtitleRuntime } from "@/content/youtubeSubtitle/runtime";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import {
  addRuntimeMessageListener,
  sendRuntimeMessage,
} from "@/messaging/runtime";
import { createStorageRepositories } from "@/storage/repositories";

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

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.info("[yoyo] content script ready");

    if (isYouTubeHost(window.location.hostname)) {
      const repositories = createStorageRepositories();
      const youtubeSubtitleRuntime = createYouTubeSubtitleRuntime({
        subtitlePreferences: repositories.subtitlePreferences,
        sendBackgroundMessage: sendRuntimeMessage,
      });

      void youtubeSubtitleRuntime.start();
      window.addEventListener("pagehide", () => {
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
