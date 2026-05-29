import type {
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
  SelectionTranslationProviderOption,
} from "@/messaging/contracts";
import { formatLocalAiErrorMessage, LocalAiError } from "@/provider/localAiErrors";
import { evaluateProviderReadiness } from "@/provider/readiness";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";
import { elapsedMs, metadataForError, nowMs, tracePerf } from "@/utils/perfTrace";

export type TranslateSelectionInput = {
  tabId: number;
  requestId?: string;
  providerId?: string;
  pageUrl?: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslateSelectionProviderState = {
  profiles: ProviderProfile[];
  activeProviderId: string | undefined;
};

export type TranslateSelectionDependencies = {
  getProviderState: () => Promise<TranslateSelectionProviderState>;
  getSelectionProviderId: () => Promise<string | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  detectSourceLanguage?: (text: string) => Promise<string | undefined>;
  prepareChromeBuiltInAi?: (
    sourceLanguage: string,
    targetLanguage: string,
  ) => Promise<void>;
  isPageBlocked?: (pageUrl: string) => Promise<boolean>;
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

  if (input.pageUrl && (await dependencies.isPageBlocked?.(input.pageUrl))) {
    return;
  }

  const translationStartedAt = nowMs();
  const requestId = input.requestId ?? createSelectionTranslationRequestId();
  let currentStage = "selection";
  let resolvedSourceLanguage = input.sourceLanguage;
  let selectedProviderId: string | undefined;
  let providerOptions: SelectionTranslationProviderOption[] = [];
  tracePerf("selection.translate.start", {
    stage: "selection",
    sourceCharCount: sourceText.length,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  });

  try {
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      requestId,
      state: "loading",
      sourceText,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      providerOptions,
    });

    currentStage = "profile";
    const profileStartedAt = nowMs();
    const providerSelection = await selectSelectionProvider(input, dependencies);
    providerOptions = providerSelection.providerOptions;
    const profile = providerSelection.profile;
    tracePerf("selection.profile.done", {
      providerType: profile?.type,
      durationMs: elapsedMs(profileStartedAt),
      success: profile !== undefined,
    });
    if (!profile) {
      await sendSelectionTranslationError(
        input,
        {
          requestId,
          sourceText,
          sourceLanguage: resolvedSourceLanguage,
          providerOptions,
          errorMessage: "No active provider profile.",
        },
        dependencies,
      );
      traceSelectionTranslationError(translationStartedAt, currentStage, {
        errorCode: "providerUnavailable",
      });
      return;
    }
    selectedProviderId = profile.id;
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      requestId,
      state: "loading",
      sourceText,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      selectedProviderId,
      providerOptions,
    });

    currentStage = "detectLanguage";
    const detectStartedAt = nowMs();
    const sourceLanguage = await resolveSelectionSourceLanguage(
      sourceText,
      input.sourceLanguage,
      profile,
      dependencies,
    );
    resolvedSourceLanguage = sourceLanguage;
    tracePerf("selection.detectLanguage.done", {
      providerType: profile.type,
      sourceLanguage,
      durationMs: elapsedMs(detectStartedAt),
      success: true,
    });
    if (profile.type === "chrome-built-in-ai") {
      currentStage = "prepareLocalAi";
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

    currentStage = "provider";
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

    currentStage = "showResult";
    const showResultStartedAt = nowMs();
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      requestId,
      state: "translated",
      sourceText,
      sourceLanguage,
      targetLanguage: input.targetLanguage,
      ...(selectedProviderId === undefined ? {} : { selectedProviderId }),
      providerOptions,
      translatedText: response.translatedText,
    });
    tracePerf("selection.showResult.done", {
      providerType: profile.type,
      durationMs: elapsedMs(showResultStartedAt),
      success: true,
    });
  } catch (error: unknown) {
    await sendSelectionTranslationError(
      input,
      {
        requestId,
        sourceText,
        sourceLanguage: resolvedSourceLanguage,
        selectedProviderId,
        providerOptions,
        errorMessage: getSelectionTranslationErrorMessage(error),
      },
      dependencies,
    );
    traceSelectionTranslationError(
      translationStartedAt,
      currentStage,
      metadataForError(error),
    );
  }
}

export function buildSelectionProviderOptions(
  profiles: ProviderProfile[],
): SelectionTranslationProviderOption[] {
  return getReadySelectionProfiles(profiles).map((profile) => {
    if (profile.type === "chrome-built-in-ai") {
      return {
        id: profile.id,
        label: "Chrome Built-in AI",
        providerMode: "local-only",
      };
    }

    return {
      id: profile.id,
      label: `${profile.displayName} / ${profile.textModel}`,
      providerMode: "remote",
    };
  });
}

export function buildSelectionTranslationConfig(input: {
  providerState: TranslateSelectionProviderState;
  savedProviderId: string | undefined;
  targetLanguage: string;
}): Extract<BackgroundResponse, { type: "selectionTranslationConfig" }> {
  const providerOptions = buildSelectionProviderOptions(input.providerState.profiles);
  const selectedProfile = selectSelectionProviderFromState({
    providerState: input.providerState,
    requestedProviderId: undefined,
    savedProviderId: input.savedProviderId,
  });

  if (!selectedProfile) {
    return {
      type: "selectionTranslationConfig",
      configured: false,
      targetLanguage: input.targetLanguage,
      providerOptions,
      message: "No translation provider is configured.",
    };
  }

  return {
    type: "selectionTranslationConfig",
    configured: true,
    targetLanguage: input.targetLanguage,
    selectedProviderId: selectedProfile.id,
    providerOptions,
  };
}

async function selectSelectionProvider(
  input: TranslateSelectionInput,
  dependencies: TranslateSelectionDependencies,
): Promise<{
  profile: ProviderProfile | undefined;
  providerOptions: SelectionTranslationProviderOption[];
}> {
  const [providerState, savedProviderId] = await Promise.all([
    dependencies.getProviderState(),
    dependencies.getSelectionProviderId(),
  ]);
  const providerOptions = buildSelectionProviderOptions(providerState.profiles);

  return {
    profile: selectSelectionProviderFromState({
      providerState,
      requestedProviderId: input.providerId,
      savedProviderId,
    }),
    providerOptions,
  };
}

function selectSelectionProviderFromState(input: {
  providerState: TranslateSelectionProviderState;
  requestedProviderId: string | undefined;
  savedProviderId: string | undefined;
}): ProviderProfile | undefined {
  const readyProfiles = getReadySelectionProfiles(input.providerState.profiles);
  const selectedProviderId = [
    input.requestedProviderId,
    input.savedProviderId,
    input.providerState.activeProviderId,
    readyProfiles[0]?.id,
  ].find(
    (providerId): providerId is string =>
      providerId !== undefined &&
      readyProfiles.some((profile) => profile.id === providerId),
  );

  return readyProfiles.find((profile) => profile.id === selectedProviderId);
}

function getReadySelectionProfiles(profiles: ProviderProfile[]): ProviderProfile[] {
  return profiles.filter(
    (profile) => evaluateProviderReadiness(profiles, profile.id).readiness === "ready",
  );
}

function traceSelectionTranslationError(
  startedAt: number,
  stage: string,
  metadata: { errorName?: string; errorCode?: string; status?: number },
): void {
  tracePerf("selection.translate.error", {
    stage,
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

function createSelectionTranslationRequestId(): string {
  return `selection-${Date.now()}-${crypto.randomUUID()}`;
}

async function sendSelectionTranslationError(
  input: TranslateSelectionInput,
  details: {
    requestId?: string;
    sourceText: string;
    sourceLanguage: string;
    selectedProviderId?: string;
    providerOptions: SelectionTranslationProviderOption[];
    errorMessage: string;
  },
  dependencies: Pick<TranslateSelectionDependencies, "sendToContent">,
): Promise<void> {
  await dependencies.sendToContent(input.tabId, {
    type: "showSelectionTranslation",
    requestId:
      details.requestId ?? input.requestId ?? createSelectionTranslationRequestId(),
    state: "failed",
    sourceText: details.sourceText,
    sourceLanguage: details.sourceLanguage,
    targetLanguage: input.targetLanguage,
    ...(details.selectedProviderId === undefined
      ? {}
      : { selectedProviderId: details.selectedProviderId }),
    providerOptions: details.providerOptions,
    errorMessage: details.errorMessage,
  });
}
