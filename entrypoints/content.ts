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

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.info("[yoyo] content script ready");

    addRuntimeMessageListener<ContentRequest, ContentResponse>(
      async (message) => {
        switch (message.type) {
          case "estimatePage":
            return {
              type: "estimatePageResult",
              estimate: await estimatePage(),
            };
          case "collectSegments":
            return {
              type: "collectSegmentsResult",
              taskId: message.taskId,
              segments: await collectSegments(message.taskId),
            };
          case "applyTranslations":
            applyTranslationResults(message.taskId, message.items);
            return { type: "contentActionResult", success: true };
          case "hideTranslations":
            hidePageTranslations(message.taskId);
            return { type: "contentActionResult", success: true };
          case "showTranslations":
            showPageTranslations(message.taskId);
            return { type: "contentActionResult", success: true };
          case "removeTranslations":
            removePageTranslations(message.taskId);
            return { type: "contentActionResult", success: true };
          case "getPageRuntimeState":
            return {
              type: "pageRuntimeState",
              ...getPageRuntimeState(),
            };
        }
      },
    );
  },
});
