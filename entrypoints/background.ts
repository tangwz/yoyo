import { onTranslatePageMenuClick, registerContextMenus } from "@/background/contextMenu";
import { notifyPageCannotTranslate, notifyProviderMissing } from "@/background/notifications";
import { TranslationTaskOrchestrator } from "@/background/taskOrchestrator";
import { openOptionsPage } from "@/browser/browserApi";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
} from "@/messaging/contracts";
import { addRuntimeMessageListener, sendTabMessage } from "@/messaging/runtime";
import { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import type { ProviderProfile } from "@/provider/types";
import { createStorageRepositories } from "@/storage/repositories";

function createTaskId(): string {
  return `task-${Date.now()}-${crypto.randomUUID()}`;
}

function createErrorResponse(error: unknown): BackgroundResponse {
  return {
    type: "backgroundError",
    message: error instanceof Error ? error.message : "Background action failed.",
  };
}

export default defineBackground(() => {
  const storage = createStorageRepositories();
  const provider = new OpenAiCompatibleProvider();

  async function listProfiles(): Promise<ProviderProfile[]> {
    return storage.providers.listProfiles();
  }

  async function getActiveProfile(): Promise<ProviderProfile | undefined> {
    const [activeProviderId, profiles] = await Promise.all([
      storage.providers.getActiveProviderId(),
      listProfiles(),
    ]);

    if (!activeProviderId) {
      return profiles[0];
    }

    return profiles.find((profile) => profile.id === activeProviderId) ?? profiles[0];
  }

  const orchestrator = new TranslationTaskOrchestrator({
    getActiveProfile,
    provider,
    sendToContent: (tabId, message) =>
      sendTabMessage<ContentRequest, ContentResponse>(tabId, message),
    now: () => Date.now(),
    createTaskId,
  });

  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });

  onTranslatePageMenuClick(
    async (tabId) => {
      if ((await listProfiles()).length === 0) {
        await notifyProviderMissing();
        return;
      }

      const progress = await orchestrator.translatePage({
        tabId,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      });

      if (progress.state === "failed") {
        await notifyPageCannotTranslate(
          progress.errorMessage ?? "The page could not be translated.",
        );
      }
    },
    (error, tabId) => {
      console.error("[yoyo] failed to handle translate page menu click", {
        tabId,
        error,
      });
      void notifyPageCannotTranslate(
        error instanceof Error ? error.message : "The page could not be translated.",
      );
    },
  );

  addRuntimeMessageListener<BackgroundRequest, BackgroundResponse>(
    async (request) => {
      switch (request.type) {
        case "translatePage": {
          const progress = await orchestrator.translatePage({
            tabId: request.tabId,
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
          });
          return { type: "taskProgress", progress };
        }
        case "cancelTask":
          return {
            type: "taskProgress",
            progress: orchestrator.cancelTask(request.taskId, request.reason),
          };
        case "getTaskForTab": {
          const progress = orchestrator.getTaskForTab(request.tabId) ?? {
            taskId: "",
            state: "completed",
            total: 0,
            translated: 0,
            failed: 0,
          };
          return { type: "taskProgress", progress };
        }
        case "openOptions":
          await openOptionsPage();
          return { type: "backgroundActionResult", success: true };
      }
    },
    { createErrorResponse },
  );

  console.info("[yoyo] background ready");
});
