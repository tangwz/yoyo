import type {
  ChromeBuiltInAiProviderProfile,
  ProviderPreset,
} from "@/provider/types";

export const chromeBuiltInAiProviderId = "chrome-built-in-ai";

export const chromeBuiltInAiProviderProfile: ChromeBuiltInAiProviderProfile = {
  id: chromeBuiltInAiProviderId,
  displayName: "Chrome Built-in AI",
  type: "chrome-built-in-ai",
};

export const providerPresets: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultTextModel: "gpt-4.1-mini",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultTextModel: "deepseek-chat",
  },
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
    defaultTextModel: "MiMo-V2.5",
    textModelOptions: ["MiMo-V2.5", "MiMo-V2.5-Pro"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "custom",
    name: "Custom OpenAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "",
  },
];

export const defaultProviderPreset =
  providerPresets.find((preset) => preset.id === "openai") ?? providerPresets[0];
