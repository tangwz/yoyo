import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryStorageArea,
  providerProfileRepository,
  translationPreferenceRepository,
  uiPreferenceRepository,
} from "@/storage/repositories";
import { isTargetLanguage } from "@/translation/types";

describe("storage repositories", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores provider profiles in local storage", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = providerProfileRepository({ privateStorage: local });

    await repository.saveProfile({
      id: "provider-1",
      displayName: "Local Provider",
      type: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "secret",
      textModel: "gpt-5-mini",
      requestParams: { timeoutMs: 30000 },
    });

    expect(await local.get("yoyo.providerProfiles")).toEqual({
      "yoyo.providerProfiles": [
        expect.objectContaining({ id: "provider-1", apiKey: "secret" }),
      ],
    });
    expect(await sync.get("yoyo.providerProfiles")).toEqual({});
  });

  it("keeps Chrome Built-in AI profiles without requiring remote settings", async () => {
    const privateStorage = createInMemoryStorageArea();
    const repository = providerProfileRepository({ privateStorage });

    await repository.saveProfile({
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    });

    await expect(repository.listProfiles()).resolves.toEqual([
      {
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      },
    ]);
  });

  it("stores UI preferences in sync storage", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = uiPreferenceRepository({ syncedStorage: sync });

    await repository.save({ theme: "light", uiLanguage: "zh-CN" });

    expect(await sync.get("yoyo.uiPreferences")).toEqual({
      "yoyo.uiPreferences": { theme: "light", uiLanguage: "zh-CN" },
    });
    expect(await local.get("yoyo.uiPreferences")).toEqual({});
  });

  it("falls back to default UI preferences for corrupt sync storage data", async () => {
    const sync = createInMemoryStorageArea();
    const repository = uiPreferenceRepository({ syncedStorage: sync });

    for (const storedValue of [null, "zh-CN", 1, true, ["zh-CN"], { theme: "dark" }]) {
      await sync.set({ "yoyo.uiPreferences": storedValue });

      await expect(repository.get()).resolves.toEqual({
        theme: "light",
        uiLanguage: "zh-CN",
      });
    }
  });

  it("falls back to the default UI language for unsupported UI language values", async () => {
    const sync = createInMemoryStorageArea();
    const repository = uiPreferenceRepository({ syncedStorage: sync });

    for (const uiLanguage of ["", "fr-FR", 1, true, null, ["zh-CN"]]) {
      await sync.set({
        "yoyo.uiPreferences": { theme: "light", uiLanguage },
      });

      await expect(repository.get()).resolves.toEqual({
        theme: "light",
        uiLanguage: "zh-CN",
      });
    }
  });

  it("defaults translation preferences to lazy viewport mode and simplified Chinese target language", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = translationPreferenceRepository({ syncedStorage: sync });

    await expect(repository.get()).resolves.toEqual({
      mode: "lazyViewport",
      targetLanguage: "zh-CN",
    });

    await repository.save({ mode: "fullPage", targetLanguage: "en" });

    expect(await sync.get("yoyo.translationPreferences")).toEqual({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "en" },
    });
    expect(await local.get("yoyo.translationPreferences")).toEqual({});
  });

  it("migrates legacy translation preferences without a target language", async () => {
    const sync = createInMemoryStorageArea();
    const repository = translationPreferenceRepository({ syncedStorage: sync });

    await sync.set({ "yoyo.translationPreferences": { mode: "fullPage" } });

    await expect(repository.get()).resolves.toEqual({
      mode: "fullPage",
      targetLanguage: "zh-CN",
    });
  });

  it("falls back to the default target language for unsupported target language values", async () => {
    const sync = createInMemoryStorageArea();
    const repository = translationPreferenceRepository({ syncedStorage: sync });

    for (const targetLanguage of ["", "fr", 1, true, null, ["zh-CN"]]) {
      await sync.set({
        "yoyo.translationPreferences": { mode: "fullPage", targetLanguage },
      });

      await expect(repository.get()).resolves.toEqual({
        mode: "fullPage",
        targetLanguage: "zh-CN",
      });
    }
  });

  it("falls back to default translation preferences for corrupt sync storage data", async () => {
    const sync = createInMemoryStorageArea();
    const repository = translationPreferenceRepository({ syncedStorage: sync });

    for (const storedValue of [null, "fullPage", 1, true, ["fullPage"], { mode: "unknown" }]) {
      await sync.set({ "yoyo.translationPreferences": storedValue });

      await expect(repository.get()).resolves.toEqual({
        mode: "lazyViewport",
        targetLanguage: "zh-CN",
      });
    }
  });

  it("identifies supported target language values", () => {
    for (const targetLanguage of ["zh-CN", "zh-TW", "en", "ja", "ko"]) {
      expect(isTargetLanguage(targetLanguage)).toBe(true);
    }

    for (const targetLanguage of ["", "fr", 1, true, null, ["zh-CN"]]) {
      expect(isTargetLanguage(targetLanguage)).toBe(false);
    }
  });

  it("stores active provider id in local storage", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = providerProfileRepository({ privateStorage: local });

    await repository.setActiveProviderId("provider-1");

    expect(await local.get("yoyo.activeProviderId")).toEqual({
      "yoyo.activeProviderId": "provider-1",
    });
    expect(await sync.get("yoyo.activeProviderId")).toEqual({});
  });

  it("does not mutate stored profiles when a returned profile list changes", async () => {
    const local = createInMemoryStorageArea();
    const repository = providerProfileRepository({ privateStorage: local });

    await repository.saveProfile({
      id: "provider-1",
      displayName: "Local Provider",
      type: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "secret",
      textModel: "gpt-5-mini",
      requestParams: { timeoutMs: 30000 },
    });

    const profiles = await repository.listProfiles();
    if (profiles[0]?.type === "openai-compatible") {
      profiles[0].apiKey = "mutated";
    }
    profiles.push({
      id: "provider-2",
      displayName: "Mutated Provider",
      type: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "mutated-secret",
      textModel: "gpt-5-mini",
    });

    expect(await repository.listProfiles()).toEqual([
      expect.objectContaining({ id: "provider-1", apiKey: "secret" }),
    ]);
  });
});
