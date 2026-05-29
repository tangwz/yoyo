import type { ProviderProfile } from "@/provider/types";
import {
  defaultExperimentalFlags,
  defaultSelectionTranslationPreferences,
  defaultSiteRules,
  defaultTranslationPreferences,
  defaultUiPreferences,
  isUiLanguage,
  type ExperimentalFlags,
  type SelectionTranslationPreferences,
  type SiteRules,
  type UiPreferences,
} from "@/storage/defaults";
import { storageKeys } from "@/storage/storageKeys";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";
import {
  isTargetLanguage,
  type TargetLanguage,
  type TranslationMode,
  type TranslationPreferences,
} from "@/translation/types";

type StorageGetKeys = string | string[] | Record<string, unknown> | null;

type StorageArea = {
  get(keys?: StorageGetKeys): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

type ProviderProfileRepositoryDependencies = {
  privateStorage: StorageArea;
};

type UiPreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};

type TranslationPreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};

type SubtitlePreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};

type SelectionTranslationPreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};

type SiteRuleRepositoryDependencies = {
  privateStorage: StorageArea;
};

type ExperimentalFlagRepositoryDependencies = {
  privateStorage: StorageArea;
};

type ExtensionStorageRuntime = {
  chrome: {
    storage: {
      local: StorageArea;
      sync: StorageArea;
    };
  };
};

function cloneStorageValue<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviderProfile(value: unknown): ProviderProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "chrome-built-in-ai") {
    return {
      id: "chrome-built-in-ai",
      displayName:
        typeof value.displayName === "string" && value.displayName.trim()
          ? value.displayName
          : "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };
  }

  if (value.type !== "openai-compatible") {
    return undefined;
  }

  return {
    id: typeof value.id === "string" ? value.id : "custom",
    displayName:
      typeof value.displayName === "string" ? value.displayName : "Custom Provider",
    presetId: typeof value.presetId === "string" ? value.presetId : undefined,
    type: "openai-compatible",
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    textModel: typeof value.textModel === "string" ? value.textModel : "",
    visionModel: typeof value.visionModel === "string" ? value.visionModel : undefined,
    requestParams: isRecord(value.requestParams) ? value.requestParams : undefined,
  };
}

function normalizeTranslationMode(value: unknown): TranslationMode {
  return value === "fullPage" || value === "lazyViewport"
    ? value
    : defaultTranslationPreferences.mode;
}

function normalizeTargetLanguage(value: unknown): TargetLanguage {
  return isTargetLanguage(value) ? value : defaultTranslationPreferences.targetLanguage;
}

function normalizeUiPreferences(value: unknown): UiPreferences {
  if (!isRecord(value)) {
    return defaultUiPreferences;
  }

  return {
    theme: value.theme === "light" ? value.theme : defaultUiPreferences.theme,
    uiLanguage: isUiLanguage(value.uiLanguage)
      ? value.uiLanguage
      : defaultUiPreferences.uiLanguage,
  };
}

function normalizeSelectionTranslationPreferences(
  value: unknown,
): SelectionTranslationPreferences {
  if (!isRecord(value)) {
    return defaultSelectionTranslationPreferences;
  }

  const providerId =
    typeof value.providerId === "string" && value.providerId.trim().length > 0
      ? value.providerId
      : undefined;

  return providerId === undefined ? {} : { providerId };
}

function normalizePatternList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value.flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }

    const pattern = item.trim();
    return pattern ? [pattern] : [];
  });

  return [...new Set(normalized)];
}

function normalizeSiteRules(value: unknown): SiteRules {
  if (!isRecord(value)) {
    return defaultSiteRules;
  }

  return {
    blacklist: normalizePatternList(value.blacklist),
    autoTranslateAllowlist: normalizePatternList(value.autoTranslateAllowlist),
  };
}

function normalizeExperimentalFlags(value: unknown): ExperimentalFlags {
  if (!isRecord(value)) {
    return defaultExperimentalFlags;
  }

  return {
    translateMoreVisibleText:
      typeof value.translateMoreVisibleText === "boolean"
        ? value.translateMoreVisibleText
        : defaultExperimentalFlags.translateMoreVisibleText,
  };
}

export function createInMemoryStorageArea(): StorageArea {
  const values = new Map<string, unknown>();

  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (typeof keys === "string") {
        return values.has(keys)
          ? { [keys]: cloneStorageValue(values.get(keys)) }
          : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => values.has(key))
            .map((key) => [key, cloneStorageValue(values.get(key))]),
        );
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            cloneStorageValue(values.has(key) ? values.get(key) : fallback),
          ]),
        );
      }
      return Object.fromEntries(
        [...values.entries()].map(([key, value]) => [
          key,
          cloneStorageValue(value),
        ]),
      );
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, cloneStorageValue(value));
      }
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
      }
    },
  };
}

export function providerProfileRepository({
  privateStorage,
}: ProviderProfileRepositoryDependencies) {
  async function listProfiles(): Promise<ProviderProfile[]> {
    const result = await privateStorage.get({
      [storageKeys.providerProfiles]: [],
    });
    const profiles = result[storageKeys.providerProfiles];

    if (!Array.isArray(profiles)) {
      return [];
    }

    return profiles.flatMap((profile) => {
      const normalizedProfile = normalizeProviderProfile(profile);
      return normalizedProfile ? [normalizedProfile] : [];
    });
  }

  async function saveProfile(profile: ProviderProfile): Promise<void> {
    const profiles = await listProfiles();
    const nextProfiles = [
      ...profiles.filter((existing) => existing.id !== profile.id),
      profile,
    ];
    await privateStorage.set({ [storageKeys.providerProfiles]: nextProfiles });
  }

  async function getActiveProviderId(): Promise<string | undefined> {
    const result = await privateStorage.get(storageKeys.activeProviderId);
    return result[storageKeys.activeProviderId] as string | undefined;
  }

  async function setActiveProviderId(providerId: string): Promise<void> {
    await privateStorage.set({ [storageKeys.activeProviderId]: providerId });
  }

  return {
    listProfiles,
    saveProfile,
    getActiveProviderId,
    setActiveProviderId,
  };
}

export function uiPreferenceRepository({
  syncedStorage,
}: UiPreferenceRepositoryDependencies) {
  async function get(): Promise<UiPreferences> {
    const result = await syncedStorage.get({
      [storageKeys.uiPreferences]: defaultUiPreferences,
    });
    return normalizeUiPreferences(result[storageKeys.uiPreferences]);
  }

  async function save(preferences: UiPreferences): Promise<void> {
    await syncedStorage.set({ [storageKeys.uiPreferences]: preferences });
  }

  return { get, save };
}

export function translationPreferenceRepository({
  syncedStorage,
}: TranslationPreferenceRepositoryDependencies) {
  async function get(): Promise<TranslationPreferences> {
    const result = await syncedStorage.get({
      [storageKeys.translationPreferences]: defaultTranslationPreferences,
    });
    const preferences = result[storageKeys.translationPreferences];

    return isRecord(preferences)
      ? {
          mode: normalizeTranslationMode(preferences.mode),
          targetLanguage: normalizeTargetLanguage(preferences.targetLanguage),
        }
      : defaultTranslationPreferences;
  }

  async function save(preferences: TranslationPreferences): Promise<void> {
    await syncedStorage.set({ [storageKeys.translationPreferences]: preferences });
  }

  return { get, save };
}

export function selectionTranslationPreferenceRepository({
  syncedStorage,
}: SelectionTranslationPreferenceRepositoryDependencies) {
  async function get(): Promise<SelectionTranslationPreferences> {
    const result = await syncedStorage.get({
      [storageKeys.selectionTranslationPreferences]:
        defaultSelectionTranslationPreferences,
    });

    return normalizeSelectionTranslationPreferences(
      result[storageKeys.selectionTranslationPreferences],
    );
  }

  async function save(preferences: SelectionTranslationPreferences): Promise<void> {
    await syncedStorage.set({
      [storageKeys.selectionTranslationPreferences]:
        normalizeSelectionTranslationPreferences(preferences),
    });
  }

  return { get, save };
}

export function siteRuleRepository({ privateStorage }: SiteRuleRepositoryDependencies) {
  async function get(): Promise<SiteRules> {
    const result = await privateStorage.get({
      [storageKeys.siteRules]: defaultSiteRules,
    });
    return normalizeSiteRules(result[storageKeys.siteRules]);
  }

  async function save(rules: SiteRules): Promise<void> {
    await privateStorage.set({ [storageKeys.siteRules]: normalizeSiteRules(rules) });
  }

  return { get, save };
}

export function experimentalFlagRepository({
  privateStorage,
}: ExperimentalFlagRepositoryDependencies) {
  async function get(): Promise<ExperimentalFlags> {
    const result = await privateStorage.get({
      [storageKeys.experimentalFlags]: defaultExperimentalFlags,
    });
    return normalizeExperimentalFlags(result[storageKeys.experimentalFlags]);
  }

  async function save(flags: ExperimentalFlags): Promise<void> {
    await privateStorage.set({
      [storageKeys.experimentalFlags]: normalizeExperimentalFlags(flags),
    });
  }

  return { get, save };
}

export function subtitlePreferenceRepository({
  syncedStorage,
}: SubtitlePreferenceRepositoryDependencies) {
  async function get(): Promise<SubtitlePreferences> {
    const result = await syncedStorage.get({
      [storageKeys.subtitlePreferences]: defaultSubtitlePreferences,
    });
    return normalizeSubtitlePreferences(result[storageKeys.subtitlePreferences]);
  }

  async function save(preferences: SubtitlePreferences): Promise<void> {
    await syncedStorage.set({
      [storageKeys.subtitlePreferences]: normalizeSubtitlePreferences(preferences),
    });
  }

  return { get, save };
}

export type StorageRepositories = {
  providers: ReturnType<typeof providerProfileRepository>;
  uiPreferences: ReturnType<typeof uiPreferenceRepository>;
  translationPreferences: ReturnType<typeof translationPreferenceRepository>;
  selectionTranslationPreferences: ReturnType<
    typeof selectionTranslationPreferenceRepository
  >;
  subtitlePreferences: ReturnType<typeof subtitlePreferenceRepository>;
  siteRules: ReturnType<typeof siteRuleRepository>;
  experimentalFlags: ReturnType<typeof experimentalFlagRepository>;
};

export function createStorageRepositories(): StorageRepositories {
  const runtime = globalThis as typeof globalThis & ExtensionStorageRuntime;
  const storage = runtime.chrome.storage;

  return {
    providers: providerProfileRepository({ privateStorage: storage.local }),
    uiPreferences: uiPreferenceRepository({ syncedStorage: storage.sync }),
    translationPreferences: translationPreferenceRepository({ syncedStorage: storage.sync }),
    selectionTranslationPreferences: selectionTranslationPreferenceRepository({
      syncedStorage: storage.sync,
    }),
    subtitlePreferences: subtitlePreferenceRepository({ syncedStorage: storage.sync }),
    siteRules: siteRuleRepository({ privateStorage: storage.local }),
    experimentalFlags: experimentalFlagRepository({ privateStorage: storage.local }),
  };
}
