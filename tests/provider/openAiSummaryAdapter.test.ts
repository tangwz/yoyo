import { describe, expect, it, vi } from "vitest";
import { OpenAiSummaryAdapter } from "@/provider/openAiSummaryAdapter";
import type {
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";

function profile(): OpenAiCompatibleProviderProfile {
  return {
    id: "openai",
    displayName: "OpenAI Compatible",
    type: "openai-compatible",
    baseURL: "https://api.example.test/v1",
    apiKey: "secret",
    textModel: "gpt-5-mini",
  };
}

function nonOpenAiProfile(): ProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

describe("OpenAiSummaryAdapter", () => {
  it("summarizes an article with an OpenAI-compatible profile", async () => {
    const sourceText = "This is a source article.";
    const openAiProfile = profile();
    const generateText = vi.fn().mockResolvedValue({
      text: "This is the summary.",
      model: "gpt-5-mini",
    });
    const adapter = new OpenAiSummaryAdapter({ generateText });

    await expect(
      adapter.summarizeArticle({
        profile: openAiProfile,
        targetLanguage: "en",
        title: "Source title",
        sourceText,
        traceContext: {
          taskId: "task-1",
          batchId: "batch-1",
          stage: "page",
          providerType: "openai-compatible",
        },
      }),
    ).resolves.toEqual({
      summaryText: "This is the summary.",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: openAiProfile,
        prompt: expect.stringContaining("Target language: en"),
        traceContext: expect.objectContaining({
          taskId: "task-1",
          batchId: "batch-1",
          stage: "summary",
          providerType: "openai-compatible",
          segmentCount: 1,
          sourceCharCount: sourceText.length,
        }),
      }),
    );
  });

  it("rejects empty summary output", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "   ",
      model: "gpt-5-mini",
    });
    const adapter = new OpenAiSummaryAdapter({ generateText });

    await expect(
      adapter.summarizeArticle({
        profile: profile(),
        targetLanguage: "en",
        sourceText: "This is a source article.",
      }),
    ).rejects.toThrow(
      "OpenAI-compatible provider returned an empty article summary.",
    );
  });

  it("rejects non OpenAI-compatible profile", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "This is the summary.",
      model: "gpt-5-mini",
    });
    const adapter = new OpenAiSummaryAdapter({ generateText });

    await expect(
      adapter.summarizeArticle({
        profile: nonOpenAiProfile(),
        targetLanguage: "en",
        sourceText: "This is a source article.",
      }),
    ).rejects.toThrow(
      "OpenAI summary adapter requires an OpenAI-compatible profile.",
    );
  });
});
