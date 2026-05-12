import { describe, expect, it } from "vitest";

import { defaultProviderPreset, providerPresets } from "@/provider/presets";

describe("provider presets", () => {
  it("keeps OpenAI as the explicit first-run default preset", () => {
    expect(defaultProviderPreset).toMatchObject({
      id: "openai",
      name: "OpenAI",
      type: "openai-compatible",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultTextModel: "gpt-4.1-mini",
    });
  });

  it("includes OpenAI-compatible presets for common providers", () => {
    expect(providerPresets).toEqual(
      expect.arrayContaining([
        {
          id: "kimi",
          name: "Kimi",
          type: "openai-compatible",
          defaultBaseUrl: "https://api.moonshot.ai/v1",
          defaultTextModel: "moonshot-v1-8k",
        },
        {
          id: "glm",
          name: "GLM",
          type: "openai-compatible",
          defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
          defaultTextModel: "glm-5.1",
        },
        {
          id: "minimax",
          name: "MiniMax",
          type: "openai-compatible",
          defaultBaseUrl: "https://api.minimax.io/v1",
          defaultTextModel: "MiniMax-M2.7",
        },
        {
          id: "xiaomi-mimo",
          name: "Xiaomi MiMo",
          type: "openai-compatible",
          defaultBaseUrl: "https://api.xiaomimimo.com/v1",
          defaultTextModel: "mimo-v2-flash",
        },
      ]),
    );
  });
});
