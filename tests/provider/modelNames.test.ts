import { describe, expect, it } from "vitest";

import {
  createTextModelCandidates,
  normalizeModelNameForProfile,
} from "@/provider/modelNames";
import type { OpenAiCompatibleProviderProfile } from "@/provider/types";

describe("provider model names", () => {
  it("canonicalizes current OpenAI, DeepSeek, and Kimi preset model options", () => {
    expect(normalizeModelNameForProfile({ id: "openai", presetId: "openai" }, " GPT-5-MINI ")).toBe(
      "gpt-5-mini",
    );
    expect(
      normalizeModelNameForProfile({ id: "deepseek", presetId: "deepseek" }, "DeepSeek-V4-Pro"),
    ).toBe("deepseek-v4-pro");
    expect(normalizeModelNameForProfile({ id: "kimi", presetId: "kimi" }, " KIMI-K2.6 ")).toBe(
      "kimi-k2.6",
    );
  });

  it("canonicalizes Xiaomi MiMo preset model options", () => {
    const context = { id: "xiaomi-mimo", presetId: "xiaomi-mimo" };

    expect(normalizeModelNameForProfile(context, " mimo-v2.5 ")).toBe("MiMo-V2.5");
    expect(normalizeModelNameForProfile(context, "mimo-v2.5-pro")).toBe("MiMo-V2.5-Pro");
  });

  it("includes the canonical Xiaomi MiMo Pro candidate for lower-case input", () => {
    const profile: OpenAiCompatibleProviderProfile = {
      id: "xiaomi-mimo",
      displayName: "Xiaomi MiMo",
      presetId: "xiaomi-mimo",
      type: "openai-compatible",
      baseURL: "https://api.xiaomimimo.com/v1",
      apiKey: "secret",
      textModel: "mimo-v2.5-pro",
    };

    expect(createTextModelCandidates(profile)).toEqual([
      "mimo-v2.5-pro",
      "MiMo-V2.5-Pro",
    ]);
  });

  it("prioritizes lower-case Xiaomi MiMo model candidates by default", () => {
    const profile: OpenAiCompatibleProviderProfile = {
      id: "xiaomi-mimo",
      displayName: "Xiaomi MiMo",
      presetId: "xiaomi-mimo",
      type: "openai-compatible",
      baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "secret",
      textModel: "MiMo-V2.5",
    };

    expect(createTextModelCandidates(profile)).toEqual(["mimo-v2.5", "MiMo-V2.5"]);
  });

  it("prioritizes lower-case Xiaomi MiMo model candidates for custom Xiaomi endpoints", () => {
    const profile: OpenAiCompatibleProviderProfile = {
      id: "custom-ai",
      displayName: "Custom Xiaomi",
      presetId: "custom",
      type: "openai-compatible",
      baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "secret",
      textModel: "MiMo-V2.5",
    };

    expect(createTextModelCandidates(profile)).toEqual(["mimo-v2.5", "MiMo-V2.5"]);
  });
});
