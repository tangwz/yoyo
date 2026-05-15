import { describe, expect, it, vi } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { LocalAiError } from "@/provider/localAiErrors";
import type { ChromeBuiltInAiProviderProfile } from "@/provider/types";

function profile(): ChromeBuiltInAiProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

describe("ChromeBuiltInTranslatorProvider", () => {
  it("translates text with the browser Translator API", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available" as const);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).resolves.toEqual({ translatedText: "translated:Hello" });
    expect(availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
  });

  it("fails locally when the API is unavailable", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => undefined,
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it("translates batches one item at a time", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({ translate })),
      }),
    });

    await expect(
      provider.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          {
            id: "segment-1",
            order: 1,
            sourceText: "Hello",
            kind: "paragraph",
            pathHint: "body.p1",
            textHash: "hash-1",
            priority: "viewport",
          },
        ],
      }),
    ).resolves.toEqual({
      items: [{ segmentId: "segment-1", translatedText: "translated:Hello" }],
    });
  });
});
