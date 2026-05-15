import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  translateSelection,
  type TranslateSelectionDependencies,
} from "@/background/selectionTranslation";
import { LocalAiError } from "@/provider/localAiErrors";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";

const openAiProfile = {
  id: "provider-1",
  displayName: "Work Provider",
  type: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test",
  textModel: "gpt-4.1-mini",
} satisfies ProviderProfile;

const chromeBuiltInProfile = {
  id: "chrome-built-in-ai",
  displayName: "Chrome Built-in AI",
  type: "chrome-built-in-ai",
} satisfies ProviderProfile;

describe("translateSelection", () => {
  const translateText = vi.fn<TranslationProvider["translateText"]>();
  const sendToContent = vi.fn<TranslateSelectionDependencies["sendToContent"]>();
  const getActiveProfile = vi.fn<TranslateSelectionDependencies["getActiveProfile"]>();
  const getTranslationProvider = vi.fn<
    TranslateSelectionDependencies["getTranslationProvider"]
  >();

  beforeEach(() => {
    translateText.mockReset();
    sendToContent.mockReset();
    getActiveProfile.mockReset();
    getTranslationProvider.mockReset();

    translateText.mockResolvedValue({ translatedText: "你好" });
    sendToContent.mockResolvedValue(undefined);
    getActiveProfile.mockResolvedValue(openAiProfile);
    getTranslationProvider.mockReturnValue({
      translateText,
      translateBatch: vi.fn(),
    });
  });

  function dependencies(): TranslateSelectionDependencies {
    return {
      getActiveProfile,
      getTranslationProvider,
      sendToContent,
    };
  }

  it("calls the active provider and sends the translated selection to content", async () => {
    await translateSelection(
      {
        tabId: 42,
        text: "  Hello  ",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).toHaveBeenCalledWith({
      profile: openAiProfile,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      text: "Hello",
    });
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      translatedText: "你好",
    });
  });

  it("returns without provider calls for empty text", async () => {
    await translateSelection(
      {
        tabId: 42,
        text: "   ",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getActiveProfile).not.toHaveBeenCalled();
    expect(translateText).not.toHaveBeenCalled();
    expect(sendToContent).not.toHaveBeenCalled();
  });

  it("sends an error message when no active provider is available", async () => {
    getActiveProfile.mockResolvedValue(undefined);

    await translateSelection(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getTranslationProvider).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage: "No active provider profile.",
    });
  });

  it("sends provider error messages to content", async () => {
    translateText.mockRejectedValue(new Error("Provider failed"));

    await translateSelection(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage: "Provider failed",
    });
  });

  it("maps LocalAiError to the formatted local-only message", async () => {
    translateText.mockRejectedValue(
      new LocalAiError(
        "languagePairUnavailable",
        "The requested language pair is unavailable.",
      ),
    );

    await translateSelection(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage:
        "Chrome Built-in AI is not available for this language pair. No remote provider was used.",
    });
  });

  it("sends an explicit-language error instead of passing raw auto to Chrome Built-in AI", async () => {
    getActiveProfile.mockResolvedValue(chromeBuiltInProfile);

    await translateSelection(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getTranslationProvider).not.toHaveBeenCalled();
    expect(translateText).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage:
        "Chrome Built-in AI requires an explicit source language for selection translation. No remote provider was used.",
    });
  });
});
