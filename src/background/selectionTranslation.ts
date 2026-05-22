import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { formatLocalAiErrorMessage, LocalAiError } from "@/provider/localAiErrors";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";
import { elapsedMs, metadataForError, nowMs, tracePerf } from "@/utils/perfTrace";

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

  const translationStartedAt = nowMs();
  tracePerf("selection.translate.start", {
    stage: "selection",
    sourceCharCount: sourceText.length,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  });

  try {
    const profileStartedAt = nowMs();
    const profile = await dependencies.getActiveProfile();
    tracePerf("selection.profile.done", {
      providerType: profile?.type,
      durationMs: elapsedMs(profileStartedAt),
      success: profile !== undefined,
    });
    if (!profile) {
      await sendSelectionTranslationError(
        input.tabId,
        sourceText,
        "No active provider profile.",
        dependencies,
      );
      traceSelectionTranslationError(translationStartedAt, {
        errorCode: "providerUnavailable",
      });
      return;
    }
    const detectStartedAt = nowMs();
    const sourceLanguage = await resolveSelectionSourceLanguage(
      sourceText,
      input.sourceLanguage,
      profile,
      dependencies,
    );
    tracePerf("selection.detectLanguage.done", {
      providerType: profile.type,
      sourceLanguage,
      durationMs: elapsedMs(detectStartedAt),
      success: true,
    });
    if (profile.type === "chrome-built-in-ai") {
      const prepareStartedAt = nowMs();
      await dependencies.prepareChromeBuiltInAi?.(
        sourceLanguage,
        input.targetLanguage,
      );
      tracePerf("selection.prepareLocalAi.done", {
        providerType: "chrome-built-in-ai",
        sourceLanguage,
        targetLanguage: input.targetLanguage,
        durationMs: elapsedMs(prepareStartedAt),
        success: true,
      });
    }

    const providerStartedAt = nowMs();
    const response = await dependencies.getTranslationProvider(profile).translateText({
      profile,
      sourceLanguage,
      targetLanguage: input.targetLanguage,
      text: sourceText,
      traceContext: {
        stage: "selection",
        providerType: profile.type,
        segmentCount: 1,
        sourceCharCount: sourceText.length,
      },
    });
    tracePerf("selection.provider.done", {
      providerType: profile.type,
      sourceCharCount: sourceText.length,
      outputCharCount: response.translatedText.length,
      durationMs: elapsedMs(providerStartedAt),
      success: true,
    });

    const showResultStartedAt = nowMs();
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      sourceText,
      translatedText: response.translatedText,
    });
    tracePerf("selection.showResult.done", {
      providerType: profile.type,
      durationMs: elapsedMs(showResultStartedAt),
      success: true,
    });
  } catch (error: unknown) {
    await sendSelectionTranslationError(
      input.tabId,
      sourceText,
      getSelectionTranslationErrorMessage(error),
      dependencies,
    );
    traceSelectionTranslationError(translationStartedAt, metadataForError(error));
  }
}

function traceSelectionTranslationError(
  startedAt: number,
  metadata: { errorName?: string; errorCode?: string; status?: number },
): void {
  tracePerf("selection.translate.error", {
    stage: "selection",
    durationMs: elapsedMs(startedAt),
    success: false,
    ...metadata,
  });
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
