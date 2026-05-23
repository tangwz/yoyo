import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  summarizePage,
  type SummarizePageDependencies,
} from "@/background/pageSummary";
import type { SummaryProvider } from "@/summary/types";
import type { ProviderProfile } from "@/provider/types";

const openAiProfile = {
  id: "provider-1",
  displayName: "Work Provider",
  type: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  textModel: "gpt-5-mini",
} satisfies ProviderProfile;

const chromeBuiltInProfile = {
  id: "chrome-built-in-ai",
  displayName: "Chrome Built-in AI",
  type: "chrome-built-in-ai",
} satisfies ProviderProfile;

describe("summarizePage", () => {
  const summarizeArticle = vi.fn<SummaryProvider["summarizeArticle"]>();
  const sendToContent = vi.fn<SummarizePageDependencies["sendToContent"]>();
  const getActiveProfile = vi.fn<SummarizePageDependencies["getActiveProfile"]>();
  const getSummaryProvider = vi.fn<
    SummarizePageDependencies["getSummaryProvider"]
  >();

  beforeEach(() => {
    summarizeArticle.mockReset();
    sendToContent.mockReset();
    getActiveProfile.mockReset();
    getSummaryProvider.mockReset();

    summarizeArticle.mockResolvedValue({
      summaryText: "This page explains the product architecture.",
    });
    sendToContent.mockResolvedValue({
      type: "summarySourceResult",
      title: "Architecture notes",
      sourceText: "This is a long source article.",
      sourceCharCount: 30,
      segmentCount: 3,
    });
    getActiveProfile.mockResolvedValue(openAiProfile);
    getSummaryProvider.mockReturnValue({ summarizeArticle });
  });

  function dependencies(): SummarizePageDependencies {
    return {
      getActiveProfile,
      getSummaryProvider,
      sendToContent,
    };
  }

  it("summarizes the current page with an active OpenAI-compatible profile", async () => {
    await summarizePage(
      {
        tabId: 42,
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getActiveProfile).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenNthCalledWith(1, 42, {
      type: "collectSummarySource",
    });
    expect(getSummaryProvider).toHaveBeenCalledWith(openAiProfile);
    expect(summarizeArticle).toHaveBeenCalledWith({
      profile: openAiProfile,
      targetLanguage: "zh-CN",
      title: "Architecture notes",
      sourceText: "This is a long source article.",
      traceContext: {
        stage: "summary",
        providerType: "openai-compatible",
        segmentCount: 3,
        sourceCharCount: 30,
      },
    });
    expect(sendToContent).toHaveBeenNthCalledWith(2, 42, {
      type: "showPageSummary",
      targetLanguage: "zh-CN",
      summaryText: "This page explains the product architecture.",
    });
  });

  it("rejects Chrome Built-in AI without falling back to a remote provider", async () => {
    getActiveProfile.mockResolvedValue(chromeBuiltInProfile);

    await expect(
      summarizePage(
        {
          tabId: 42,
          targetLanguage: "zh-CN",
        },
        dependencies(),
      ),
    ).rejects.toThrow("Article summary is not supported by Chrome Built-in AI yet.");

    expect(getSummaryProvider).not.toHaveBeenCalled();
    expect(summarizeArticle).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showPageSummary",
      targetLanguage: "zh-CN",
      errorMessage: "Article summary is not supported by Chrome Built-in AI yet.",
    });
  });

  it("rejects when no active provider profile exists", async () => {
    getActiveProfile.mockResolvedValue(undefined);

    await expect(
      summarizePage(
        {
          tabId: 42,
          targetLanguage: "zh-CN",
        },
        dependencies(),
      ),
    ).rejects.toThrow("No active provider profile.");

    expect(getSummaryProvider).not.toHaveBeenCalled();
    expect(summarizeArticle).not.toHaveBeenCalled();
  });

  it("rejects content extraction errors and sends the error to content", async () => {
    sendToContent.mockResolvedValue({
      type: "contentError",
      message: "Cannot extract article content.",
    });

    await expect(
      summarizePage(
        {
          tabId: 42,
          targetLanguage: "zh-CN",
        },
        dependencies(),
      ),
    ).rejects.toThrow("Cannot extract article content.");

    expect(summarizeArticle).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenNthCalledWith(2, 42, {
      type: "showPageSummary",
      targetLanguage: "zh-CN",
      errorMessage: "Cannot extract article content.",
    });
  });
});
