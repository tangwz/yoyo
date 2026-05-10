<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
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
import { sendRuntimeMessage, sendTabMessage } from "@/messaging/runtime";
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
const targetLanguage = ref("zh-CN");
const providerLabel = ref("正在读取翻译服务...");
const isProviderConfigured = ref(true);
const tabId = ref<number>();
const isInitializing = ref(true);
const canTranslate = ref(true);
const state = ref<PopupState>("idle");
const currentTaskId = ref("");
const translated = ref(0);
const total = ref(0);
const failed = ref(0);
const errorMessage = ref("");
const pageTranslationsVisible = ref(true);
const providerOnboardingAutoOpenKey = "yoyo.providerOnboardingAutoOpened";

type SessionStorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
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

  return "翻译当前页面";
});

const isPrimaryDisabled = computed(
  () =>
    isProviderConfigured.value &&
    (isInitializing.value || (!canTranslate.value && state.value !== "translating")),
);

function isRuntimeResponse(message: unknown): message is BackgroundResponse {
  return typeof message === "object" && message !== null && "type" in message;
}

function applyProgress(response: BackgroundResponse): void {
  if (response.type === "backgroundError") {
    if (response.message === "No active provider profile.") {
      applyProviderStatus({
        type: "providerStatus",
        configured: false,
        readiness: "missingProvider",
        providerLabel: "未配置翻译服务",
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
  isProviderConfigured.value = response.configured;
  providerLabel.value = response.providerLabel;

  if (!response.configured) {
    state.value = "onboarding";
    currentTaskId.value = "";
    errorMessage.value = "需要先配置 Provider，正在打开设置页面...";
  } else if (state.value === "onboarding") {
    state.value = "idle";
    errorMessage.value = "";
  }
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
    (response.progress.state === "collecting" || response.progress.state === "translating")
  );
}

async function openSettings(
  section?: "provider",
  source: "first-run" | "popup" = "popup",
): Promise<void> {
  const request: BackgroundRequest = section
    ? { type: "openOptions", section, source }
    : { type: "openOptions", source };
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
      errorMessage.value = response.message;
    }
  } catch (error: unknown) {
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
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
    });

    applyProgress(response);
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "翻译请求失败。";
  }
}

async function onOpenSettings(): Promise<void> {
  try {
    await openSettings(undefined, "popup");
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

      <ProviderCard :provider-label="providerLabel" />

      <button
        class="primary-action"
        type="button"
        :disabled="isPrimaryDisabled"
        @click="onPrimaryAction"
      >
        {{ primaryLabel }}
      </button>

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
      version="0.1.0"
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
  color: #202431;
  background:
    linear-gradient(180deg, #f8f8fa 0%, #ffffff 38%),
    #ffffff;
}

.popup-header {
  margin-bottom: 16px;
}

.popup-header h1 {
  margin: 0;
  color: #171b26;
  font-size: 20px;
  font-weight: 750;
  line-height: 1.2;
}

.popup-content {
  display: grid;
  gap: 14px;
  margin-bottom: 16px;
}

.primary-action {
  width: 100%;
  min-height: 48px;
  padding: 0 16px;
  border: 0;
  border-radius: 12px;
  color: #ffffff;
  background: linear-gradient(180deg, #6157f4 0%, #4f46d8 100%);
  box-shadow: 0 10px 20px rgb(79 70 216 / 22%);
  font-size: 15px;
  font-weight: 750;
  cursor: pointer;
}

.primary-action:hover {
  background: linear-gradient(180deg, #6b61ff 0%, #554ae4 100%);
}

.primary-action:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.primary-action:focus-visible {
  outline: 3px solid #b8b4ff;
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
