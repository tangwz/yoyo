<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

import {
  isOptionsUiLanguage,
  optionsMessages,
  providerErrorMessageKeys,
  type OptionsMessageKey,
} from "@/i18n/optionsMessages";
import { getChromeBuiltInAiBrowserSupport } from "@/provider/browserSupport";
import { ProviderError } from "@/provider/errors";
import { normalizeModelNameForProfile } from "@/provider/modelNames";
import { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import {
  chromeBuiltInAiProviderId,
  chromeBuiltInAiProviderProfile,
  defaultProviderPreset,
  providerPresets,
} from "@/provider/presets";
import { selectStoredActiveProviderId } from "@/provider/readiness";
import {
  isOpenAiCompatibleProviderProfile,
  type ProviderProfile,
} from "@/provider/types";
import {
  defaultSiteRules,
  defaultTranslationPreferences,
  defaultUiPreferences,
  type SiteRules,
  type UiPreferences,
} from "@/storage/defaults";
import { createStorageRepositories } from "@/storage/repositories";
import type { TranslationMode, TranslationPreferences } from "@/translation/types";

function getDefaultProviderType(): ProviderProfile["type"] {
  return getChromeBuiltInAiBrowserSupport().supported
    ? chromeBuiltInAiProviderId
    : "openai-compatible";
}

const selectedProviderType = ref<ProviderProfile["type"]>(getDefaultProviderType());
const selectedPresetId = ref(defaultProviderPreset.id);
const displayName = ref(defaultProviderPreset.name);
const baseUrl = ref(defaultProviderPreset.defaultBaseUrl);
const apiKey = ref("");
const textModel = ref(defaultProviderPreset.defaultTextModel ?? "");
const visionModel = ref("");
const targetLanguage = ref(defaultTranslationPreferences.targetLanguage);
const translationMode = ref<TranslationMode>(defaultTranslationPreferences.mode);
const hasUserEditedTargetLanguage = ref(false);
const hasUserEditedTranslationMode = ref(false);
const isUiPreferencesLoaded = ref(false);
const uiTheme = ref<UiPreferences["theme"]>(defaultUiPreferences.theme);
const uiLanguage = ref(defaultUiPreferences.uiLanguage);
const siteBlacklistText = ref("");
const siteRuleAutoTranslateAllowlist = ref<string[]>(
  defaultSiteRules.autoTranslateAllowlist,
);
const siteRulesSaveState = ref<"idle" | "saved" | "error">("idle");
const timeoutMs = ref(30000);
const temperature = ref(0.3);
const maxTokens = ref(4096);
const saveState = ref<"idle" | "saved" | "error">("idle");
const testState = ref<"untested" | "testing" | "success" | "failed">("untested");
const testMessageKey = ref<OptionsMessageKey>();
const isTestInFlight = ref(false);
const testRequestId = ref(0);
const providerSectionRef = ref<HTMLElement>();
const chromeBuiltInAiRadioRef = ref<HTMLInputElement>();
const presetSelectRef = ref<HTMLSelectElement>();
const routeParams = new URLSearchParams(globalThis.location.search);
const shouldLandOnProvider = routeParams.get("section") === "provider";
const isFirstRunProviderLanding =
  shouldLandOnProvider && routeParams.get("source") === "first-run";
let translationPreferencesSaveQueue: Promise<void> = Promise.resolve();

const messages = computed(() => optionsMessages[uiLanguage.value]);
const chromeBuiltInAiSupport = computed(() => getChromeBuiltInAiBrowserSupport());
const canSelectChromeBuiltInAi = computed(() => chromeBuiltInAiSupport.value.supported);

const providerPresetOptions = computed(() =>
  providerPresets.map((preset) => ({
    ...preset,
    label: getPresetLabel(preset.id, preset.name),
  })),
);
const selectedPreset = computed(() =>
  providerPresets.find((preset) => preset.id === selectedPresetId.value),
);
const textModelOptions = computed(() => selectedPreset.value?.textModelOptions ?? []);

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

const testFeedbackMessage = computed(() =>
  testMessageKey.value ? t(testMessageKey.value) : "",
);

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

function parsePatternLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

function formatPatternLines(patterns: string[]): string {
  return patterns.join("\n");
}

function buildProviderProfile(): ProviderProfile {
  if (selectedProviderType.value === "chrome-built-in-ai") {
    return chromeBuiltInAiProviderProfile;
  }

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
  testMessageKey.value = undefined;
}

watch(providerProfileSignature, resetTestFeedback);

watch(selectedProviderType, () => {
  resetTestFeedback();
});

function getProviderTestErrorMessageKey(error: unknown): OptionsMessageKey {
  if (error instanceof ProviderError) {
    return providerErrorMessageKeys[error.code];
  }

  return providerErrorMessageKeys.unknown;
}

function applySelectedPreset() {
  const preset = selectedPreset.value;

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
  } finally {
    isUiPreferencesLoaded.value = true;
  }
}

function applyProviderProfile(profile: ProviderProfile) {
  if (!isOpenAiCompatibleProviderProfile(profile)) {
    selectedProviderType.value = "chrome-built-in-ai";
    displayName.value = profile.displayName;
    return;
  }

  selectedProviderType.value = "openai-compatible";
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
    const selectedActiveProviderId = selectStoredActiveProviderId(profiles, activeProviderId);
    const activeProfile = selectedActiveProviderId
      ? profiles.find((profile) => profile.id === selectedActiveProviderId)
      : undefined;

    if (selectedActiveProviderId && selectedActiveProviderId !== activeProviderId) {
      await Promise.resolve(
        storage.providers.setActiveProviderId(selectedActiveProviderId),
      ).catch(() => undefined);
    }

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
    if (!hasUserEditedTranslationMode.value) {
      translationMode.value = preferences.mode;
    }
    if (!hasUserEditedTargetLanguage.value) {
      targetLanguage.value = preferences.targetLanguage;
    }
  } catch {
    if (!hasUserEditedTranslationMode.value) {
      translationMode.value = defaultTranslationPreferences.mode;
    }
    if (!hasUserEditedTargetLanguage.value) {
      targetLanguage.value = defaultTranslationPreferences.targetLanguage;
    }
  }
}

async function loadSiteRules() {
  try {
    const storage = createStorageRepositories();
    const rules = await storage.siteRules.get();
    siteBlacklistText.value = formatPatternLines(rules.blacklist);
    siteRuleAutoTranslateAllowlist.value = rules.autoTranslateAllowlist;
  } catch {
    siteBlacklistText.value = formatPatternLines(defaultSiteRules.blacklist);
    siteRuleAutoTranslateAllowlist.value = defaultSiteRules.autoTranslateAllowlist;
  }
}

async function focusProviderLanding() {
  if (!shouldLandOnProvider) {
    return;
  }

  await nextTick();
  providerSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
  if (selectedProviderType.value === "chrome-built-in-ai") {
    chromeBuiltInAiRadioRef.value?.focus();
    return;
  }
  presetSelectRef.value?.focus();
}

onMounted(async () => {
  await Promise.all([
    loadUiPreferences(),
    loadActiveProviderProfile(),
    loadTranslationPreferences(),
    loadSiteRules(),
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

function queueTranslationPreferencesSave(
  buildPreferences: (preferences: TranslationPreferences) => TranslationPreferences,
): Promise<void> {
  const nextSave = translationPreferencesSaveQueue
    .catch(() => undefined)
    .then(async () => {
      const storage = createStorageRepositories();
      const preferences = await storage.translationPreferences
        .get()
        .catch(() => defaultTranslationPreferences);

      await storage.translationPreferences.save(buildPreferences(preferences));
    });

  translationPreferencesSaveQueue = nextSave;
  return nextSave;
}

async function saveTranslationMode() {
  hasUserEditedTranslationMode.value = true;
  try {
    await queueTranslationPreferencesSave((preferences) => ({
      ...preferences,
      mode: translationMode.value,
    }));
  } catch {
    // Translation mode is non-critical; keep the selected value visible.
  }
}

async function saveTargetLanguage() {
  hasUserEditedTargetLanguage.value = true;
  try {
    await queueTranslationPreferencesSave((preferences) => ({
      ...preferences,
      targetLanguage: targetLanguage.value,
    }));
  } catch {
    // Target language is non-critical; keep the selected value visible.
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

async function saveSiteRules() {
  siteRulesSaveState.value = "idle";

  const rules: SiteRules = {
    blacklist: parsePatternLines(siteBlacklistText.value),
    autoTranslateAllowlist: siteRuleAutoTranslateAllowlist.value,
  };

  try {
    const storage = createStorageRepositories();
    await storage.siteRules.save(rules);
    siteBlacklistText.value = formatPatternLines(rules.blacklist);
    siteRulesSaveState.value = "saved";
  } catch {
    siteRulesSaveState.value = "error";
  }
}

async function testConnection() {
  if (isTestInFlight.value) {
    return;
  }

  const requestId = testRequestId.value + 1;
  testRequestId.value = requestId;
  const profile = buildProviderProfile();
  if (!isOpenAiCompatibleProviderProfile(profile)) {
    return;
  }
  const testedProfileSignature = getProviderProfileSignature(profile);

  isTestInFlight.value = true;
  testState.value = "testing";
  testMessageKey.value = undefined;

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
    testMessageKey.value = "test.success";
  } catch (error) {
    if (
      requestId !== testRequestId.value ||
      testedProfileSignature !== providerProfileSignature.value
    ) {
      return;
    }

    testState.value = "failed";
    testMessageKey.value = getProviderTestErrorMessageKey(error);
  } finally {
    if (requestId === testRequestId.value) {
      isTestInFlight.value = false;
    }
  }
}
</script>

<template>
  <main
    v-if="isUiPreferencesLoaded"
    class="yoyo-shell"
  >
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

          <fieldset class="provider-type-group">
            <legend>{{ t("providerType.legend") }}</legend>
            <label>
              <input
                ref="chromeBuiltInAiRadioRef"
                v-model="selectedProviderType"
                type="radio"
                :value="chromeBuiltInAiProviderId"
                :disabled="!canSelectChromeBuiltInAi"
              >
              {{ t("providerType.chromeBuiltInAi") }}
            </label>
            <label>
              <input
                v-model="selectedProviderType"
                type="radio"
                value="openai-compatible"
              >
              {{ t("providerType.openAiCompatible") }}
            </label>
            <p class="field-hint">
              {{ t("providerType.chromeBuiltInAiRequirement") }}
            </p>
            <p
              v-if="!canSelectChromeBuiltInAi"
              class="field-error"
            >
              {{ t("providerType.chromeBuiltInAiUnavailable") }}
            </p>
          </fieldset>

          <div
            v-if="selectedProviderType === 'openai-compatible'"
            class="settings-grid"
          >
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
                :list="textModelOptions.length > 0 ? 'text-model-options' : undefined"
                autocomplete="off"
              >
              <datalist
                v-if="textModelOptions.length > 0"
                id="text-model-options"
              >
                <option
                  v-for="modelOption in textModelOptions"
                  :key="modelOption"
                  :value="modelOption"
                />
              </datalist>
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

          <section
            v-else
            class="provider-local-card"
          >
            <h3>{{ t("providerLocal.title") }}</h3>
            <p>{{ t("providerLocal.description") }}</p>
            <p>{{ t("providerLocal.requirement") }}</p>
          </section>

          <div class="button-row">
            <button
              class="primary-button"
              type="button"
              @click="saveProviderProfile"
            >
              {{ t("button.saveProvider") }}
            </button>
            <button
              v-if="selectedProviderType === 'openai-compatible'"
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
            {{ testFeedbackMessage }}
          </p>
          <p
            v-else-if="testState === 'failed'"
            class="save-feedback error"
            role="alert"
          >
            {{ testFeedbackMessage }}
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
              <select
                v-model="targetLanguage"
                @change="saveTargetLanguage"
              >
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

          <div class="site-rules-panel">
            <div class="field field-wide">
              <label for="site-blacklist">{{ t("field.siteBlacklist") }}</label>
              <textarea
                id="site-blacklist"
                v-model="siteBlacklistText"
                rows="5"
                :placeholder="t('siteBlacklist.placeholder')"
              />
              <small>{{ t("siteBlacklist.note") }}</small>
            </div>
            <div class="button-row">
              <button
                class="secondary-button"
                type="button"
                @click="saveSiteRules"
              >
                {{ t("button.saveSiteBlacklist") }}
              </button>
            </div>
            <p
              v-if="siteRulesSaveState === 'saved'"
              class="save-feedback success"
              role="status"
            >
              {{ t("siteBlacklist.saveSuccess") }}
            </p>
            <p
              v-else-if="siteRulesSaveState === 'error'"
              class="save-feedback error"
              role="alert"
            >
              {{ t("siteBlacklist.saveError") }}
            </p>
          </div>
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

            <label
              v-if="selectedProviderType === 'openai-compatible'"
              class="field"
            >
              <span>{{ t("field.timeout") }}</span>
              <input
                v-model.number="timeoutMs"
                type="number"
                min="1000"
                step="1000"
              >
            </label>

            <label
              v-if="selectedProviderType === 'openai-compatible'"
              class="field"
            >
              <span>{{ t("field.temperature") }}</span>
              <input
                v-model.number="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              >
            </label>

            <label
              v-if="selectedProviderType === 'openai-compatible'"
              class="field"
            >
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
  background: var(--yoyo-surface-soft);
}

.yoyo-shell {
  box-sizing: border-box;
  min-height: 100vh;
  color: var(--yoyo-text);
  background: var(--yoyo-surface-soft);
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.page-header {
  background: var(--yoyo-surface);
  border-bottom: 1px solid var(--yoyo-border);
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
  color: var(--yoyo-muted);
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
}

.settings-nav a:hover,
.settings-nav a:focus-visible {
  color: var(--yoyo-text);
  background: var(--yoyo-surface-muted);
  outline: none;
}

.settings-content {
  background: var(--yoyo-surface);
  border: 1px solid var(--yoyo-border);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
}

.settings-section {
  padding: 28px 32px;
  border-bottom: 1px solid var(--yoyo-border);
}

.settings-section:last-child {
  border-bottom: 0;
}

.settings-section h2 {
  margin: 0 0 16px;
  font-size: 18px;
  line-height: 1.3;
}

.provider-type-group {
  display: grid;
  gap: 10px;
  padding: 14px;
  margin: 0 0 18px;
  border: 1px solid var(--yoyo-border);
  border-radius: 10px;
}

.provider-type-group legend {
  padding: 0 6px;
  color: var(--yoyo-text-soft);
  font-size: 13px;
  font-weight: 700;
}

.provider-type-group label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--yoyo-text);
  font-size: 14px;
  font-weight: 600;
}

.provider-type-group input {
  width: 16px;
  height: 16px;
}

.field-hint,
.field-error {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.field-hint {
  color: var(--yoyo-muted);
}

.field-error {
  color: #b3261e;
}

.provider-local-card {
  padding: 18px;
  color: var(--yoyo-text-soft);
  background: var(--yoyo-surface-muted);
  border: 1px solid var(--yoyo-border);
  border-radius: 12px;
}

.provider-local-card h3 {
  margin: 0 0 8px;
  color: var(--yoyo-text);
  font-size: 16px;
  line-height: 1.3;
}

.provider-local-card p {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 1.5;
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
  color: var(--yoyo-text-soft);
  font-size: 13px;
  font-weight: 600;
}

.field-wide {
  grid-column: 1 / -1;
}

.field input,
.field select,
.field textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  color: var(--yoyo-text);
  font: inherit;
  font-weight: 400;
  background: var(--yoyo-surface);
  border: 1px solid var(--yoyo-border-strong);
  border-radius: 6px;
}

.field input:focus-visible,
.field select:focus-visible,
.field textarea:focus-visible {
  border-color: var(--yoyo-brand-600);
  outline: 3px solid var(--yoyo-focus-ring);
  outline-offset: 2px;
}

.field textarea {
  resize: vertical;
  line-height: 1.5;
}

.field small,
.section-note {
  margin: 0;
  color: var(--yoyo-muted);
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
  background: var(--yoyo-brand-700);
  border: 1px solid var(--yoyo-brand-700);
}

.secondary-button {
  color: var(--yoyo-text);
  background: var(--yoyo-surface);
  border: 1px solid var(--yoyo-border-strong);
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
  color: var(--yoyo-text-soft);
  line-height: 1.6;
}

.site-rules-panel {
  margin-top: 18px;
}

.static-field {
  min-height: 40px;
  justify-content: center;
}

.static-field strong {
  color: var(--yoyo-text);
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
