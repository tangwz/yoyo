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
        textModel: "gpt-4.1-mini",
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
});
