import type { ProviderProfile } from "@/provider/types";
import { defaultUiPreferences, type UiPreferences } from "@/storage/defaults";
import { storageKeys } from "@/storage/storageKeys";

type StorageGetKeys = string | string[] | Record<string, unknown> | null;

type StorageArea = {
  get(keys?: StorageGetKeys): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

type ExtensionStorageRuntime = {
  chrome: {
    storage: {
      local: StorageArea;
      sync: StorageArea;
    };
  };
};

export function createInMemoryStorageArea(): StorageArea {
  const values = new Map<string, unknown>();

  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (typeof keys === "string") {
        return values.has(keys) ? { [keys]: values.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => values.has(key))
            .map((key) => [key, values.get(key)]),
        );
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            values.has(key) ? values.get(key) : fallback,
          ]),
        );
      }
      return Object.fromEntries(values.entries());
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, value);
      }
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
      }
    },
  };
}

export function providerProfileRepository(local: StorageArea, sync: StorageArea) {
  void sync;

  return {
    async listProfiles(): Promise<ProviderProfile[]> {
      const result = await local.get({ [storageKeys.providerProfiles]: [] });
      return result[storageKeys.providerProfiles] as ProviderProfile[];
    },

    async saveProfile(profile: ProviderProfile): Promise<void> {
      const profiles = await this.listProfiles();
      const nextProfiles = [
        ...profiles.filter((existing) => existing.id !== profile.id),
        profile,
      ];
      await local.set({ [storageKeys.providerProfiles]: nextProfiles });
    },

    async getActiveProviderId(): Promise<string | undefined> {
      const result = await local.get(storageKeys.activeProviderId);
      return result[storageKeys.activeProviderId] as string | undefined;
    },

    async setActiveProviderId(providerId: string): Promise<void> {
      await local.set({ [storageKeys.activeProviderId]: providerId });
    },
  };
}

export function uiPreferenceRepository(local: StorageArea, sync: StorageArea) {
  void local;

  return {
    async get(): Promise<UiPreferences> {
      const result = await sync.get({
        [storageKeys.uiPreferences]: defaultUiPreferences,
      });
      return result[storageKeys.uiPreferences] as UiPreferences;
    },

    async save(preferences: UiPreferences): Promise<void> {
      await sync.set({ [storageKeys.uiPreferences]: preferences });
    },
  };
}

export function createStorageRepositories() {
  const runtime = globalThis as typeof globalThis & ExtensionStorageRuntime;

  return {
    providers: providerProfileRepository(
      runtime.chrome.storage.local,
      runtime.chrome.storage.sync,
    ),
    uiPreferences: uiPreferenceRepository(
      runtime.chrome.storage.local,
      runtime.chrome.storage.sync,
    ),
  };
}
