import { describe, expect, it } from "vitest";
import {
  buildProviderStatusResponse,
  selectReadyProviderProfile,
  selectStoredActiveProviderId,
} from "@/background/providerStatus";
import type { ProviderProfile } from "@/provider/types";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
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

  it("returns configured status for a ready active provider", () => {
    const profiles = [profile()];

    expect(selectReadyProviderProfile(profiles, "provider-1")).toBe(profiles[0]);
    expect(buildProviderStatusResponse(profiles, "provider-1")).toEqual({
      type: "providerStatus",
      configured: true,
      readiness: "ready",
      providerLabel: "Work Provider / api.example.com",
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
    });
  });
});
