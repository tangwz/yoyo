import {
  onSummarizePageMenuClick,
  onTranslatePageMenuClick,
  onTranslateSelectionMenuClick,
  getContextMenuUiLanguageForPreferenceChange,
  registerContextMenus,
} from "@/background/contextMenu";
import {
  handleSummarizePageMenuClick,
  handleTranslatePageMenuClick,
  handleTranslateSelectionMenuClick,
} from "@/background/contextMenuActions";
import { buildContentStorageChangeMessages } from "@/background/contentStorageSignals";
import { notifyPageCannotTranslate, notifyProviderMissing } from "@/background/notifications";
import { summarizePage } from "@/background/pageSummary";
import {
  buildProviderStatusResponse,
  getStoredProviderState,
  selectReadyProviderProfile,
} from "@/background/providerStatus";
import {
  buildSelectionTranslationConfig,
  translateSelection,
} from "@/background/selectionTranslation";
import { createAiSubtitleSegmentationService } from "@/background/youtubeSubtitle/aiSegmentation";
import { createSubtitleTranslationService } from "@/background/youtubeSubtitle/service";
import { TranslationTaskOrchestrator } from "@/background/taskOrchestrator";
import { openOptionsPage } from "@/browser/browserApi";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
} from "@/messaging/contracts";
import { addRuntimeMessageListener, sendTabMessage } from "@/messaging/runtime";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { ChromeBuiltInAiOffscreenClient } from "@/provider/chromeBuiltInAiOffscreenClient";
import { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import { OpenAiSummaryAdapter } from "@/provider/openAiSummaryAdapter";
import { TranslationProviderResolver } from "@/provider/resolver";
import type { ProviderProfile } from "@/provider/types";
import { createStorageRepositories } from "@/storage/repositories";
import { storageKeys } from "@/storage/storageKeys";
import { isUrlBlockedBySiteRules } from "@/siteRules/matching";

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
  const summaryProvider = new OpenAiSummaryAdapter(provider);
  let chromeBuiltInAiOffscreenClient: ChromeBuiltInAiOffscreenClient | undefined;
  const translationProviderResolver = new TranslationProviderResolver({
    openAiProvider: provider,
    chromeBuiltInTranslatorProvider: new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => {
        chromeBuiltInAiOffscreenClient ??= new ChromeBuiltInAiOffscreenClient();
        return chromeBuiltInAiOffscreenClient;
      },
    }),
  });

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

  async function getStoredTargetLanguage(): Promise<string> {
    return (await storage.translationPreferences.get()).targetLanguage;
  }

  async function getSelectionProviderId(): Promise<string | undefined> {
    return (await storage.selectionTranslationPreferences.get()).providerId;
  }

  async function getStoredTranslationMode() {
    return (await storage.translationPreferences.get()).mode;
  }

  async function isPageUrlBlocked(pageUrl: string): Promise<boolean> {
    return isUrlBlockedBySiteRules(pageUrl, await storage.siteRules.get());
  }

  async function getSubtitleRuntimeConfig(): Promise<BackgroundResponse> {
    const [targetLanguage, profile] = await Promise.all([
      getStoredTargetLanguage(),
      getActiveProfile(),
    ]);

    if (!profile) {
      return {
        type: "subtitleRuntimeConfig",
        configured: false,
        targetLanguage,
        message: "No translation provider is configured.",
      };
    }

    return {
      type: "subtitleRuntimeConfig",
      configured: true,
      providerId: profile.id,
      modelKey:
        profile.type === "openai-compatible" ? profile.textModel : profile.id,
      targetLanguage,
    };
  }

  async function getProviderProfile(providerId: string): Promise<ProviderProfile | undefined> {
    return selectReadyProviderProfile(await listProfiles(), providerId);
  }

  function getChromeBuiltInAiOffscreenClient(): ChromeBuiltInAiOffscreenClient {
    chromeBuiltInAiOffscreenClient ??= new ChromeBuiltInAiOffscreenClient();
    return chromeBuiltInAiOffscreenClient;
  }

  function registerStoredContextMenus(): void {
    void storage.uiPreferences
      .get()
      .then((preferences) => {
        registerContextMenus(preferences.uiLanguage);
      })
      .catch((error: unknown) => {
        console.error("[yoyo] failed to load UI language for context menus", {
          error,
        });
        registerContextMenus();
      });
  }

  function broadcastContentMessages(messages: ContentRequest[]): void {
    if (messages.length === 0) {
      return;
    }

    void browser.tabs
      .query({})
      .then((tabs) => {
        for (const tab of tabs) {
          if (tab.id === undefined) {
            continue;
          }

          for (const message of messages) {
            void sendTabMessage<ContentRequest, ContentResponse>(
              tab.id,
              message,
            ).catch(() => undefined);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("[yoyo] failed to broadcast content storage change", {
          error,
        });
      });
  }

  async function prepareChromeBuiltInAi(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<void> {
    const translator = await getChromeBuiltInAiOffscreenClient().create({
      sourceLanguage,
      targetLanguage,
    });
    await translator.destroy?.();
  }

  const orchestrator = new TranslationTaskOrchestrator({
    getActiveProfile,
    getProviderProfile,
    getTranslationProvider: (profile) =>
      translationProviderResolver.getTranslationProvider(profile),
    detectSourceLanguage: (text, signal) =>
      getChromeBuiltInAiOffscreenClient().detectLanguage(text, signal),
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
  const subtitleTranslationService = createSubtitleTranslationService({
    getActiveProfile,
    getProviderProfile,
    getTranslationProvider: (profile) =>
      translationProviderResolver.getTranslationProvider(profile),
    detectSourceLanguage: (text, signal) =>
      getChromeBuiltInAiOffscreenClient().detectLanguage(text, signal),
  });
  const aiSubtitleSegmentationService = createAiSubtitleSegmentationService({
    getActiveProfile,
    getProviderProfile,
    generateText: (request) => provider.generateText(request),
  });

  browser.runtime.onInstalled.addListener(() => {
    registerStoredContextMenus();
  });

  browser.runtime.onStartup.addListener(() => {
    registerStoredContextMenus();
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    broadcastContentMessages(buildContentStorageChangeMessages(changes, areaName));

    if (areaName === "sync" && storageKeys.uiPreferences in changes) {
      registerContextMenus(
        getContextMenuUiLanguageForPreferenceChange(
          changes[storageKeys.uiPreferences]?.newValue,
        ),
      );
    }
  });

  onTranslatePageMenuClick(
    async (tabId) => {
      await handleTranslatePageMenuClick(tabId, {
        getActiveProfile,
        getStoredTargetLanguage,
        getStoredTranslationMode,
        notifyPageCannotTranslate,
        notifyProviderMissing,
        translatePage: (input) => orchestrator.translatePage(input),
      });
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

  onTranslateSelectionMenuClick(
    async (input) => {
      await handleTranslateSelectionMenuClick(input, {
        getStoredTargetLanguage,
        translateSelection: (request) =>
          translateSelection(request, {
            getProviderState: loadStoredProviderState,
            getSelectionProviderId,
            getTranslationProvider: (profile) =>
              translationProviderResolver.getTranslationProvider(profile),
            detectSourceLanguage: (sourceText) =>
              getChromeBuiltInAiOffscreenClient().detectLanguage(sourceText),
            prepareChromeBuiltInAi,
            isPageBlocked: isPageUrlBlocked,
            sendToContent: (targetTabId, message) =>
              sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
          }),
      });
    },
    (error, tabId) => {
      console.error("[yoyo] failed to handle translate selection menu click", {
        tabId,
        error,
      });
    },
  );

  onSummarizePageMenuClick(
    async (tabId) => {
      await handleSummarizePageMenuClick(tabId, {
        getStoredTargetLanguage,
        notifyPageCannotSummarize: notifyPageCannotTranslate,
        summarizePage: (input) =>
          summarizePage(input, {
            getActiveProfile,
            getSummaryProvider: () => summaryProvider,
            sendToContent: (targetTabId, message) =>
              sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
          }),
      });
    },
    (error, tabId) => {
      console.error("[yoyo] failed to handle summarize page menu click", {
        tabId,
        error,
      });
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
        case "enqueueTranslationBatch": {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            return {
              type: "backgroundError",
              message: "Cannot enqueue translation batch without a sender tab id.",
            };
          }

          return {
            type: "taskProgress",
            progress: await orchestrator.enqueueTranslationBatch({
              tabId,
              taskId: request.taskId,
              sourceLanguage: request.sourceLanguage,
              targetLanguage: request.targetLanguage,
              translationMode: request.translationMode,
              segments: request.segments,
              collectionComplete: request.collectionComplete,
              failedSegmentIds: request.failedSegmentIds,
              recovery: request.recovery,
            }),
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
        case "getSubtitleRuntimeConfig":
          return getSubtitleRuntimeConfig();
        case "translateSelection":
          await translateSelection(
            {
              ...request,
              pageUrl: request.pageUrl ?? sender.tab?.url ?? sender.url,
            },
            {
              isPageBlocked: isPageUrlBlocked,
              getProviderState: loadStoredProviderState,
              getSelectionProviderId,
              getTranslationProvider: (profile) =>
                translationProviderResolver.getTranslationProvider(profile),
              detectSourceLanguage: (sourceText) =>
                getChromeBuiltInAiOffscreenClient().detectLanguage(sourceText),
              prepareChromeBuiltInAi,
              sendToContent: (targetTabId, message) =>
                sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
            },
          );
          return { type: "backgroundActionResult", success: true };
        case "getSelectionTranslationConfig": {
          const [targetLanguage, providerState, savedProviderId] = await Promise.all([
            getStoredTargetLanguage(),
            loadStoredProviderState(),
            getSelectionProviderId(),
          ]);

          return buildSelectionTranslationConfig({
            providerState,
            savedProviderId,
            targetLanguage,
          });
        }
        case "setSelectionTranslationProvider":
          await storage.selectionTranslationPreferences.save({
            providerId: request.providerId,
          });
          return { type: "backgroundActionResult", success: true };
        case "translateSelectionWithProvider": {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            return {
              type: "selectionTranslationError",
              requestId: request.requestId,
              providerId: request.providerId,
              message: "Cannot translate selection without a sender tab id.",
            };
          }

          let latestMessage:
            | Extract<ContentRequest, { type: "showSelectionTranslation" }>
            | undefined;
          await translateSelection(
            {
              tabId,
              requestId: request.requestId,
              providerId: request.providerId,
              pageUrl: sender.tab?.url ?? sender.url,
              text: request.text,
              sourceLanguage: request.sourceLanguage,
              targetLanguage: request.targetLanguage,
            },
            {
              isPageBlocked: isPageUrlBlocked,
              getProviderState: loadStoredProviderState,
              getSelectionProviderId,
              getTranslationProvider: (profile) =>
                translationProviderResolver.getTranslationProvider(profile),
              detectSourceLanguage: (sourceText) =>
                getChromeBuiltInAiOffscreenClient().detectLanguage(sourceText),
              prepareChromeBuiltInAi,
              sendToContent: async (_targetTabId, message) => {
                if (message.type === "showSelectionTranslation") {
                  latestMessage = message;
                }

                return { type: "contentActionResult", success: true };
              },
            },
          );

          if (latestMessage?.state === "translated") {
            return {
              type: "selectionTranslationResult",
              requestId: latestMessage.requestId,
              providerId: latestMessage.selectedProviderId ?? request.providerId,
              translatedText: latestMessage.translatedText,
            };
          }

          return {
            type: "selectionTranslationError",
            requestId: request.requestId,
            providerId: latestMessage?.selectedProviderId ?? request.providerId,
            message:
              latestMessage?.state === "failed"
                ? latestMessage.errorMessage
                : "Selection translation failed.",
          };
        }
        case "summarizePage":
          await summarizePage(request, {
            getActiveProfile,
            getSummaryProvider: () => summaryProvider,
            sendToContent: (targetTabId, message) =>
              sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
          });
          return { type: "backgroundActionResult", success: true };
        case "translateSubtitleBatch":
          return subtitleTranslationService.translateBatch(request);
        case "segmentSubtitleChunk":
          return aiSubtitleSegmentationService.segmentChunk(request);
        case "cancelSubtitleRequests":
          subtitleTranslationService.cancel(request.runtimeSessionId);
          aiSubtitleSegmentationService.cancel(request.runtimeSessionId);
          return { type: "backgroundActionResult", success: true };
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
