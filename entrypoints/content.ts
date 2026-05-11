import {
  applyTranslationResults,
  collectSegments,
  estimatePage,
  getPageRuntimeState,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
} from "@/content/pageRuntime";
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { addRuntimeMessageListener } from "@/messaging/runtime";

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContentError(message: string): ContentResponse {
  return { type: "contentError", message };
}

function isRuntimeMessage(message: unknown): message is { type?: unknown } {
  return typeof message === "object" && message !== null;
}

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.info("[yoyo] content script ready");

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
            );
            return {
              type: "collectSegmentsResult",
              taskId: request.taskId,
              segments,
              collectionComplete: request.translationMode !== "lazyViewport",
            };
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
