import type { ProviderPreset } from "@/provider/types";

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
