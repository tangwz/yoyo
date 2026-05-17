import { describe, expect, it, vi } from "vitest";
import {
  buildProviderStatusResponse,
  getStoredProviderState,
  selectReadyProviderProfile,
  selectStoredActiveProviderId,
} from "@/background/providerStatus";
import type {
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";

function profile(
  overrides: Partial<OpenAiCompatibleProviderProfile> = {},
): OpenAiCompatibleProviderProfile {
  return {
    id: "provider-1",
    displayName: "Work Provider",
    type: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    apiKey: "secret-key",
    textModel: "gpt-4.1-mini",
    ...overrides,
  };
}

describe("provider status", () => {
  it("does not fall back to the first profile when activeProviderId is missing", () => {
    const profiles = [profile()];

    expect(selectReadyProviderProfile(profiles, undefined)).toBeUndefined();
    expect(buildProviderStatusResponse(profiles, undefined)).toEqual({
      type: "providerStatus",
      configured: false,
      readiness: "missingProvider",
      providerLabel: "未配置翻译服务",
      providerMode: "remote",
    });
  });

  it("selects the first complete profile only for legacy storage without an active id", () => {
    const profiles = [
      profile({ id: "incomplete", apiKey: "" }),
      profile({ id: "ready", displayName: "Ready Provider" }),
    ];

    expect(selectStoredActiveProviderId(profiles, undefined)).toBe("ready");
    expect(selectStoredActiveProviderId(profiles, "incomplete")).toBe("incomplete");
    expect(
      selectStoredActiveProviderId([profile({ id: "incomplete", textModel: " " })], undefined),
    ).toBeUndefined();
  });

  it("skips unsupported Chrome Built-in AI when selecting a legacy fallback provider", () => {
    const profiles: ProviderProfile[] = [
      {
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      },
      profile({ id: "ready", displayName: "Ready Provider" }),
    ];

    expect(
      selectStoredActiveProviderId(profiles, undefined, {
        chromeBuiltInAiBrowserSupport: {
          supported: false,
          reason: "browserUnsupported",
          minimumChromeVersion: 138,
        },
      }),
    ).toBe("ready");
  });

  it("falls back to a complete profile when the stored active id is stale", () => {
    const profiles = [
      profile({ id: "incomplete", apiKey: "" }),
      profile({ id: "ready", displayName: "Ready Provider" }),
    ];

    expect(selectStoredActiveProviderId(profiles, "deleted-provider")).toBe("ready");
  });

  it("keeps returning migrated provider state when persistence fails", async () => {
    const profiles = [profile({ id: "ready" })];
    const persistActiveProviderId = vi.fn().mockRejectedValue(new Error("storage unavailable"));

    await expect(
      getStoredProviderState({
        loadActiveProviderId: async () => undefined,
        loadProfiles: async () => profiles,
        persistActiveProviderId,
      }),
    ).resolves.toEqual({
      activeProviderId: "ready",
      profiles,
    });
    expect(persistActiveProviderId).toHaveBeenCalledWith("ready");
  });

  it("returns configured status for a ready active provider", () => {
    const profiles = [profile()];

    expect(selectReadyProviderProfile(profiles, "provider-1")).toBe(profiles[0]);
    expect(buildProviderStatusResponse(profiles, "provider-1")).toEqual({
      type: "providerStatus",
      configured: true,
      readiness: "ready",
      providerLabel: "Work Provider / api.example.com",
      providerMode: "remote",
    });
  });

  it("returns incomplete status for a profile without a text model", () => {
    const profiles = [profile({ textModel: " " })];

    expect(selectReadyProviderProfile(profiles, "provider-1")).toBeUndefined();
    expect(buildProviderStatusResponse(profiles, "provider-1")).toEqual({
      type: "providerStatus",
      configured: false,
      readiness: "missingTextModel",
      providerLabel: "未配置翻译服务",
      providerMode: "remote",
    });
  });

  it("returns local-only status details for an unsupported selected Chrome Built-in AI provider", () => {
    const profiles: ProviderProfile[] = [
      {
        id: "chrome-built-in-ai",
        displayName: "Custom Built-in Provider",
        type: "chrome-built-in-ai",
      },
    ];

    expect(
      buildProviderStatusResponse(profiles, "chrome-built-in-ai", {
        chromeBuiltInAiBrowserSupport: {
          supported: false,
          reason: "browserUnsupported",
          minimumChromeVersion: 138,
        },
      }),
    ).toEqual({
      type: "providerStatus",
      configured: false,
      readiness: "browserUnsupported",
      providerLabel: "Chrome Built-in AI / Local only",
      providerMode: "local-only",
    });
  });
});
