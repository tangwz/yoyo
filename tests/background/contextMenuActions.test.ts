import { describe, expect, it, vi } from "vitest";
import {
  handleSummarizePageMenuClick,
  handleTranslatePageMenuClick,
  handleTranslateSelectionMenuClick,
} from "@/background/contextMenuActions";
import type { TranslationProgress } from "@/translation/types";

const completedProgress = {
  taskId: "task-1",
  state: "completed",
  total: 1,
  translated: 1,
  failed: 0,
} satisfies TranslationProgress;

describe("context menu background actions", () => {
  it("uses the stored target language for page translation", async () => {
    const translatePage = vi.fn(async () => completedProgress);

    await handleTranslatePageMenuClick(42, {
      getActiveProfile: async () => ({
        id: "provider-1",
        displayName: "Provider",
        type: "openai-compatible",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        textModel: "gpt-5-mini",
      }),
      getStoredTargetLanguage: async () => "ja",
      getStoredTranslationMode: async () => "fullPage",
      notifyPageCannotTranslate: vi.fn(),
      notifyProviderMissing: vi.fn(),
      translatePage,
    });

    expect(translatePage).toHaveBeenCalledWith({
      tabId: 42,
      sourceLanguage: "auto",
      targetLanguage: "ja",
      translationMode: "fullPage",
    });
  });

  it("uses the stored target language for selection translation", async () => {
    const translateSelection = vi.fn(async () => undefined);

    await handleTranslateSelectionMenuClick(
      { tabId: 42, text: "Hello" },
      {
        getActiveProfile: async () => ({
          id: "provider-1",
          displayName: "Provider",
          type: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          apiKey: "sk-test",
          textModel: "gpt-5-mini",
        }),
        getStoredTargetLanguage: async () => "ko",
        translateSelection,
      },
    );

    expect(translateSelection).toHaveBeenCalledWith(
      {
        tabId: 42,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "ko",
      },
      expect.objectContaining({ id: "provider-1" }),
    );
  });

  it("uses the stored target language for page summary", async () => {
    const summarizePage = vi.fn(async () => undefined);

    await handleSummarizePageMenuClick(42, {
      getStoredTargetLanguage: async () => "en",
      summarizePage,
    });

    expect(summarizePage).toHaveBeenCalledWith({
      tabId: 42,
      targetLanguage: "en",
    });
  });
});
