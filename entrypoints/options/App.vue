<script setup lang="ts">
import { ref } from "vue";

import { providerPresets } from "@/provider/presets";

const defaultPreset = providerPresets[0];

const selectedPresetId = ref(defaultPreset.id);
const displayName = ref(defaultPreset.name);
const baseUrl = ref(defaultPreset.defaultBaseUrl);
const apiKey = ref("");
const textModel = ref(defaultPreset.defaultTextModel ?? "");
const visionModel = ref("");
const targetLanguage = ref("zh-CN");
const timeoutMs = ref(30000);
const temperature = ref(0.3);
const maxTokens = ref(4096);

function applySelectedPreset() {
  const preset = providerPresets.find((item) => item.id === selectedPresetId.value);

  if (!preset) {
    return;
  }

  displayName.value = preset.name;
  baseUrl.value = preset.defaultBaseUrl;
  textModel.value = preset.defaultTextModel ?? "";
}
</script>

<template>
  <main class="yoyo-shell">
    <header class="page-header">
      <h1>设置</h1>
    </header>

    <section
      class="settings-section"
      aria-labelledby="provider-heading"
    >
      <h2 id="provider-heading">
        Provider
      </h2>

      <div class="settings-grid">
        <label class="field">
          <span>Preset</span>
          <select
            v-model="selectedPresetId"
            @change="applySelectedPreset"
          >
            <option
              v-for="preset in providerPresets"
              :key="preset.id"
              :value="preset.id"
            >
              {{ preset.name }}
            </option>
          </select>
        </label>

        <label class="field">
          <span>Display Name</span>
          <input
            v-model="displayName"
            type="text"
            autocomplete="off"
          >
        </label>

        <label class="field field-wide">
          <span>Base URL</span>
          <input
            v-model="baseUrl"
            type="url"
            inputmode="url"
            autocomplete="off"
          >
        </label>

        <div class="field field-wide">
          <label for="api-key">API Key</label>
          <input
            id="api-key"
            v-model="apiKey"
            type="password"
            autocomplete="off"
          >
          <small>API Key 保存在浏览器扩展本地存储，不跨设备同步。</small>
        </div>

        <label class="field">
          <span>Text Model</span>
          <input
            v-model="textModel"
            type="text"
            autocomplete="off"
          >
        </label>

        <label class="field">
          <span>Vision Model</span>
          <input
            v-model="visionModel"
            type="text"
            autocomplete="off"
          >
        </label>
      </div>

      <button
        class="secondary-button"
        type="button"
      >
        测试连接
      </button>
    </section>

    <section
      class="settings-section"
      aria-labelledby="translation-heading"
    >
      <h2 id="translation-heading">
        Translation
      </h2>

      <div class="settings-grid">
        <label class="field">
          <span>Target Language</span>
          <select v-model="targetLanguage">
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </label>
      </div>

      <p class="section-note">
        显示方式：原文下方显示译文，并尽量保持与原段落一致的排版样式。
      </p>
    </section>

    <section
      class="settings-section"
      aria-labelledby="privacy-heading"
    >
      <h2 id="privacy-heading">
        Privacy
      </h2>

      <ul class="privacy-list">
        <li>Only manual trigger extracts page text</li>
        <li>Extracted text sent to configured model provider</li>
        <li>API key does not enter content script or page</li>
        <li>First version has no persistent translation cache</li>
      </ul>
    </section>

    <section
      class="settings-section"
      aria-labelledby="advanced-heading"
    >
      <h2 id="advanced-heading">
        Advanced
      </h2>

      <div class="settings-grid">
        <label class="field">
          <span>Timeout</span>
          <input
            v-model.number="timeoutMs"
            type="number"
            min="1000"
            step="1000"
          >
        </label>

        <label class="field">
          <span>Temperature</span>
          <input
            v-model.number="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
          >
        </label>

        <label class="field">
          <span>Max Tokens</span>
          <input
            v-model.number="maxTokens"
            type="number"
            min="1"
            step="1"
          >
        </label>

        <div class="field static-field">
          <span>Prompt version</span>
          <strong>v1</strong>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.yoyo-shell {
  box-sizing: border-box;
  width: min(920px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 24px 48px;
  color: #172033;
  background: #f7f8fb;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
}

.settings-section {
  padding: 20px;
  margin-bottom: 16px;
  background: #ffffff;
  border: 1px solid #d9deea;
  border-radius: 8px;
}

.settings-section h2 {
  margin: 0 0 16px;
  font-size: 18px;
  line-height: 1.3;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  color: #3d4658;
  font-size: 13px;
  font-weight: 600;
}

.field-wide {
  grid-column: 1 / -1;
}

.field input,
.field select {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  color: #172033;
  font: inherit;
  font-weight: 400;
  background: #ffffff;
  border: 1px solid #b8c0d1;
  border-radius: 6px;
}

.field small,
.section-note {
  margin: 0;
  color: #5d6678;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
}

.secondary-button {
  min-height: 40px;
  padding: 8px 14px;
  margin-top: 16px;
  color: #172033;
  font: inherit;
  font-weight: 600;
  background: #ffffff;
  border: 1px solid #aab3c5;
  border-radius: 6px;
}

.privacy-list {
  padding-left: 20px;
  margin: 0;
  color: #3d4658;
  line-height: 1.6;
}

.static-field {
  min-height: 40px;
  justify-content: center;
}

.static-field strong {
  color: #172033;
  font-size: 15px;
}

@media (max-width: 720px) {
  .yoyo-shell {
    padding: 24px 16px 40px;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
