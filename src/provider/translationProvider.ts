import type { ProviderProfile, ProviderTraceContext } from "@/provider/types";
import type { PageSegment, TranslationResultItem } from "@/translation/types";

export type TranslateTextRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  traceContext?: ProviderTraceContext;
  abortSignal?: AbortSignal;
};

export type TranslateTextResponse = {
  translatedText: string;
};

export type TranslateBatchRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  segments: PageSegment[];
  traceContext?: ProviderTraceContext;
  abortSignal?: AbortSignal;
};

export type TranslateBatchResponse = {
  items: TranslationResultItem[];
};

export type TranslationProvider = {
  translateText(request: TranslateTextRequest): Promise<TranslateTextResponse>;
  translateBatch(request: TranslateBatchRequest): Promise<TranslateBatchResponse>;
  streamBatch?(request: TranslateBatchRequest): AsyncGenerator<TranslateBatchResponse>;
};
