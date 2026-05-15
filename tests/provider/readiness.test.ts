import { describe, expect, expectTypeOf, it } from "vitest";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
} from "@/provider/readiness";
import type { OpenAiCompatibleProviderProfile, ProviderProfile } from "@/provider/types";

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

describe("provider readiness", () => {
  it("requires an active provider id", () => {
    expect(evaluateProviderReadiness([], undefined)).toEqual({
      readiness: "missingProvider",
    });
    expect(evaluateProviderReadiness([profile()], undefined)).toEqual({
      readiness: "missingProvider",
    });
  });

  it("rejects an active id that does not match a saved profile", () => {
    expect(evaluateProviderReadiness([profile()], "missing-id")).toEqual({
      readiness: "invalidActiveProvider",
    });
  });

  it("reports missing required provider fields", () => {
    expect(
      evaluateProviderReadiness([profile({ apiKey: "   " })], "provider-1")
        .readiness,
    ).toBe("missingApiKey");
    expect(
      evaluateProviderReadiness([profile({ baseURL: "" })], "provider-1")
        .readiness,
    ).toBe("missingBaseURL");
    expect(
      evaluateProviderReadiness([profile({ textModel: " " })], "provider-1")
        .readiness,
    ).toBe("missingTextModel");
  });

  it("returns ready with the active profile when required fields are present", () => {
    const activeProfile = profile();
    const result = evaluateProviderReadiness([activeProfile], "provider-1");

    expect(result).toEqual({
      readiness: "ready",
      profile: activeProfile,
    });
    if (result.readiness === "ready" && result.profile.type === "openai-compatible") {
      expectTypeOf(result.profile).toEqualTypeOf<OpenAiCompatibleProviderProfile>();
    }
    expect(resolveReadyProviderProfile([activeProfile], "provider-1")).toBe(
      activeProfile,
    );
  });

  it("treats Chrome Built-in AI as ready when browser support is present", () => {
    const activeProfile: ProviderProfile = {
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };

    expect(
      evaluateProviderReadiness([activeProfile], "chrome-built-in-ai", {
        chromeBuiltInAiBrowserSupport: {
          supported: true,
          reason: "supported",
          minimumChromeVersion: 138,
          detectedChromeVersion: 138,
        },
      }),
    ).toEqual({
      readiness: "ready",
      profile: activeProfile,
    });
  });

  it("rejects Chrome Built-in AI when Chrome is below the required version", () => {
    const activeProfile: ProviderProfile = {
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };

    expect(
      evaluateProviderReadiness([activeProfile], "chrome-built-in-ai", {
        chromeBuiltInAiBrowserSupport: {
          supported: false,
          reason: "chromeVersionTooOld",
          minimumChromeVersion: 138,
          detectedChromeVersion: 137,
        },
      }).readiness,
    ).toBe("browserUnsupported");
  });

  it("formats provider labels without exposing API keys", () => {
    expect(formatProviderLabel(profile())).toBe("Work Provider / api.example.com");
    expect(formatProviderLabel(undefined)).toBe("未配置翻译服务");
    expect(formatProviderLabel(profile({ baseURL: "not a url" }))).toBe(
      "Work Provider",
    );
  });

  it("formats Chrome Built-in AI provider labels without remote host details", () => {
    expect(
      formatProviderLabel({
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      }),
    ).toBe("Chrome Built-in AI / Local only");
  });
});
