import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import type { ProviderProfile } from "@/provider/types";
import type { SummaryProvider, SummarySourceResult } from "@/summary/types";

const CHROME_BUILT_IN_AI_UNSUPPORTED_ERROR =
  "Article summary is not supported by Chrome Built-in AI yet.";
const NO_ACTIVE_PROVIDER_ERROR = "No active provider profile.";
const NO_SUMMARY_SOURCE_ERROR = "Page summary source was not available.";
const UNEXPECTED_SUMMARY_SOURCE_RESPONSE_ERROR =
  "Unexpected content response while collecting summary source.";

export type SummarizePageInput = {
  tabId: number;
  targetLanguage: string;
};

export type SummarizePageDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getSummaryProvider: (profile: ProviderProfile) => SummaryProvider;
  sendToContent: (
    tabId: number,
    message: ContentRequest,
  ) => Promise<ContentResponse | undefined>;
};

export async function summarizePage(
  input: SummarizePageInput,
  dependencies: SummarizePageDependencies,
): Promise<void> {
  try {
    const profile = await dependencies.getActiveProfile();
    if (!profile) {
      throw new Error(NO_ACTIVE_PROVIDER_ERROR);
    }

    if (profile.type === "chrome-built-in-ai") {
      throw new Error(CHROME_BUILT_IN_AI_UNSUPPORTED_ERROR);
    }

    const source = await collectSummarySource(input.tabId, dependencies);
    const response = await dependencies.getSummaryProvider(profile).summarizeArticle({
      profile,
      targetLanguage: input.targetLanguage,
      title: source.title,
      sourceText: source.sourceText,
      traceContext: {
        stage: "summary",
        providerType: profile.type,
        segmentCount: source.segmentCount,
        sourceCharCount: source.sourceCharCount,
      },
    });

    await dependencies.sendToContent(input.tabId, {
      type: "showPageSummary",
      targetLanguage: input.targetLanguage,
      summaryText: response.summaryText,
    });
  } catch (error: unknown) {
    await sendPageSummaryError(input, getPageSummaryErrorMessage(error), dependencies);
    throw error;
  }
}

async function collectSummarySource(
  tabId: number,
  dependencies: Pick<SummarizePageDependencies, "sendToContent">,
): Promise<SummarySourceResult> {
  const response = await dependencies.sendToContent(tabId, {
    type: "collectSummarySource",
  });

  if (!response) {
    throw new Error(NO_SUMMARY_SOURCE_ERROR);
  }

  if (response.type === "contentError") {
    throw new Error(response.message);
  }

  if (response.type !== "summarySourceResult") {
    throw new Error(UNEXPECTED_SUMMARY_SOURCE_RESPONSE_ERROR);
  }

  return {
    title: response.title,
    sourceText: response.sourceText,
    sourceCharCount: response.sourceCharCount,
    segmentCount: response.segmentCount,
  };
}

function getPageSummaryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Page summary failed.";
}

async function sendPageSummaryError(
  input: SummarizePageInput,
  errorMessage: string,
  dependencies: Pick<SummarizePageDependencies, "sendToContent">,
): Promise<void> {
  try {
    await dependencies.sendToContent(input.tabId, {
      type: "showPageSummary",
      targetLanguage: input.targetLanguage,
      errorMessage,
    });
  } catch {
    // The original error is more useful than a secondary UI delivery failure.
  }
}
