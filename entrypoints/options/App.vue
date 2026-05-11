<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

import {
  isOptionsUiLanguage,
  optionsMessages,
  providerErrorMessageKeys,
  type OptionsMessageKey,
} from "@/i18n/optionsMessages";
import { ProviderError } from "@/provider/errors";
import { normalizeModelNameForProfile } from "@/provider/modelNames";
import { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import { providerPresets } from "@/provider/presets";
import type { ProviderProfile } from "@/provider/types";
import { defaultUiPreferences, type UiPreferences } from "@/storage/defaults";
import { createStorageRepositories } from "@/storage/repositories";
import type { TranslationMode } from "@/translation/types";

const defaultPreset = providerPresets[0];

const selectedPresetId = ref(defaultPreset.id);
const displayName = ref(defaultPreset.name);
const baseUrl = ref(defaultPreset.defaultBaseUrl);
const apiKey = ref("");
const textModel = ref(defaultPreset.defaultTextModel ?? "");
const visionModel = ref("");
const targetLanguage = ref("zh-CN");
const translationMode = ref<TranslationMode>("lazyViewport");
const uiTheme = ref<UiPreferences["theme"]>(defaultUiPreferences.theme);
const uiLanguage = ref(defaultUiPreferences.uiLanguage);
const timeoutMs = ref(30000);
const temperature = ref(0.3);
const maxTokens = ref(4096);
const saveState = ref<"idle" | "saved" | "error">("idle");
const testState = ref<"untested" | "testing" | "success" | "failed">("untested");
const testMessage = ref("");
const isTestInFlight = ref(false);
const testRequestId = ref(0);
const providerSectionRef = ref<HTMLElement>();
const presetSelectRef = ref<HTMLSelectElement>();
const routeParams = new URLSearchParams(globalThis.location.search);
const shouldLandOnProvider = routeParams.get("section") === "provider";
const isFirstRunProviderLanding =
  shouldLandOnProvider && routeParams.get("source") === "first-run";

const messages = computed(() => optionsMessages[uiLanguage.value]);

const providerPresetOptions = computed(() =>
  providerPresets.map((preset) => ({
    ...preset,
    label: getPresetLabel(preset.id, preset.name),
  })),
);

const targetLanguageOptions = computed(() => [
  { value: "zh-CN", label: t("targetLanguage.zhCN") },
  { value: "zh-TW", label: t("targetLanguage.zhTW") },
  { value: "en", label: t("targetLanguage.en") },
  { value: "ja", label: t("targetLanguage.ja") },
  { value: "ko", label: t("targetLanguage.ko") },
]);

const uiLanguageOptions = computed(() => [
  { value: "zh-CN", label: t("uiLanguage.zhCN") },
  { value: "en-US", label: t("uiLanguage.enUS") },
]);

function t(key: OptionsMessageKey): string {
  return messages.value[key];
}

function getPresetLabel(presetId: string, fallback: string): string {
  return presetId === "custom" ? t("providerPreset.custom") : fallback;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizePositiveNumber(value: unknown, defaultValue: number): number {
  const parsed = toFiniteNumber(value);

  return parsed !== undefined && parsed > 0 ? parsed : defaultValue;
}

function normalizeTemperature(value: unknown): number {
  const parsed = toFiniteNumber(value);

  if (parsed === undefined) {
    return 0.3;
  }

  return Math.min(2, Math.max(0, parsed));
}

function normalizePositiveInteger(value: unknown, defaultValue: number): number {
  const parsed = toFiniteNumber(value);

  if (parsed === undefined || parsed < 1) {
    return defaultValue;
  }

  return Math.trunc(parsed);
}

function buildProviderProfile(): ProviderProfile {
  const profileId = selectedPresetId.value;
  const modelContext = {
    id: profileId,
    presetId: selectedPresetId.value,
  };
  const normalizedTextModel = normalizeModelNameForProfile(modelContext, textModel.value);
  const normalizedVisionModel = visionModel.value.trim();

  return {
    id: profileId,
    displayName: displayName.value,
    presetId: selectedPresetId.value,
    type: "openai-compatible",
    baseURL: baseUrl.value,
    apiKey: apiKey.value,
    textModel: normalizedTextModel,
    visionModel: normalizedVisionModel || undefined,
    requestParams: {
      timeoutMs: normalizePositiveNumber(timeoutMs.value, 30000),
      temperature: normalizeTemperature(temperature.value),
      maxTokens: normalizePositiveInteger(maxTokens.value, 4096),
    },
  };
}

function getProviderProfileSignature(profile: ProviderProfile): string {
  return JSON.stringify(profile);
}

const providerProfileSignature = computed(() => getProviderProfileSignature(buildProviderProfile()));

function resetTestFeedback() {
  testState.value = "untested";
  testMessage.value = "";
}

watch(providerProfileSignature, resetTestFeedback);

function getProviderTestErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return t(providerErrorMessageKeys[error.code]);
  }

  return t(providerErrorMessageKeys.unknown);
}

function applySelectedPreset() {
  const preset = providerPresets.find((item) => item.id === selectedPresetId.value);

  if (!preset) {
    return;
  }

  displayName.value = getPresetLabel(preset.id, preset.name);
  baseUrl.value = preset.defaultBaseUrl;
  textModel.value = preset.defaultTextModel ?? "";
}

async function loadUiPreferences() {
  try {
    const storage = createStorageRepositories();
    const preferences = await storage.uiPreferences.get();
    uiTheme.value = preferences.theme === "light" ? preferences.theme : defaultUiPreferences.theme;
    uiLanguage.value = isOptionsUiLanguage(preferences.uiLanguage)
      ? preferences.uiLanguage
      : defaultUiPreferences.uiLanguage;
  } catch {
    uiTheme.value = defaultUiPreferences.theme;
    uiLanguage.value = defaultUiPreferences.uiLanguage;
  }
}

function applyProviderProfile(profile: ProviderProfile) {
  const presetId = profile.presetId ?? profile.id;
  selectedPresetId.value = providerPresets.some((item) => item.id === presetId)
    ? presetId
    : "custom";
  displayName.value = profile.displayName;
  baseUrl.value = profile.baseURL;
  apiKey.value = profile.apiKey;
  textModel.value = profile.textModel;
  visionModel.value = profile.visionModel ?? "";
  timeoutMs.value = profile.requestParams?.timeoutMs ?? 30000;
  temperature.value = profile.requestParams?.temperature ?? 0.3;
  maxTokens.value = profile.requestParams?.maxTokens ?? 4096;
}

async function loadActiveProviderProfile() {
  try {
    const storage = createStorageRepositories();
    const [profiles, activeProviderId] = await Promise.all([
      storage.providers.listProfiles(),
      storage.providers.getActiveProviderId(),
    ]);
    const activeProfile =
      profiles.find((profile) => profile.id === activeProviderId) ?? profiles[0];

    if (activeProfile) {
      applyProviderProfile(activeProfile);
    }
  } catch {
    // Keep defaults when saved settings cannot be read.
  }
}

async function loadTranslationPreferences() {
  try {
    const storage = createStorageRepositories();
    const preferences = await storage.translationPreferences.get();
    translationMode.value = preferences.mode;
  } catch {
    translationMode.value = "lazyViewport";
  }
}

async function focusProviderLanding() {
  if (!shouldLandOnProvider) {
    return;
  }

  await nextTick();
  providerSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
  presetSelectRef.value?.focus();
}

onMounted(async () => {
  await Promise.all([
    loadUiPreferences(),
    loadActiveProviderProfile(),
    loadTranslationPreferences(),
  ]);
  await focusProviderLanding();
});

async function saveProviderProfile() {
  saveState.value = "idle";

  try {
    const storage = createStorageRepositories();
    const profile = buildProviderProfile();

    await storage.providers.saveProfile(profile);
    await storage.providers.setActiveProviderId(profile.id);
    saveState.value = "saved";
  } catch {
    saveState.value = "error";
  }
}

async function saveTranslationMode() {
  try {
    const storage = createStorageRepositories();
    await storage.translationPreferences.save({ mode: translationMode.value });
  } catch {
    // Translation mode is non-critical; keep the selected value visible.
  }
}

async function saveUiLanguage() {
  try {
    const storage = createStorageRepositories();
    await storage.uiPreferences.save({
      theme: uiTheme.value,
      uiLanguage: uiLanguage.value,
    });
  } catch {
    // UI language is already applied locally; storage can retry on the next change.
  }
}

async function testConnection() {
  if (isTestInFlight.value) {
    return;
  }

  const requestId = testRequestId.value + 1;
  testRequestId.value = requestId;
  const profile = buildProviderProfile();
  const testedProfileSignature = getProviderProfileSignature(profile);

  isTestInFlight.value = true;
  testState.value = "testing";
  testMessage.value = "";

  try {
    const provider = new OpenAiCompatibleProvider();

    const response = await provider.testConnection(profile);
    if (
      requestId !== testRequestId.value ||
      testedProfileSignature !== providerProfileSignature.value
    ) {
      return;
    }

    const acceptedTextModel = normalizeModelNameForProfile(profile, response.model);
    if (acceptedTextModel !== textModel.value) {
      textModel.value = acceptedTextModel;
      await nextTick();
    }
    if (requestId !== testRequestId.value || textModel.value !== acceptedTextModel) {
      return;
    }

    testState.value = "success";
    testMessage.value = t("test.success");
  } catch (error) {
    if (
      requestId !== testRequestId.value ||
      testedProfileSignature !== providerProfileSignature.value
    ) {
      return;
    }

    testState.value = "failed";
    testMessage.value = getProviderTestErrorMessage(error);
  } finally {
    if (requestId === testRequestId.value) {
      isTestInFlight.value = false;
    }
  }
}
</script>

<template>
  <main class="yoyo-shell">
    <header class="page-header">
      <div class="page-header__inner">
        <h1>{{ t("settings.title") }}</h1>
      </div>
    </header>

    <div class="settings-layout">
      <nav
        class="settings-nav"
        :aria-label="t('settings.navigationLabel')"
      >
        <a href="#provider-heading">{{ t("section.provider") }}</a>
        <a href="#translation-heading">{{ t("section.translation") }}</a>
        <a href="#privacy-heading">{{ t("section.privacy") }}</a>
        <a href="#advanced-heading">{{ t("section.advanced") }}</a>
      </nav>

      <div class="settings-content">
        <section
          ref="providerSectionRef"
          class="settings-section"
          aria-labelledby="provider-heading"
        >
          <h2 id="provider-heading">
            {{ t("section.provider") }}
          </h2>
          <p
            v-if="isFirstRunProviderLanding"
            class="section-note"
          >
            {{ t("provider.firstRunNote") }}
          </p>

          <div class="settings-grid">
            <label class="field">
              <span>{{ t("field.preset") }}</span>
              <select
                ref="presetSelectRef"
                v-model="selectedPresetId"
                @change="applySelectedPreset"
              >
                <option
                  v-for="preset in providerPresetOptions"
                  :key="preset.id"
                  :value="preset.id"
                >
                  {{ preset.label }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>{{ t("field.displayName") }}</span>
              <input
                v-model="displayName"
                type="text"
                autocomplete="off"
              >
            </label>

            <label class="field field-wide">
              <span>{{ t("field.baseUrl") }}</span>
              <input
                v-model="baseUrl"
                type="url"
                inputmode="url"
                autocomplete="off"
              >
            </label>

            <div class="field field-wide">
              <label for="api-key">{{ t("field.apiKey") }}</label>
              <input
                id="api-key"
                v-model="apiKey"
                type="password"
                autocomplete="off"
              >
              <small>{{ t("field.apiKeyNote") }}</small>
            </div>

            <label class="field">
              <span>{{ t("field.textModel") }}</span>
              <input
                v-model="textModel"
                type="text"
                autocomplete="off"
              >
            </label>

            <label class="field">
              <span>{{ t("field.visionModel") }}</span>
              <input
                v-model="visionModel"
                type="text"
                autocomplete="off"
              >
            </label>
          </div>

          <div class="button-row">
            <button
              class="primary-button"
              type="button"
              @click="saveProviderProfile"
            >
              {{ t("button.saveProvider") }}
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="isTestInFlight"
              @click="testConnection"
            >
              {{ isTestInFlight ? t("button.testingConnection") : t("button.testConnection") }}
            </button>
          </div>

          <p
            v-if="saveState === 'saved'"
            class="save-feedback success"
            role="status"
          >
            {{ t("save.success") }}
          </p>
          <p
            v-else-if="saveState === 'error'"
            class="save-feedback error"
            role="alert"
          >
            {{ t("save.error") }}
          </p>

          <p
            v-if="testState === 'testing'"
            class="save-feedback"
            role="status"
          >
            {{ t("test.testing") }}
          </p>
          <p
            v-else-if="testState === 'success'"
            class="save-feedback success"
            role="status"
          >
            {{ testMessage }}
          </p>
          <p
            v-else-if="testState === 'failed'"
            class="save-feedback error"
            role="alert"
          >
            {{ testMessage }}
          </p>
        </section>

        <section
          class="settings-section"
          aria-labelledby="translation-heading"
        >
          <h2 id="translation-heading">
            {{ t("section.translation") }}
          </h2>

          <div class="settings-grid">
            <label class="field">
              <span>{{ t("field.targetLanguage") }}</span>
              <select v-model="targetLanguage">
                <option
                  v-for="option in targetLanguageOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>{{ t("field.translationMode") }}</span>
              <select
                v-model="translationMode"
                @change="saveTranslationMode"
              >
                <option value="lazyViewport">
                  {{ t("translation.mode.lazyViewport") }}
                </option>
                <option value="fullPage">
                  {{ t("translation.mode.fullPage") }}
                </option>
              </select>
            </label>
          </div>

          <p class="section-note">
            {{ t("translation.displayNote") }}
          </p>
        </section>

        <section
          class="settings-section"
          aria-labelledby="privacy-heading"
        >
          <h2 id="privacy-heading">
            {{ t("section.privacy") }}
          </h2>

          <ul class="privacy-list">
            <li>{{ t("privacy.manualExtraction") }}</li>
            <li>{{ t("privacy.providerTransfer") }}</li>
            <li>{{ t("privacy.apiKeyIsolation") }}</li>
            <li>{{ t("privacy.noPersistentCache") }}</li>
          </ul>
        </section>

        <section
          class="settings-section"
          aria-labelledby="advanced-heading"
        >
          <h2 id="advanced-heading">
            {{ t("section.advanced") }}
          </h2>

          <div class="settings-grid">
            <label class="field">
              <span>{{ t("field.uiLanguage") }}</span>
              <select
                v-model="uiLanguage"
                @change="saveUiLanguage"
              >
                <option
                  v-for="option in uiLanguageOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>{{ t("field.timeout") }}</span>
              <input
                v-model.number="timeoutMs"
                type="number"
                min="1000"
                step="1000"
              >
            </label>

            <label class="field">
              <span>{{ t("field.temperature") }}</span>
              <input
                v-model.number="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              >
            </label>

            <label class="field">
              <span>{{ t("field.maxTokens") }}</span>
              <input
                v-model.number="maxTokens"
                type="number"
                min="1"
                step="1"
              >
            </label>

            <div class="field static-field">
              <span>{{ t("field.promptVersion") }}</span>
              <strong>v1</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  min-height: 100%;
  margin: 0;
  background: #f4f6fa;
}

.yoyo-shell {
  box-sizing: border-box;
  min-height: 100vh;
  color: #172033;
  background: #f4f6fa;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.page-header {
  background: #ffffff;
  border-bottom: 1px solid #e1e5ee;
}

.page-header__inner {
  box-sizing: border-box;
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 24px 32px;
}

.page-header h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
}

.settings-layout {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  gap: 28px;
  box-sizing: border-box;
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 28px 32px 56px;
}

.settings-nav {
  position: sticky;
  top: 24px;
  align-self: start;
  display: grid;
  gap: 4px;
}

.settings-nav a {
  padding: 9px 12px;
  border-radius: 8px;
  color: #4d586b;
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
}

.settings-nav a:hover,
.settings-nav a:focus-visible {
  color: #172033;
  background: #e9edf5;
  outline: none;
}

.settings-content {
  background: #ffffff;
  border: 1px solid #e1e5ee;
  border-radius: 14px;
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
}

.settings-section {
  padding: 28px 32px;
  border-bottom: 1px solid #edf0f5;
}

.settings-section:last-child {
  border-bottom: 0;
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

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}

.primary-button,
.secondary-button {
  min-height: 40px;
  padding: 8px 14px;
  font: inherit;
  font-weight: 600;
  border-radius: 6px;
}

.primary-button {
  color: #ffffff;
  background: #1f5fbf;
  border: 1px solid #1f5fbf;
}

.secondary-button {
  color: #172033;
  background: #ffffff;
  border: 1px solid #aab3c5;
}

.save-feedback {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.save-feedback.success {
  color: #17663a;
}

.save-feedback.error {
  color: #b3261e;
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

@media (max-width: 820px) {
  .page-header__inner {
    padding: 22px 18px;
  }

  .settings-layout {
    grid-template-columns: 1fr;
    gap: 16px;
    padding: 18px 16px 40px;
  }

  .settings-nav {
    position: static;
    display: flex;
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .settings-nav a {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .settings-section {
    padding: 22px 18px;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
