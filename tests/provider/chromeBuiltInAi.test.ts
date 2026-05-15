import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { LocalAiError } from "@/provider/localAiErrors";
import type {
  ChromeBuiltInAiProviderProfile,
  OpenAiCompatibleProviderProfile,
} from "@/provider/types";

function profile(): ChromeBuiltInAiProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

function openAiProfile(): OpenAiCompatibleProviderProfile {
  return {
    id: "openai",
    displayName: "OpenAI",
    type: "openai-compatible",
    baseURL: "https://api.example.test",
    apiKey: "secret",
    textModel: "gpt-4.1-mini",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("passes auto source language through to the browser Translator API", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available" as const);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await provider.translateText({
      profile: profile(),
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      text: "Hello",
    });

    expect(availability).toHaveBeenCalledWith({
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "auto",
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

  it("does not fall back to the global Translator when an injected API getter returns undefined", async () => {
    vi.stubGlobal("Translator", {
      availability: vi.fn(async () => "available" as const),
      create: vi.fn(async () => ({
        translate: vi.fn(async (text: string) => `translated:${text}`),
      })),
    });
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

  it("uses the global Translator API when no injection is provided", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available" as const);
    vi.stubGlobal("Translator", { availability, create });
    const provider = new ChromeBuiltInTranslatorProvider();

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

  it("fails locally when the language pair is unavailable", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "unavailable" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "languagePairUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it.each(["downloadable", "downloading"] as const)(
    "fails locally when the model is %s",
    async (availabilityResult) => {
      const provider = new ChromeBuiltInTranslatorProvider({
        getTranslatorApi: () => ({
          availability: vi.fn(async () => availabilityResult),
          create: vi.fn(async () => ({
            translate: vi.fn(async (text: string) => `translated:${text}`),
          })),
        }),
      });

      await expect(
        provider.translateText({
          profile: profile(),
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          text: "Hello",
        }),
      ).rejects.toMatchObject({
        code: "modelDownloadRequired",
      } satisfies Partial<LocalAiError>);
    },
  );

  it("rejects non Chrome Built-in AI profiles", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: openAiProfile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
    } satisfies Partial<LocalAiError>);
  });

  it("maps availability errors to local unknown errors", async () => {
    const cause = new Error("availability failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps availability errors to local aborted errors when aborted", async () => {
    const abortController = new AbortController();
    const cause = new Error("availability failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          abortController.abort();
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps create errors to local unknown errors", async () => {
    const cause = new Error("create failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => {
          throw cause;
        }),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps create errors to local aborted errors when aborted", async () => {
    const abortController = new AbortController();
    const cause = new Error("create failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => {
          abortController.abort();
          throw cause;
        }),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
      cause,
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
