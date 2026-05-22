import { describe, expect, it } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import { TranslationProviderResolver } from "@/provider/resolver";

describe("TranslationProviderResolver", () => {
  it("returns OpenAI adapter for OpenAI-compatible profiles", () => {
    const resolver = new TranslationProviderResolver({
      openAiProvider: { generateText: async () => ({ text: "{}", model: "test" }) },
      chromeBuiltInTranslatorProvider: new ChromeBuiltInTranslatorProvider(),
    });

    expect(
      resolver.getTranslationProvider({
        id: "openai",
        displayName: "OpenAI",
        type: "openai-compatible",
        baseURL: "https://api.example.test",
        apiKey: "secret",
        textModel: "gpt-5-mini",
      }),
    ).toBeInstanceOf(OpenAiTranslationAdapter);
  });

  it("returns Chrome Built-in translator for Chrome Built-in AI profiles", () => {
    const chromeProvider = new ChromeBuiltInTranslatorProvider();
    const resolver = new TranslationProviderResolver({
      openAiProvider: { generateText: async () => ({ text: "{}", model: "test" }) },
      chromeBuiltInTranslatorProvider: chromeProvider,
    });

    expect(
      resolver.getTranslationProvider({
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      }),
    ).toBe(chromeProvider);
  });

  it("preserves OpenAI streaming support on resolved OpenAI adapters", async () => {
    const resolver = new TranslationProviderResolver({
      openAiProvider: {
        generateText: async () => ({ text: "{}", model: "test" }),
        async *streamText() {
          yield {
            text: '{"segmentId":"segment-1","translatedText":"Bonjour"}\n',
            model: "test",
          };
        },
      },
      chromeBuiltInTranslatorProvider: new ChromeBuiltInTranslatorProvider(),
    });
    const provider = resolver.getTranslationProvider({
      id: "openai",
      displayName: "OpenAI",
      type: "openai-compatible",
      baseURL: "https://api.example.test",
      apiKey: "secret",
      textModel: "gpt-5-mini",
    });

    expect(provider.streamBatch).toBeDefined();
    if (!provider.streamBatch) {
      throw new Error("Expected resolved OpenAI provider to support streaming.");
    }

    const chunks = [];
    for await (const chunk of provider.streamBatch({
      profile: {
        id: "openai",
        displayName: "OpenAI",
        type: "openai-compatible",
        baseURL: "https://api.example.test",
        apiKey: "secret",
        textModel: "gpt-5-mini",
      },
      sourceLanguage: "fr",
      targetLanguage: "en",
      segments: [
        {
          id: "segment-1",
          order: 1,
          sourceText: "Bonjour",
          kind: "paragraph",
          pathHint: "body.p1",
          textHash: "hash-1",
          priority: "viewport",
        },
      ],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        items: [{ segmentId: "segment-1", translatedText: "Bonjour" }],
      },
    ]);
  });
});
