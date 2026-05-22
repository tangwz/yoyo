export type ProviderType = "openai-compatible" | "chrome-built-in-ai";

export type ProviderTraceContext = {
  taskId?: string;
  batchId?: string;
  stage?: "page" | "lazy" | "selection";
  providerType: ProviderType;
  segmentCount?: number;
  sourceCharCount?: number;
};

export type ProviderPreset = {
  id: string;
  name: string;
  type: "openai-compatible";
  defaultBaseUrl: string;
  defaultTextModel?: string;
  textModelOptions?: string[];
  defaultVisionModel?: string;
};

export type ProviderRequestParams = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type OpenAiCompatibleProviderProfile = {
  id: string;
  displayName: string;
  presetId?: string;
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  textModel: string;
  visionModel?: string;
  requestParams?: ProviderRequestParams;
};

export type ChromeBuiltInAiProviderProfile = {
  id: "chrome-built-in-ai";
  displayName: string;
  type: "chrome-built-in-ai";
};

export type ProviderProfile =
  | OpenAiCompatibleProviderProfile
  | ChromeBuiltInAiProviderProfile;

export function isOpenAiCompatibleProviderProfile(
  profile: ProviderProfile,
): profile is OpenAiCompatibleProviderProfile {
  return profile.type === "openai-compatible";
}

export type GenerateTextRequest = {
  profile: OpenAiCompatibleProviderProfile;
  prompt: string;
  traceContext?: ProviderTraceContext;
  abortSignal?: AbortSignal;
};

export type GenerateTextResponse = {
  text: string;
  model: string;
};

export type StreamTextRequest = GenerateTextRequest;

export type StreamTextChunk = {
  text: string;
  model?: string;
};
