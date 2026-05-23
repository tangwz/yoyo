import type { ProviderProfile } from "@/provider/types";
import { defaultTranslationPreferences } from "@/storage/defaults";
import type { TranslationMode, TranslationProgress } from "@/translation/types";

export type TranslatePageMenuInput = {
  tabId: number;
  sourceLanguage: "auto";
  targetLanguage: string;
  translationMode: TranslationMode;
};

export type TranslateSelectionMenuClickInput = {
  tabId: number;
  text: string;
};

export type TranslateSelectionMenuInput = TranslateSelectionMenuClickInput & {
  sourceLanguage: "auto";
  targetLanguage: string;
};

export type SummarizePageMenuInput = {
  tabId: number;
  targetLanguage: string;
};

export type TranslatePageMenuClickDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getStoredTargetLanguage: () => Promise<string>;
  getStoredTranslationMode: () => Promise<TranslationMode>;
  notifyPageCannotTranslate: (message: string) => Promise<void>;
  notifyProviderMissing: () => Promise<void>;
  translatePage: (input: TranslatePageMenuInput) => Promise<TranslationProgress>;
};

export type TranslateSelectionMenuClickDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getStoredTargetLanguage: () => Promise<string>;
  translateSelection: (
    input: TranslateSelectionMenuInput,
    activeProfile: ProviderProfile | undefined,
  ) => Promise<void>;
};

export type SummarizePageMenuClickDependencies = {
  getStoredTargetLanguage: () => Promise<string>;
  notifyPageCannotSummarize: (message: string) => Promise<void>;
  summarizePage: (input: SummarizePageMenuInput) => Promise<void>;
};

async function getStoredTargetLanguageOrDefault(
  getStoredTargetLanguage: () => Promise<string>,
): Promise<string> {
  return getStoredTargetLanguage().catch(
    () => defaultTranslationPreferences.targetLanguage,
  );
}

export async function handleTranslatePageMenuClick(
  tabId: number,
  dependencies: TranslatePageMenuClickDependencies,
): Promise<void> {
  const activeProfile = await dependencies.getActiveProfile();
  if (!activeProfile) {
    await dependencies.notifyProviderMissing();
    return;
  }

  const progress = await dependencies.translatePage({
    tabId,
    sourceLanguage: "auto",
    targetLanguage: await getStoredTargetLanguageOrDefault(
      dependencies.getStoredTargetLanguage,
    ),
    translationMode: await dependencies.getStoredTranslationMode(),
  });

  if (progress.state === "failed") {
    await dependencies.notifyPageCannotTranslate(
      progress.errorMessage ?? "The page could not be translated.",
    );
  }
}

export async function handleTranslateSelectionMenuClick(
  input: TranslateSelectionMenuClickInput,
  dependencies: TranslateSelectionMenuClickDependencies,
): Promise<void> {
  const activeProfile = await dependencies.getActiveProfile();

  await dependencies.translateSelection(
    {
      tabId: input.tabId,
      text: input.text,
      sourceLanguage: "auto",
      targetLanguage: await getStoredTargetLanguageOrDefault(
        dependencies.getStoredTargetLanguage,
      ),
    },
    activeProfile,
  );
}

export async function handleSummarizePageMenuClick(
  tabId: number,
  dependencies: SummarizePageMenuClickDependencies,
): Promise<void> {
  try {
    await dependencies.summarizePage({
      tabId,
      targetLanguage: await getStoredTargetLanguageOrDefault(
        dependencies.getStoredTargetLanguage,
      ),
    });
  } catch (error: unknown) {
    await dependencies.notifyPageCannotSummarize(
      error instanceof Error ? error.message : "The page could not be summarized.",
    );
    throw error;
  }
}
