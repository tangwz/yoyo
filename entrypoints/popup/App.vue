<script setup lang="ts">
import { ref } from "vue";

import {
  sourceLanguageOptions,
  targetLanguageOptions,
} from "@/i18n/languages";
import LanguageSelector from "@/ui/components/LanguageSelector.vue";
import PopupFooter from "@/ui/components/PopupFooter.vue";
import ProviderCard from "@/ui/components/ProviderCard.vue";

const sourceLanguage = ref("auto");
const targetLanguage = ref("zh-CN");
const providerLabel = ref("OpenAI Compatible / api.example.com");
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
      >
        翻译当前页面
      </button>
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
