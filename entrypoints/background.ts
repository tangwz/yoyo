import { onTranslatePageMenuClick, registerContextMenus } from "@/background/contextMenu";
import { notifyPageCannotTranslate, notifyProviderMissing } from "@/background/notifications";
import {
  buildProviderStatusResponse,
  getStoredProviderState,
  selectReadyProviderProfile,
} from "@/background/providerStatus";
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

  async function loadStoredProviderState(): Promise<{
    activeProviderId: string | undefined;
    profiles: ProviderProfile[];
  }> {
    return getStoredProviderState({
      loadActiveProviderId: () => storage.providers.getActiveProviderId(),
      loadProfiles: listProfiles,
      persistActiveProviderId: (activeProviderId) =>
        storage.providers.setActiveProviderId(activeProviderId),
    });
  }

  async function getActiveProfile(): Promise<ProviderProfile | undefined> {
    const { activeProviderId, profiles } = await loadStoredProviderState();

    return selectReadyProviderProfile(profiles, activeProviderId);
  }

  async function getProviderProfile(providerId: string): Promise<ProviderProfile | undefined> {
    return selectReadyProviderProfile(await listProfiles(), providerId);
  }

  const orchestrator = new TranslationTaskOrchestrator({
    getActiveProfile,
    getProviderProfile,
    provider,
    sendToContent: (tabId, message) =>
      sendTabMessage<ContentRequest, ContentResponse>(tabId, message),
    emitProgress: (progress, tabId) => {
      void browser.runtime.sendMessage({ type: "taskProgress", progress });
      void sendTabMessage<ContentRequest, ContentResponse>(tabId, {
        type: "taskProgress",
        progress,
      }).catch(() => undefined);
    },
    now: () => Date.now(),
    createTaskId,
  });

  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });

  onTranslatePageMenuClick(
    async (tabId) => {
      if (!(await getActiveProfile())) {
        await notifyProviderMissing();
        return;
      }

      const progress = await orchestrator.translatePage({
        tabId,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        translationMode: (await storage.translationPreferences.get()).mode,
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
    async (request, sender) => {
      switch (request.type) {
        case "translatePage": {
          const preferences = await storage.translationPreferences.get();
          const progress = orchestrator.startTranslatePage({
            tabId: request.tabId,
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            translationMode: preferences.mode,
          });
          return { type: "taskProgress", progress };
        }
        case "enqueueLazySegments": {
          const tabId = sender.tab?.id;
          return {
            type: "taskProgress",
            progress: await orchestrator.enqueueLazySegments(
              request.taskId,
              request.segmentIds,
              request.failedSegmentIds,
              request.recovery && tabId !== undefined
                ? { ...request.recovery, tabId }
                : undefined,
            ),
          };
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
        case "getProviderStatus": {
          const { activeProviderId, profiles } = await loadStoredProviderState();
          return buildProviderStatusResponse(profiles, activeProviderId);
        }
        case "openOptions":
          await openOptionsPage({
            section: request.section,
            source: request.source,
          });
          return { type: "backgroundActionResult", success: true };
        default:
          return { type: "backgroundError", message: "Unknown background message." };
      }
    },
    { createErrorResponse },
  );

  console.info("[yoyo] background ready");
});
