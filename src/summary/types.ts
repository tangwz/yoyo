import type { ProviderProfile, ProviderTraceContext } from "@/provider/types";

export type SummarySourceResult = {
  title?: string;
  sourceText: string;
  sourceCharCount: number;
  segmentCount: number;
};

export type SummarizeArticleRequest = {
  profile: ProviderProfile;
  targetLanguage: string;
  title?: string;
  sourceText: string;
  traceContext?: ProviderTraceContext;
  abortSignal?: AbortSignal;
};

export type SummarizeArticleResponse = {
  summaryText: string;
};

export type SummaryProvider = {
  summarizeArticle(
    request: SummarizeArticleRequest,
  ): Promise<SummarizeArticleResponse>;
};
