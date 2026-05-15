import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { formatLocalAiErrorMessage, LocalAiError } from "@/provider/localAiErrors";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";

export type TranslateSelectionInput = {
  tabId: number;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslateSelectionDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  sendToContent: (
    tabId: number,
    message: ContentRequest,
  ) => Promise<ContentResponse | undefined>;
};

export async function translateSelection(
  input: TranslateSelectionInput,
  dependencies: TranslateSelectionDependencies,
): Promise<void> {
  const sourceText = input.text.trim();
  if (!sourceText) {
    return;
  }

  try {
    const profile = await dependencies.getActiveProfile();
    if (!profile) {
      await sendSelectionTranslationError(
        input.tabId,
        sourceText,
        "No active provider profile.",
        dependencies,
      );
      return;
    }
    if (profile.type === "chrome-built-in-ai" && input.sourceLanguage === "auto") {
      await sendSelectionTranslationError(
        input.tabId,
        sourceText,
        "Chrome Built-in AI requires an explicit source language for selection translation. No remote provider was used.",
        dependencies,
      );
      return;
    }

    const response = await dependencies.getTranslationProvider(profile).translateText({
      profile,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      text: sourceText,
    });

    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      sourceText,
      translatedText: response.translatedText,
    });
  } catch (error: unknown) {
    await sendSelectionTranslationError(
      input.tabId,
      sourceText,
      getSelectionTranslationErrorMessage(error),
      dependencies,
    );
  }
}

function getSelectionTranslationErrorMessage(error: unknown): string {
  if (error instanceof LocalAiError) {
    return formatLocalAiErrorMessage(error.code);
  }

  return error instanceof Error ? error.message : "Selection translation failed.";
}

async function sendSelectionTranslationError(
  tabId: number,
  sourceText: string,
  errorMessage: string,
  dependencies: Pick<TranslateSelectionDependencies, "sendToContent">,
): Promise<void> {
  await dependencies.sendToContent(tabId, {
    type: "showSelectionTranslation",
    sourceText,
    errorMessage,
  });
}
