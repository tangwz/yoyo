import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryStorageArea,
  providerProfileRepository,
  uiPreferenceRepository,
} from "@/storage/repositories";

describe("storage repositories", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores provider profiles in local storage", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = providerProfileRepository(local, sync);

    await repository.saveProfile({
      id: "provider-1",
      displayName: "Local Provider",
      type: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "secret",
      textModel: "gpt-4.1-mini",
      requestParams: { timeoutMs: 30000 },
    });

    expect(await local.get("yoyo.providerProfiles")).toEqual({
      "yoyo.providerProfiles": [
        expect.objectContaining({ id: "provider-1", apiKey: "secret" }),
      ],
    });
    expect(await sync.get("yoyo.providerProfiles")).toEqual({});
  });

  it("stores UI preferences in sync storage", async () => {
    const local = createInMemoryStorageArea();
    const sync = createInMemoryStorageArea();
    const repository = uiPreferenceRepository(local, sync);

    await repository.save({ theme: "light", uiLanguage: "zh-CN" });

    expect(await sync.get("yoyo.uiPreferences")).toEqual({
      "yoyo.uiPreferences": { theme: "light", uiLanguage: "zh-CN" },
    });
    expect(await local.get("yoyo.uiPreferences")).toEqual({});
  });
});
