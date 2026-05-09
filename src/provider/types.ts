export type ProviderType = "openai-compatible";

export type ProviderPreset = {
  id: string;
  name: string;
  type: ProviderType;
  defaultBaseUrl: string;
  defaultTextModel?: string;
  defaultVisionModel?: string;
};

export type ProviderRequestParams = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type ProviderProfile = {
  id: string;
  displayName: string;
  presetId?: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string;
  textModel: string;
  visionModel?: string;
  requestParams?: ProviderRequestParams;
};

export type GenerateTextRequest = {
  profile: ProviderProfile;
  prompt: string;
  abortSignal?: AbortSignal;
};

export type GenerateTextResponse = {
  text: string;
  model: string;
};
