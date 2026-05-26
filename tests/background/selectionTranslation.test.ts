import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSelectionTranslationConfig,
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
  textModel: "gpt-5-mini",
} satisfies ProviderProfile;

const chromeBuiltInProfile = {
  id: "chrome-built-in-ai",
  displayName: "Chrome Built-in AI",
  type: "chrome-built-in-ai",
} satisfies ProviderProfile;

function selectionRequestIdMatcher(): RegExp {
  return /^selection-\d+-[0-9a-f-]+$/;
}

describe("translateSelection", () => {
  const translateText = vi.fn<TranslationProvider["translateText"]>();
  const sendToContent = vi.fn<TranslateSelectionDependencies["sendToContent"]>();
  const getProviderState = vi.fn<
    TranslateSelectionDependencies["getProviderState"]
  >();
  const getSelectionProviderId = vi.fn<
    TranslateSelectionDependencies["getSelectionProviderId"]
  >();
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
    getProviderState.mockReset();
    getSelectionProviderId.mockReset();
    detectSourceLanguage.mockReset();
    prepareChromeBuiltInAi.mockReset();
    getTranslationProvider.mockReset();

    translateText.mockResolvedValue({ translatedText: "你好" });
    detectSourceLanguage.mockResolvedValue("en");
    prepareChromeBuiltInAi.mockResolvedValue(undefined);
    sendToContent.mockResolvedValue(undefined);
    getProviderState.mockResolvedValue({
      profiles: [openAiProfile, chromeBuiltInProfile],
      activeProviderId: "provider-1",
    });
    getSelectionProviderId.mockResolvedValue("provider-1");
    getTranslationProvider.mockReturnValue({
      translateText,
      translateBatch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function dependencies(): TranslateSelectionDependencies {
    return {
      getProviderState,
      getSelectionProviderId,
      getTranslationProvider,
      detectSourceLanguage,
      prepareChromeBuiltInAi,
      sendToContent,
    };
  }

  it("builds configured selection popup config from ready providers", async () => {
    vi.stubGlobal("Translator", {});
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("navigator", { userAgent: "Chrome/138.0.0.0" });

    const config = buildSelectionTranslationConfig({
      providerState: {
        profiles: [openAiProfile, chromeBuiltInProfile],
        activeProviderId: "chrome-built-in-ai",
      },
      savedProviderId: "provider-1",
      targetLanguage: "zh-CN",
    });

    expect(config).toEqual({
      type: "selectionTranslationConfig",
      configured: true,
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: [
        {
          id: "provider-1",
          label: "Work Provider / gpt-5-mini",
          providerMode: "remote",
        },
        {
          id: "chrome-built-in-ai",
          label: "Chrome Built-in AI",
          providerMode: "local-only",
        },
      ],
    });
  });

  it("builds missing provider config when no ready providers exist", async () => {
    const config = buildSelectionTranslationConfig({
      providerState: { profiles: [], activeProviderId: undefined },
      savedProviderId: undefined,
      targetLanguage: "zh-CN",
    });

    expect(config).toEqual({
      type: "selectionTranslationConfig",
      configured: false,
      targetLanguage: "zh-CN",
      providerOptions: [],
      message: "No translation provider is configured.",
    });
  });

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
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "translated",
        sourceText: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        selectedProviderId: "provider-1",
        providerOptions: expect.arrayContaining([
          {
            id: "provider-1",
            label: "Work Provider / gpt-5-mini",
            providerMode: "remote",
          },
        ]),
        translatedText: "你好",
      }),
    );
  });

  it("uses the saved selection provider by default", async () => {
    const secondProfile = {
      id: "provider-2",
      displayName: "Second Provider",
      type: "openai-compatible",
      baseURL: "https://api.second.example.com/v1",
      apiKey: "sk-second",
      textModel: "gpt-5",
    } satisfies ProviderProfile;
    getProviderState.mockResolvedValue({
      profiles: [openAiProfile, secondProfile],
      activeProviderId: "provider-1",
    });
    getSelectionProviderId.mockResolvedValue("provider-2");

    await translateSelection(
      {
        tabId: 42,
        requestId: "selection-request-1",
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).toHaveBeenCalledWith(
      expect.objectContaining({ profile: secondProfile }),
    );
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: "selection-request-1",
        state: "translated",
        selectedProviderId: "provider-2",
        translatedText: "你好",
      }),
    );
  });

  it("uses an explicit provider id over the saved selection provider", async () => {
    const secondProfile = {
      id: "provider-2",
      displayName: "Second Provider",
      type: "openai-compatible",
      baseURL: "https://api.second.example.com/v1",
      apiKey: "sk-second",
      textModel: "gpt-5",
    } satisfies ProviderProfile;
    getProviderState.mockResolvedValue({
      profiles: [openAiProfile, secondProfile],
      activeProviderId: "provider-1",
    });
    getSelectionProviderId.mockResolvedValue("provider-1");

    await translateSelection(
      {
        tabId: 42,
        requestId: "selection-request-2",
        providerId: "provider-2",
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).toHaveBeenCalledWith(
      expect.objectContaining({ profile: secondProfile }),
    );
  });

  it("falls back when the saved selection provider is unavailable", async () => {
    getProviderState.mockResolvedValue({
      profiles: [openAiProfile],
      activeProviderId: "provider-1",
    });
    getSelectionProviderId.mockResolvedValue("missing-provider");

    await translateSelection(
      {
        tabId: 42,
        requestId: "selection-request-3",
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(translateText).toHaveBeenCalledWith(
      expect.objectContaining({ profile: openAiProfile }),
    );
  });

  it("does not reintroduce a stale active profile missing from listed profiles", async () => {
    const incompleteProfile = {
      ...openAiProfile,
      id: "incomplete-provider",
      apiKey: "",
    } satisfies ProviderProfile;
    getProviderState.mockResolvedValue({
      profiles: [incompleteProfile],
      activeProviderId: "provider-1",
    });
    getSelectionProviderId.mockResolvedValue(undefined);

    await translateSelection(
      {
        tabId: 42,
        requestId: "selection-request-4",
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(getTranslationProvider).not.toHaveBeenCalled();
    expect(translateText).not.toHaveBeenCalled();
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: "selection-request-4",
        state: "failed",
        providerOptions: [],
        errorMessage: "No active provider profile.",
      }),
    );
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

    expect(getProviderState).not.toHaveBeenCalled();
    expect(translateText).not.toHaveBeenCalled();
    expect(sendToContent).not.toHaveBeenCalled();
  });

  it("sends an error message when no active provider is available", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    getProviderState.mockResolvedValue({
      profiles: [],
      activeProviderId: undefined,
    });
    getSelectionProviderId.mockResolvedValue(undefined);

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
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "failed",
        sourceText: "Private selected text",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        providerOptions: [],
        errorMessage: "No active provider profile.",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.translate.error",
      expect.objectContaining({
        stage: "profile",
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

    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "failed",
        sourceText: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        selectedProviderId: "provider-1",
        providerOptions: expect.arrayContaining([
          expect.objectContaining({ id: "provider-1" }),
        ]),
        errorMessage: "Provider failed",
      }),
    );
  });

  it("traces provider selection errors with the failing stage", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    translateText.mockRejectedValue(new Error("Provider failed with private details"));

    await translateSelection(
      {
        tabId: 42,
        text: "Private selected text",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      dependencies(),
    );

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] selection.translate.error",
      expect.objectContaining({
        stage: "provider",
        success: false,
        errorName: "Error",
      }),
    );
    expect(renderedConsoleOutput(infoSpy.mock.calls)).not.toContain(
      "Provider failed with private details",
    );

    infoSpy.mockRestore();
    vi.unstubAllEnvs();
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

    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "failed",
        sourceText: "Hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        selectedProviderId: "provider-1",
        providerOptions: expect.arrayContaining([
          expect.objectContaining({ id: "provider-1" }),
        ]),
        errorMessage:
          "Chrome Built-in AI is not available for this language pair. No remote provider was used.",
      }),
    );
  });

  it("detects source language before calling Chrome Built-in AI for auto selections", async () => {
    vi.stubGlobal("Translator", {});
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("navigator", { userAgent: "Chrome/138.0.0.0" });
    getProviderState.mockResolvedValue({
      profiles: [chromeBuiltInProfile],
      activeProviderId: "chrome-built-in-ai",
    });
    getSelectionProviderId.mockResolvedValue("chrome-built-in-ai");

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
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "translated",
        sourceText: "Hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        selectedProviderId: "chrome-built-in-ai",
        providerOptions: [
          {
            id: "chrome-built-in-ai",
            label: "Chrome Built-in AI",
            providerMode: "local-only",
          },
        ],
        translatedText: "你好",
      }),
    );
  });

  it("sends a local-only error when Chrome Built-in AI cannot detect selection language", async () => {
    vi.stubGlobal("Translator", {});
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("navigator", { userAgent: "Chrome/138.0.0.0" });
    getProviderState.mockResolvedValue({
      profiles: [chromeBuiltInProfile],
      activeProviderId: "chrome-built-in-ai",
    });
    getSelectionProviderId.mockResolvedValue("chrome-built-in-ai");
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
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "failed",
        sourceText: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        selectedProviderId: "chrome-built-in-ai",
        providerOptions: [
          {
            id: "chrome-built-in-ai",
            label: "Chrome Built-in AI",
            providerMode: "local-only",
          },
        ],
        errorMessage:
          "Chrome Built-in AI could not detect the selected text language. No remote provider was used.",
      }),
    );
  });

  it("sends a local-only error when Chrome Built-in AI warm-up fails", async () => {
    vi.stubGlobal("Translator", {});
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("navigator", { userAgent: "Chrome/138.0.0.0" });
    getProviderState.mockResolvedValue({
      profiles: [chromeBuiltInProfile],
      activeProviderId: "chrome-built-in-ai",
    });
    getSelectionProviderId.mockResolvedValue("chrome-built-in-ai");
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
    expect(sendToContent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "showSelectionTranslation",
        requestId: expect.stringMatching(selectionRequestIdMatcher()),
        state: "failed",
        sourceText: "Hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        selectedProviderId: "chrome-built-in-ai",
        providerOptions: [
          {
            id: "chrome-built-in-ai",
            label: "Chrome Built-in AI",
            providerMode: "local-only",
          },
        ],
        errorMessage:
          "Chrome Built-in AI is not available in this browser. No remote provider was used.",
      }),
    );
  });
});
