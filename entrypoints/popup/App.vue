<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
import ErrorSummary from "@/ui/components/ErrorSummary.vue";
import LanguageSelector from "@/ui/components/LanguageSelector.vue";
import PopupFooter from "@/ui/components/PopupFooter.vue";
import ProviderCard from "@/ui/components/ProviderCard.vue";
import TaskProgress from "@/ui/components/TaskProgress.vue";

const sourceLanguage = ref("auto");
const targetLanguage = ref("zh-CN");
const providerLabel = ref("OpenAI Compatible / api.example.com");
const tabId = ref<number>();
const state = ref<"idle" | "translating" | "completed" | "error">("idle");
const translated = ref(0);
const total = ref(0);
const failed = ref(0);
const errorMessage = ref("");
const activeTaskId = ref<string>();

const primaryLabel = computed(() => {
  if (state.value === "translating") {
    return "取消翻译";
  }

  if (state.value === "completed") {
    return "重新翻译";
  }

  return "翻译当前页面";
});

function applyProgress(response: BackgroundResponse): void {
  if (response.type === "backgroundError") {
    state.value = "error";
    errorMessage.value = response.message;
    return;
  }

  if (response.type !== "taskProgress") {
    return;
  }

  const { progress } = response;
  activeTaskId.value = progress.taskId;
  translated.value = progress.translated;
  total.value = progress.total;
  failed.value = progress.failed;
  errorMessage.value = progress.errorMessage ?? "";

  if (progress.state === "completed" || progress.state === "completedWithErrors") {
    state.value = "completed";
    return;
  }

  if (progress.state === "failed" || progress.state === "cancelled") {
    state.value = "error";
    errorMessage.value ||= "翻译失败，请稍后重试。";
    return;
  }

  state.value = "translating";
}

onMounted(async () => {
  try {
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab?.id === undefined) {
      return;
    }

    tabId.value = activeTab.id;

    const response = (await browser.tabs.sendMessage(activeTab.id, {
      type: "estimatePage",
    } satisfies ContentRequest)) as ContentResponse;

    if (response.type === "estimatePageResult") {
      total.value = response.estimate.estimatedSegments;
      return;
    }

    if (response.type === "contentError") {
      errorMessage.value = response.message;
    }
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : "无法读取当前页面。";
  }
});

async function onPrimaryAction(): Promise<void> {
  if (state.value === "translating") {
    return;
  }

  if (tabId.value === undefined) {
    state.value = "error";
    errorMessage.value = "无法获取当前标签页。";
    return;
  }

  state.value = "translating";
  errorMessage.value = "";
  translated.value = 0;
  failed.value = 0;

  try {
    const response = (await browser.runtime.sendMessage({
      type: "translatePage",
      tabId: tabId.value,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
    } satisfies BackgroundRequest)) as BackgroundResponse;

    applyProgress(response);
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "翻译请求失败。";
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

      <ErrorSummary :message="errorMessage" />
    </section>

    <PopupFooter
      left-label="设置"
      version="0.1.0"
    />
  </main>
</template>

<style scoped>
.yoyo-shell {
  width: 410px;
  max-width: 100vw;
  min-height: 300px;
  padding: 22px;
  color: #202431;
  background:
    linear-gradient(180deg, #f8f8fa 0%, #ffffff 38%),
    #ffffff;
}

.popup-header {
  margin-bottom: 18px;
}

.popup-header h1 {
  margin: 0;
  color: #171b26;
  font-size: 22px;
  font-weight: 750;
  line-height: 1.2;
}

.popup-content {
  display: grid;
  gap: 16px;
  margin-bottom: 18px;
}

.primary-action {
  width: 100%;
  min-height: 52px;
  padding: 0 18px;
  border: 0;
  border-radius: 14px;
  color: #ffffff;
  background: linear-gradient(180deg, #6157f4 0%, #4f46d8 100%);
  box-shadow: 0 10px 20px rgb(79 70 216 / 22%);
  font-size: 16px;
  font-weight: 750;
  cursor: pointer;
}

.primary-action:hover {
  background: linear-gradient(180deg, #6b61ff 0%, #554ae4 100%);
}

.primary-action:focus-visible {
  outline: 3px solid #b8b4ff;
  outline-offset: 3px;
}
</style>
