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
  detectSourceLanguage?: (text: string) => Promise<string | undefined>;
  prepareChromeBuiltInAi?: (
    sourceLanguage: string,
    targetLanguage: string,
  ) => Promise<void>;
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
    const sourceLanguage = await resolveSelectionSourceLanguage(
      sourceText,
      input.sourceLanguage,
      profile,
      dependencies,
    );
    if (profile.type === "chrome-built-in-ai") {
      await dependencies.prepareChromeBuiltInAi?.(
        sourceLanguage,
        input.targetLanguage,
      );
    }

    const response = await dependencies.getTranslationProvider(profile).translateText({
      profile,
      sourceLanguage,
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

async function resolveSelectionSourceLanguage(
  sourceText: string,
  sourceLanguage: string,
  profile: ProviderProfile,
  dependencies: Pick<TranslateSelectionDependencies, "detectSourceLanguage">,
): Promise<string> {
  if (profile.type !== "chrome-built-in-ai" || sourceLanguage !== "auto") {
    return sourceLanguage;
  }

  const detectedLanguage = await dependencies.detectSourceLanguage?.(sourceText);
  if (!detectedLanguage) {
    throw new Error(
      "Chrome Built-in AI could not detect the selected text language. No remote provider was used.",
    );
  }

  return detectedLanguage;
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
