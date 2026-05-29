<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { browser } from "wxt/browser";

import {
  sourceLanguageOptions,
  targetLanguageOptions,
} from "@/i18n/languages";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
} from "@/messaging/contracts";
import type {
  LanguageDetectorApi,
  LanguageDetectorInstance,
  TranslatorApi,
  TranslatorInstance,
} from "@/provider/chromeBuiltInAi";
import { sendRuntimeMessage, sendTabMessage } from "@/messaging/runtime";
import {
  popupMessages,
  type PopupMessageKey,
} from "@/popup/messages";
import {
  defaultTranslationPreferences,
  defaultUiPreferences,
} from "@/storage/defaults";
import { createStorageRepositories } from "@/storage/repositories";
import type { TargetLanguage } from "@/translation/types";
import ErrorSummary from "@/ui/components/ErrorSummary.vue";
import LanguageSelector from "@/ui/components/LanguageSelector.vue";
import PopupFooter from "@/ui/components/PopupFooter.vue";
import ProviderCard from "@/ui/components/ProviderCard.vue";
import TaskProgress from "@/ui/components/TaskProgress.vue";

type PopupState =
  | "idle"
  | "onboarding"
  | "translating"
  | "completed"
  | "existingTranslations"
  | "error";

const sourceLanguage = ref("auto");
const targetLanguage = ref<TargetLanguage>(defaultTranslationPreferences.targetLanguage);
const hasUserEditedTargetLanguage = ref(false);
const uiLanguage = ref(defaultUiPreferences.uiLanguage);
const isApplyingStoredPreferences = ref(false);
const providerLabel = ref("正在读取翻译服务...");
const providerMode = ref<"remote" | "local-only">("remote");
const isProviderConfigured = ref(true);
const hasProviderStatusIssue = ref(false);
const tabId = ref<number>();
const isInitializing = ref(true);
const isSummarizing = ref(false);
const canTranslate = ref(true);
const state = ref<PopupState>("idle");
const currentTaskId = ref("");
const translated = ref(0);
const total = ref(0);
const failed = ref(0);
const errorMessage = ref("");
const pageTranslationsVisible = ref(true);
const extensionVersion = browser.runtime.getManifest().version;
const providerOnboardingAutoOpenKey = "yoyo.providerOnboardingAutoOpened";
let targetLanguageSaveQueue: Promise<void> = Promise.resolve();

type SessionStorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
};

type ChromeBuiltInAiGlobals = typeof globalThis & {
  LanguageDetector?: LanguageDetectorApi;
  Translator?: TranslatorApi;
};

type BrowserTabsWithLanguageDetection = typeof browser.tabs & {
  detectLanguage?: (tabId?: number) => Promise<string>;
};

const primaryLabel = computed(() => {
  if (state.value === "onboarding" || !isProviderConfigured.value) {
    return "打开设置";
  }

  if (state.value === "translating") {
    return "取消翻译";
  }

  if (state.value === "completed" || state.value === "existingTranslations") {
    return "重新翻译";
  }

  return "\u7ffb\u8bd1\u9875\u9762";
});

const isPrimaryDisabled = computed(
  () =>
    isInitializing.value || (!canTranslate.value && state.value !== "translating"),
);
const shouldShowProviderCard = computed(
  () => !isProviderConfigured.value || hasProviderStatusIssue.value,
);
const messages = computed(() => popupMessages[uiLanguage.value] ?? popupMessages["zh-CN"]);
const isSummaryDisabled = computed(
  () =>
    isInitializing.value ||
    isSummarizing.value ||
    !canTranslate.value ||
    !isProviderConfigured.value ||
    hasProviderStatusIssue.value ||
    providerMode.value === "local-only" ||
    tabId.value === undefined,
);

function t(key: PopupMessageKey): string {
  return messages.value[key];
}

function isRuntimeResponse(message: unknown): message is BackgroundResponse {
  return typeof message === "object" && message !== null && "type" in message;
}

function getChromeBuiltInAiGlobals(): ChromeBuiltInAiGlobals {
  return globalThis as ChromeBuiltInAiGlobals;
}

async function destroyPreparedBuiltInAiSession(
  session: LanguageDetectorInstance | TranslatorInstance,
): Promise<void> {
  await session.destroy?.();
}

async function prepareBuiltInAiSession<
  Session extends LanguageDetectorInstance | TranslatorInstance,
>(sessionPromise: Promise<Session>): Promise<void> {
  const session = await sessionPromise;
  await destroyPreparedBuiltInAiSession(session);
}

function normalizeDetectedSourceLanguage(language: string | undefined): string | undefined {
  if (!language || language === "und") {
    return undefined;
  }

  const normalizedLanguage = language.toLowerCase();
  if (normalizedLanguage.startsWith("zh")) {
    return "zh-CN";
  }

  const primaryLanguage = normalizedLanguage.split("-")[0];
  return sourceLanguageOptions.some((option) => option.value === primaryLanguage)
    ? primaryLanguage
    : undefined;
}

async function detectTabSourceLanguageForBuiltInAi(): Promise<string | undefined> {
  const detectLanguage = (browser.tabs as BrowserTabsWithLanguageDetection).detectLanguage;
  if (!detectLanguage || tabId.value === undefined) {
    return undefined;
  }

  try {
    return normalizeDetectedSourceLanguage(await detectLanguage(tabId.value));
  } catch {
    return undefined;
  }
}

async function prepareChromeBuiltInAiForTranslation(): Promise<string> {
  if (providerMode.value !== "local-only") {
    return sourceLanguage.value;
  }

  const chromeBuiltInAi = getChromeBuiltInAiGlobals();
  const detectorPreparation = chromeBuiltInAi.LanguageDetector
    ? prepareBuiltInAiSession(chromeBuiltInAi.LanguageDetector.create())
    : Promise.resolve();

  let resolvedSourceLanguage = sourceLanguage.value;
  if (resolvedSourceLanguage === "auto") {
    resolvedSourceLanguage =
      (await detectTabSourceLanguageForBuiltInAi()) ?? resolvedSourceLanguage;
  }

  const translatorPreparation =
    resolvedSourceLanguage !== "auto" && chromeBuiltInAi.Translator
      ? prepareBuiltInAiSession(
          chromeBuiltInAi.Translator.create({
            sourceLanguage: resolvedSourceLanguage,
            targetLanguage: targetLanguage.value,
          }),
        )
      : Promise.resolve();

  await Promise.all([detectorPreparation, translatorPreparation]);
  return resolvedSourceLanguage;
}

function applyProgress(response: BackgroundResponse): void {
  if (response.type === "backgroundError") {
    if (response.message === "No active provider profile.") {
      applyProviderStatus({
        type: "providerStatus",
        configured: false,
        readiness: "missingProvider",
        providerLabel: "未配置翻译服务",
        providerMode: "remote",
      });
      return;
    }

    state.value = "error";
    errorMessage.value = response.message;
    return;
  }

  if (response.type !== "taskProgress") {
    return;
  }

  const { progress } = response;
  if (
    currentTaskId.value &&
    progress.taskId &&
    progress.taskId !== currentTaskId.value
  ) {
    return;
  }

  if (progress.taskId) {
    currentTaskId.value = progress.taskId;
  }

  translated.value = progress.translated;
  total.value = progress.total;
  failed.value = progress.failed;
  errorMessage.value = progress.errorMessage ?? "";

  if (progress.state === "completed" || progress.state === "completedWithErrors") {
    state.value = "completed";
    return;
  }

  if (progress.state === "failed") {
    state.value = "error";
    errorMessage.value ||= "翻译失败，请稍后重试。";
    return;
  }

  if (progress.state === "cancelled") {
    state.value = "idle";
    currentTaskId.value = "";
    errorMessage.value = "";
    return;
  }

  state.value = "translating";
}

function applyProviderStatus(response: Extract<BackgroundResponse, { type: "providerStatus" }>) {
  providerLabel.value = response.providerLabel;
  providerMode.value = response.providerMode;
  hasProviderStatusIssue.value = isUnsupportedLocalProvider(response);

  if (isUnsupportedLocalProvider(response)) {
    isProviderConfigured.value = true;
    canTranslate.value = false;
    state.value = "error";
    currentTaskId.value = "";
    errorMessage.value = "Chrome Built-in AI requires desktop Chrome 138 or later.";
    return;
  }

  isProviderConfigured.value = response.configured;
  if (!response.configured) {
    state.value = "onboarding";
    currentTaskId.value = "";
    errorMessage.value = "需要先配置 Provider，正在打开设置页面...";
  } else if (state.value === "onboarding") {
    state.value = "idle";
    errorMessage.value = "";
  }
}

function isUnsupportedLocalProvider(
  response: Extract<BackgroundResponse, { type: "providerStatus" }>,
): boolean {
  return response.providerMode === "local-only" && response.readiness === "browserUnsupported";
}

function applyActionFailure(response: ContentResponse, fallbackMessage: string): void {
  if (response.type === "contentError") {
    errorMessage.value = response.message;
    return;
  }

  if (response.type === "contentActionResult" && response.message) {
    errorMessage.value = response.message;
    return;
  }

  errorMessage.value = fallbackMessage;
}

function isRunningTask(
  response: BackgroundResponse,
): response is Extract<BackgroundResponse, { type: "taskProgress" }> {
  return (
    response.type === "taskProgress" &&
    response.progress.taskId.length > 0 &&
    (response.progress.state === "collecting" ||
      response.progress.state === "translating" ||
      response.progress.state === "waitingForViewport")
  );
}

async function openSettings(
  section?: "provider",
  source?: "first-run" | "popup",
): Promise<void> {
  const request: BackgroundRequest = section
    ? { type: "openOptions", section, source: source ?? "popup" }
    : source
      ? { type: "openOptions", source }
      : { type: "openOptions" };
  const response = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request);

  if (response.type === "backgroundError") {
    throw new Error(response.message);
  }
}

function getSessionStorage(): SessionStorageArea | undefined {
  return (browser.storage as { session?: SessionStorageArea }).session;
}

async function hasAutoOpenedProviderOnboarding(): Promise<boolean> {
  const sessionStorage = getSessionStorage();
  if (!sessionStorage) {
    return false;
  }

  const result = await sessionStorage.get(providerOnboardingAutoOpenKey);
  return result[providerOnboardingAutoOpenKey] === true;
}

async function markProviderOnboardingAutoOpened(): Promise<void> {
  await getSessionStorage()?.set({ [providerOnboardingAutoOpenKey]: true });
}

async function clearProviderOnboardingAutoOpened(): Promise<void> {
  await getSessionStorage()?.remove(providerOnboardingAutoOpenKey);
}

async function loadPopupPreferences(): Promise<void> {
  try {
    const storage = createStorageRepositories();
    const [storedUiPreferences, storedTranslationPreferences] = await Promise.all([
      storage.uiPreferences.get(),
      storage.translationPreferences.get(),
    ]);

    uiLanguage.value = storedUiPreferences.uiLanguage;
    if (!hasUserEditedTargetLanguage.value) {
      isApplyingStoredPreferences.value = true;
      targetLanguage.value = storedTranslationPreferences.targetLanguage;
      await Promise.resolve();
    }
  } catch {
    uiLanguage.value = defaultUiPreferences.uiLanguage;
    if (!hasUserEditedTargetLanguage.value) {
      targetLanguage.value = defaultTranslationPreferences.targetLanguage;
    }
  } finally {
    isApplyingStoredPreferences.value = false;
  }
}

async function saveTargetLanguage(nextTargetLanguage: TargetLanguage): Promise<void> {
  const storage = createStorageRepositories();
  const latestPreferences = await storage.translationPreferences
    .get()
    .catch(() => defaultTranslationPreferences);

  await storage.translationPreferences.save({
    ...latestPreferences,
    targetLanguage: nextTargetLanguage,
  });
}

function queueTargetLanguageSave(nextTargetLanguage: TargetLanguage): Promise<void> {
  const nextSave = targetLanguageSaveQueue
    .catch(() => undefined)
    .then(() => saveTargetLanguage(nextTargetLanguage));

  targetLanguageSaveQueue = nextSave;
  return nextSave;
}

watch(targetLanguage, async (nextTargetLanguage) => {
  if (isApplyingStoredPreferences.value) {
    return;
  }

  hasUserEditedTargetLanguage.value = true;
  try {
    await queueTargetLanguageSave(nextTargetLanguage);
  } catch (error: unknown) {
    errorMessage.value =
      error instanceof Error ? error.message : "无法保存目标语言偏好。";
  }
});

async function maybeOpenProviderOnboardingSettings(): Promise<void> {
  if (await hasAutoOpenedProviderOnboarding()) {
    return;
  }

  await markProviderOnboardingAutoOpened();
  await openSettings("provider", "first-run");
}

async function loadPageRuntimeState(activeTabId: number): Promise<boolean> {
  const runtimeState = await sendTabMessage<ContentRequest, ContentResponse>(activeTabId, {
    type: "getPageRuntimeState",
  });

  if (runtimeState.type !== "pageRuntimeState" || !runtimeState.hasTranslations) {
    return false;
  }

  state.value = "existingTranslations";
  currentTaskId.value = runtimeState.taskId ?? "";
  pageTranslationsVisible.value = runtimeState.visibility !== "hidden";
  errorMessage.value = "";
  return true;
}

function handleRuntimeMessage(message: unknown): void {
  if (isRuntimeResponse(message)) {
    applyProgress(message);
  }
}

onMounted(async () => {
  browser.runtime.onMessage.addListener(handleRuntimeMessage);

  try {
    await loadPopupPreferences();

    const providerStatus = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
      type: "getProviderStatus",
    });

    if (providerStatus.type === "backgroundError") {
      state.value = "error";
      errorMessage.value = providerStatus.message;
      return;
    }

    if (providerStatus.type !== "providerStatus") {
      state.value = "error";
      errorMessage.value = "无法读取 Provider 状态。";
      return;
    }

    applyProviderStatus(providerStatus);
    if (isUnsupportedLocalProvider(providerStatus)) {
      return;
    }

    if (!providerStatus.configured) {
      await maybeOpenProviderOnboardingSettings().catch((error: unknown) => {
        errorMessage.value =
          error instanceof Error ? error.message : "无法自动打开设置页面，请点击打开设置。";
      });
      return;
    }

    await clearProviderOnboardingAutoOpened();

    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab?.id === undefined) {
      return;
    }

    tabId.value = activeTab.id;

    const taskResponse = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
      type: "getTaskForTab",
      tabId: activeTab.id,
    });

    if (isRunningTask(taskResponse)) {
      applyProgress(taskResponse);
      return;
    }

    if (await loadPageRuntimeState(activeTab.id)) {
      return;
    }

    const response = await sendTabMessage<ContentRequest, ContentResponse>(activeTab.id, {
      type: "estimatePage",
    });
    if (response.type === "estimatePageResult") {
      canTranslate.value = response.estimate.canTranslate;
      total.value = response.estimate.estimatedSegments;
      if (!response.estimate.canTranslate) {
        errorMessage.value = response.estimate.reason ?? "当前页面不可翻译。";
      }
      return;
    }

    if (response.type === "contentError") {
      canTranslate.value = false;
      errorMessage.value = response.message;
    }
  } catch (error: unknown) {
    canTranslate.value = false;
    errorMessage.value = error instanceof Error ? error.message : "无法读取当前页面。";
  } finally {
    isInitializing.value = false;
  }
});

onUnmounted(() => {
  browser.runtime.onMessage.removeListener(handleRuntimeMessage);
});

async function onPrimaryAction(): Promise<void> {
  if (isInitializing.value) {
    return;
  }

  if (state.value === "onboarding" || !isProviderConfigured.value) {
    await onOpenProviderOnboardingSettings();
    return;
  }

  if (state.value === "translating") {
    if (!currentTaskId.value) {
      return;
    }

    try {
      const response = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
        type: "cancelTask",
        taskId: currentTaskId.value,
        reason: "userCancelled",
      });
      applyProgress(response);
    } catch (error: unknown) {
      state.value = "error";
      errorMessage.value = error instanceof Error ? error.message : "取消翻译失败。";
    }
    return;
  }

  if (tabId.value === undefined) {
    state.value = "error";
    errorMessage.value = "无法获取当前标签页。";
    return;
  }

  const shouldRemoveExistingTranslations = state.value === "existingTranslations";

  errorMessage.value = "";
  let requestedSourceLanguage: string;

  try {
    requestedSourceLanguage = await prepareChromeBuiltInAiForTranslation();
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value =
      error instanceof Error
        ? error.message
        : "Chrome Built-in AI 初始化失败，请稍后重试。";
    return;
  }

  if (shouldRemoveExistingTranslations) {
    try {
      const removeResponse = await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, {
        type: "removeTranslations",
        taskId: currentTaskId.value || undefined,
      });

      if (removeResponse.type !== "contentActionResult" || !removeResponse.success) {
        applyActionFailure(removeResponse, "移除已有译文失败。");
        return;
      }
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : "移除已有译文失败。";
      return;
    }
  }

  state.value = "translating";
  translated.value = 0;
  failed.value = 0;

  try {
    currentTaskId.value = "";
    const response = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
      type: "translatePage",
      tabId: tabId.value,
      sourceLanguage: requestedSourceLanguage,
      targetLanguage: targetLanguage.value,
    });

    applyProgress(response);
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "翻译请求失败。";
  }
}

async function onSummaryAction(): Promise<void> {
  if (isSummaryDisabled.value || tabId.value === undefined) {
    return;
  }

  isSummarizing.value = true;
  errorMessage.value = "";

  try {
    const response = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
      type: "summarizePage",
      tabId: tabId.value,
      targetLanguage: targetLanguage.value,
    });

    if (response.type === "backgroundError") {
      state.value = "error";
      errorMessage.value = response.message;
    }
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "总结请求失败。";
  } finally {
    isSummarizing.value = false;
  }
}

async function onOpenSettings(): Promise<void> {
  try {
    await openSettings();
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "无法打开设置页面。";
  }
}

async function onOpenProviderOnboardingSettings(): Promise<void> {
  try {
    await openSettings("provider", "first-run");
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "无法打开设置页面。";
  }
}

async function onToggleTranslations(): Promise<void> {
  if (tabId.value === undefined) {
    return;
  }

  const message: ContentRequest = pageTranslationsVisible.value
    ? { type: "hideTranslations", taskId: currentTaskId.value || undefined }
    : { type: "showTranslations", taskId: currentTaskId.value || undefined };

  try {
    const response = await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, message);
    if (response.type === "contentActionResult" && response.success) {
      pageTranslationsVisible.value = !pageTranslationsVisible.value;
      errorMessage.value = "";
      return;
    }

    applyActionFailure(
      response,
      pageTranslationsVisible.value ? "隐藏译文失败。" : "显示译文失败。",
    );
  } catch (error: unknown) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : pageTranslationsVisible.value
          ? "隐藏译文失败。"
          : "显示译文失败。";
  }
}

async function onRemoveTranslations(): Promise<void> {
  if (tabId.value === undefined) {
    return;
  }

  try {
    const response = await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, {
      type: "removeTranslations",
      taskId: currentTaskId.value || undefined,
    });

    if (response.type === "contentActionResult" && response.success) {
      state.value = "idle";
      currentTaskId.value = "";
      errorMessage.value = "";
      pageTranslationsVisible.value = true;
      return;
    }

    applyActionFailure(response, "移除已有译文失败。");
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : "移除已有译文失败。";
  }
}
</script>

<template>
  <main class="yoyo-shell">
    <header class="popup-header">
      <h1>悠悠阅读助手</h1>
    </header>

    <section class="popup-content">
      <LanguageSelector
        v-model:source-language="sourceLanguage"
        v-model:target-language="targetLanguage"
        :source-options="sourceLanguageOptions"
        :target-options="targetLanguageOptions"
      />

      <ProviderCard
        v-if="shouldShowProviderCard"
        :provider-label="providerLabel"
      />

      <div
        class="action-grid"
        role="group"
        aria-label="Page actions"
      >
        <button
          class="primary-action"
          type="button"
          :disabled="isPrimaryDisabled"
          @click="onPrimaryAction"
        >
          {{ primaryLabel }}
        </button>

        <button
          class="summary-action"
          type="button"
          :disabled="isSummaryDisabled"
          @click="onSummaryAction"
        >
          {{ isSummarizing ? t("button.summarizingPage") : t("button.summarizePage") }}
        </button>
      </div>

      <TaskProgress
        v-if="state === 'translating' || state === 'completed'"
        :completed="translated"
        :total="total"
        :failed="failed"
      />

      <div
        v-if="state === 'existingTranslations'"
        class="existing-translations"
      >
        <p>页面已有译文</p>
        <div class="translation-actions">
          <button
            class="secondary-action"
            type="button"
            @click="onToggleTranslations"
          >
            {{ pageTranslationsVisible ? "隐藏译文" : "显示译文" }}
          </button>
          <button
            class="secondary-action danger"
            type="button"
            @click="onRemoveTranslations"
          >
            移除译文
          </button>
        </div>
      </div>

      <ErrorSummary :message="errorMessage" />
    </section>

    <PopupFooter
      left-label="设置"
      :version="extensionVersion"
      @open-settings="onOpenSettings"
    />
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 340px;
  min-width: 340px;
  max-width: 340px;
  margin: 0;
  overflow-x: hidden;
}

.yoyo-shell {
  width: 100%;
  min-height: 300px;
  padding: 18px;
  color: var(--yoyo-text);
  background:
    linear-gradient(180deg, var(--yoyo-surface-soft) 0%, var(--yoyo-surface) 42%),
    var(--yoyo-surface);
}

.popup-header {
  margin-bottom: 16px;
}

.popup-header h1 {
  margin: 0;
  color: var(--yoyo-text);
  font-size: 20px;
  font-weight: 750;
  line-height: 1.2;
}

.popup-content {
  display: grid;
  gap: 14px;
  margin-bottom: 16px;
}

.action-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.primary-action {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  color: #ffffff;
  background: linear-gradient(
    180deg,
    var(--yoyo-brand-700) 0%,
    var(--yoyo-brand-800) 100%
  );
  box-shadow: 0 10px 20px rgb(7 95 50 / 22%);
  font-size: 14px;
  font-weight: 750;
  line-height: 1.2;
  cursor: pointer;
}

.primary-action:hover {
  background: linear-gradient(
    180deg,
    var(--yoyo-brand-800) 0%,
    var(--yoyo-brand-700) 100%
  );
}

.primary-action:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.primary-action:focus-visible {
  outline: 3px solid var(--yoyo-focus-ring);
  outline-offset: 3px;
}

.summary-action {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid #b9d8aa;
  border-radius: 12px;
  color: var(--yoyo-brand-800);
  background: linear-gradient(
    180deg,
    var(--yoyo-surface-muted) 0%,
    var(--yoyo-brand-100) 100%
  );
  box-shadow: 0 8px 18px rgb(7 95 50 / 10%);
  font-size: 14px;
  font-weight: 730;
  line-height: 1.2;
  cursor: pointer;
}

.summary-action:hover {
  border-color: var(--yoyo-border-strong);
  background: linear-gradient(
    180deg,
    var(--yoyo-brand-100) 0%,
    var(--yoyo-surface-muted) 100%
  );
}

.summary-action:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.summary-action:focus-visible {
  outline: 3px solid var(--yoyo-focus-ring);
  outline-offset: 3px;
}

.existing-translations {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #d9ddea;
  border-radius: 10px;
  background: #ffffff;
}

.existing-translations p {
  margin: 0;
  color: #34394a;
  font-size: 13px;
  font-weight: 650;
}

.translation-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.secondary-action {
  min-height: 34px;
  border: 1px solid #cbd1e1;
  border-radius: 8px;
  color: #293044;
  background: #ffffff;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.secondary-action.danger {
  color: #9b1c1c;
  border-color: #f0b9b9;
}
</style>
