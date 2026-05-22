import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  translateSelection,
  type TranslateSelectionDependencies,
} from "@/background/selectionTranslation";
import { LocalAiError } from "@/provider/localAiErrors";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";

function renderedConsoleOutput(calls: unknown[][]): string {
  return calls
    .map((call) =>
      call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    )
    .join("\n");
}

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
  const detectSourceLanguage = vi.fn<
    NonNullable<TranslateSelectionDependencies["detectSourceLanguage"]>
  >();
  const prepareChromeBuiltInAi = vi.fn<
    NonNullable<TranslateSelectionDependencies["prepareChromeBuiltInAi"]>
  >();
  const getTranslationProvider = vi.fn<
    TranslateSelectionDependencies["getTranslationProvider"]
  >();

  beforeEach(() => {
    translateText.mockReset();
    sendToContent.mockReset();
    getActiveProfile.mockReset();
    detectSourceLanguage.mockReset();
    prepareChromeBuiltInAi.mockReset();
    getTranslationProvider.mockReset();

    translateText.mockResolvedValue({ translatedText: "你好" });
    detectSourceLanguage.mockResolvedValue("en");
    prepareChromeBuiltInAi.mockResolvedValue(undefined);
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
      detectSourceLanguage,
      prepareChromeBuiltInAi,
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
      traceContext: {
        stage: "selection",
        providerType: "openai-compatible",
        segmentCount: 1,
        sourceCharCount: 5,
      },
    });
    expect(prepareChromeBuiltInAi).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      translatedText: "你好",
    });
  });

  it("traces normal openAI selection translation without raw text", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await translateSelection(
      {
        tabId: 42,
        text: "  Hello private text  ",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).toHaveBeenCalledWith(
      expect.objectContaining({
        traceContext: {
          stage: "selection",
          providerType: "openai-compatible",
          segmentCount: 1,
          sourceCharCount: 18,
        },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.translate.start",
      expect.objectContaining({
        stage: "selection",
        sourceCharCount: 18,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.profile.done",
      expect.objectContaining({
        providerType: "openai-compatible",
        success: true,
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.provider.done",
      expect.objectContaining({
        providerType: "openai-compatible",
        sourceCharCount: 18,
        outputCharCount: 2,
        success: true,
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.showResult.done",
      expect.objectContaining({
        providerType: "openai-compatible",
        success: true,
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Hello private text");
    expect(output).not.toContain("你好");

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
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
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    getActiveProfile.mockResolvedValue(undefined);

    await translateSelection(
      {
        tabId: 42,
        text: "Private selected text",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getTranslationProvider).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Private selected text",
      errorMessage: "No active provider profile.",
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.translate.error",
      expect.objectContaining({
        stage: "selection",
        success: false,
        errorCode: "providerUnavailable",
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Private selected text");

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
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

  it("detects source language before calling Chrome Built-in AI for auto selections", async () => {
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

    expect(detectSourceLanguage).toHaveBeenCalledWith("Hello");
    expect(prepareChromeBuiltInAi).toHaveBeenCalledWith("en", "zh-CN");
    expect(
      prepareChromeBuiltInAi.mock.invocationCallOrder[0],
    ).toBeLessThan(translateText.mock.invocationCallOrder[0]);
    expect(translateText).toHaveBeenCalledWith({
      profile: chromeBuiltInProfile,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      text: "Hello",
      traceContext: {
        stage: "selection",
        providerType: "chrome-built-in-ai",
        segmentCount: 1,
        sourceCharCount: 5,
      },
    });
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      translatedText: "你好",
    });
  });

  it("sends a local-only error when Chrome Built-in AI cannot detect selection language", async () => {
    getActiveProfile.mockResolvedValue(chromeBuiltInProfile);
    detectSourceLanguage.mockResolvedValue(undefined);

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
    expect(prepareChromeBuiltInAi).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage:
        "Chrome Built-in AI could not detect the selected text language. No remote provider was used.",
    });
  });

  it("sends a local-only error when Chrome Built-in AI warm-up fails", async () => {
    getActiveProfile.mockResolvedValue(chromeBuiltInProfile);
    prepareChromeBuiltInAi.mockRejectedValue(
      new LocalAiError("apiUnavailable", "Chrome Built-in AI is unavailable."),
    );

    await translateSelection(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(42, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      errorMessage:
        "Chrome Built-in AI is not available in this browser. No remote provider was used.",
    });
  });
});
