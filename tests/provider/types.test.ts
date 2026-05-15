import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChromeBuiltInAiProviderProfile,
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";

describe("provider profile types", () => {
  it("supports OpenAI-compatible profiles with remote provider settings", () => {
    const profile: ProviderProfile = {
      id: "openai",
      displayName: "OpenAI Compatible",
      type: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      apiKey: "secret",
      textModel: "gpt-4.1-mini",
    };

    expect(profile.type).toBe("openai-compatible");
    expectTypeOf(profile).toMatchTypeOf<OpenAiCompatibleProviderProfile>();
  });

  it("supports Chrome Built-in AI profiles without remote provider settings", () => {
    const profile: ProviderProfile = {
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };

    expect(profile.type).toBe("chrome-built-in-ai");
    expectTypeOf(profile).toMatchTypeOf<ChromeBuiltInAiProviderProfile>();
  });
});
