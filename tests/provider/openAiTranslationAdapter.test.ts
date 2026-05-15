import { describe, expect, it, vi } from "vitest";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import type { OpenAiCompatibleProviderProfile, ProviderProfile } from "@/provider/types";
import type { PageSegment } from "@/translation/types";

function profile(): OpenAiCompatibleProviderProfile {
  return {
    id: "openai",
    displayName: "OpenAI Compatible",
    type: "openai-compatible",
    baseURL: "https://api.example.test/v1",
    apiKey: "secret",
    textModel: "gpt-4.1-mini",
  };
}

function nonOpenAiProfile(): ProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

function segment(id: string, sourceText: string): PageSegment {
  return {
    id,
    order: 1,
    sourceText,
    kind: "paragraph",
    pathHint: `body.${id}`,
    textHash: `hash-${id}`,
    priority: "viewport",
  };
}

describe("OpenAiTranslationAdapter", () => {
  it("translates page segments through the OpenAI-compatible provider", async () => {
    const generateText = vi.fn().mockResolvedValue({
      model: "gpt-4.1-mini",
      text: JSON.stringify({
        items: [
          { segmentId: "segment-1", translatedText: "你好。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
      }),
    });
    const adapter = new OpenAiTranslationAdapter({ generateText });

    await expect(
      adapter.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          segment("segment-1", "Hello."),
          segment("segment-2", "Good morning."),
        ],
      }),
    ).resolves.toEqual({
      items: [
        { segmentId: "segment-1", translatedText: "你好。" },
        { segmentId: "segment-2", translatedText: "早上好。" },
      ],
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
  });

  it("rejects non-OpenAI-compatible profiles for batch translation", async () => {
    const generateText = vi.fn();
    const adapter = new OpenAiTranslationAdapter({ generateText });

    await expect(
      adapter.translateBatch({
        profile: nonOpenAiProfile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [segment("segment-1", "Hello.")],
      }),
    ).rejects.toThrow("OpenAI translation adapter requires an OpenAI-compatible profile.");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rejects non-OpenAI-compatible profiles for text translation", async () => {
    const generateText = vi.fn();
    const adapter = new OpenAiTranslationAdapter({ generateText });

    await expect(
      adapter.translateText({
        profile: nonOpenAiProfile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello.",
      }),
    ).rejects.toThrow("OpenAI translation adapter requires an OpenAI-compatible profile.");
    expect(generateText).not.toHaveBeenCalled();
  });
});
