import { describe, expect, it } from "vitest";

import {
  createTextModelCandidates,
  normalizeModelNameForProfile,
} from "@/provider/modelNames";
import type { OpenAiCompatibleProviderProfile } from "@/provider/types";

describe("provider model names", () => {
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
});
