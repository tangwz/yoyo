import { LocalAiError } from "@/provider/localAiErrors";
import type {
  TranslationProvider,
  TranslateBatchRequest,
  TranslateTextRequest,
} from "@/provider/translationProvider";
import { elapsedMs, metadataForError, nowMs, tracePerf } from "@/utils/perfTrace";

export type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export type TranslatorLanguageOptions = {
  sourceLanguage: string;
  targetLanguage: string;
};

export type ChromeBuiltInAiDownloadMonitor = EventTarget;

export type TranslatorCreateOptions = TranslatorLanguageOptions & {
  signal?: AbortSignal;
  monitor?: (monitor: ChromeBuiltInAiDownloadMonitor) => void;
};

export type TranslatorTranslateOptions = {
  signal?: AbortSignal;
};

export type TranslatorInstance = {
  translate(text: string, options?: TranslatorTranslateOptions): Promise<string>;
  destroy?: () => void | Promise<void>;
};

export type TranslatorApi = {
  availability(options: TranslatorLanguageOptions): Promise<TranslatorAvailability>;
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
};

export type LanguageDetectorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export type LanguageDetectionResult = {
  detectedLanguage: string;
  confidence?: number;
};

export type LanguageDetectorCreateOptions = {
  signal?: AbortSignal;
  monitor?: (monitor: ChromeBuiltInAiDownloadMonitor) => void;
};

export type LanguageDetectorInstance = {
  detect(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<LanguageDetectionResult[]>;
  destroy?: () => void | Promise<void>;
};

export type LanguageDetectorApi = {
  availability(): Promise<LanguageDetectorAvailability>;
  create(options?: LanguageDetectorCreateOptions): Promise<LanguageDetectorInstance>;
};

type ChromeBuiltInTranslatorProviderDependencies = {
  getTranslatorApi?: () => TranslatorApi | undefined;
};

const providerType = "chrome-built-in-ai" as const;

function getDefaultTranslatorApi(): TranslatorApi | undefined {
  return (globalThis as typeof globalThis & { Translator?: TranslatorApi }).Translator;
}

function assertChromeBuiltInProfile(profile: TranslateTextRequest["profile"]): void {
  if (profile.type !== "chrome-built-in-ai") {
    throw new LocalAiError(
      "unknown",
      "Chrome Built-in AI translation requires a Chrome Built-in AI profile.",
    );
  }
}

function assertExplicitSourceLanguage(sourceLanguage: string): void {
  if (sourceLanguage === "auto") {
    throw new LocalAiError(
      "languagePairUnavailable",
      "Chrome Built-in AI requires an explicit source language.",
    );
  }
}

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function getErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function isApiUnavailableError(error: unknown): boolean {
  if (getErrorName(error) === "ApiUnavailableError") {
    return true;
  }

  return getErrorMessage(error) === "Chrome Built-in AI Translator API is not available.";
}

function mapTranslatorError(error: unknown, aborted: boolean): LocalAiError {
  if (aborted || getErrorName(error) === "AbortError") {
    return new LocalAiError(
      "aborted",
      "Chrome Built-in AI translation was cancelled.",
      error,
    );
  }

  switch (getErrorName(error)) {
    case "NotSupportedError":
      return new LocalAiError(
        "languagePairUnavailable",
        "Chrome Built-in AI is not available for this language pair.",
        error,
      );
    case "QuotaExceededError":
      return new LocalAiError(
        "textTooLong",
        "Chrome Built-in AI cannot translate text of this size.",
        error,
      );
    case "NetworkError":
      return new LocalAiError(
        "modelDownloadFailed",
        "Chrome could not download the local translation model.",
        error,
      );
    case "NotAllowedError":
      return new LocalAiError(
        "modelDownloadRequired",
        "Chrome needs user activation to download or initialize the local translation model.",
        error,
      );
  }

  if (isApiUnavailableError(error)) {
    return new LocalAiError(
      "apiUnavailable",
      "Chrome Built-in AI Translator API is not available.",
      error,
    );
  }

  return new LocalAiError("unknown", "Chrome Built-in AI translation failed.", error);
}

async function destroyTranslator(translator: TranslatorInstance): Promise<void> {
  try {
    await translator.destroy?.();
  } catch (error) {
    console.warn("[yoyo] failed to destroy Chrome Built-in AI translator", error);
  }
}

function traceEarlyAbortedRequest(
  request: TranslateTextRequest | TranslateBatchRequest,
  requestType: "translateText" | "translateBatch",
): void {
  const startedAt = nowMs();
  const error = new LocalAiError(
    "aborted",
    "Chrome Built-in AI translation was cancelled.",
  );
  tracePerf("localAi.request.error", {
    ...request.traceContext,
    providerType,
    requestType,
    durationMs: elapsedMs(startedAt),
    success: false,
    ...metadataForError(error),
  });
}

export class ChromeBuiltInTranslatorProvider implements TranslationProvider {
  constructor(
    private readonly dependencies: ChromeBuiltInTranslatorProviderDependencies = {},
  ) {}

  async translateText(request: TranslateTextRequest) {
    assertChromeBuiltInProfile(request.profile);
    if (request.abortSignal?.aborted) {
      traceEarlyAbortedRequest(request, "translateText");
    }
    const translator = await this.createTranslator({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
    });

    const translateStartedAt = nowMs();
    try {
      const translatedText = await translator.translate(request.text, {
        signal: request.abortSignal,
      });
      tracePerf("localAi.translate.segment.done", {
        ...request.traceContext,
        providerType,
        segmentId: "selection",
        segmentOrder: 1,
        sourceCharCount: request.text.length,
        durationMs: elapsedMs(translateStartedAt),
        success: true,
      });
      return {
        translatedText,
      };
    } catch (error) {
      tracePerf("localAi.request.error", {
        ...request.traceContext,
        providerType,
        requestType: "translate",
        durationMs: elapsedMs(translateStartedAt),
        success: false,
        ...metadataForError(error),
      });
      throw mapTranslatorError(error, request.abortSignal?.aborted ?? false);
    } finally {
      await destroyTranslator(translator);
    }
  }

  async translateBatch(request: TranslateBatchRequest) {
    assertChromeBuiltInProfile(request.profile);
    if (request.abortSignal?.aborted) {
      traceEarlyAbortedRequest(request, "translateBatch");
    }
    const translator = await this.createTranslator({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
    });

    const batchStartedAt = nowMs();
    try {
      const items = [];
      let sourceCharCount = 0;
      for (const segment of request.segments) {
        sourceCharCount += segment.sourceText.length;
        const segmentStartedAt = nowMs();
        items.push({
          segmentId: segment.id,
          translatedText: await translator.translate(segment.sourceText, {
            signal: request.abortSignal,
          }),
        });
        tracePerf("localAi.translate.segment.done", {
          ...request.traceContext,
          providerType,
          segmentId: segment.id,
          segmentOrder: segment.order,
          sourceCharCount: segment.sourceText.length,
          durationMs: elapsedMs(segmentStartedAt),
          success: true,
        });
      }

      tracePerf("localAi.translate.batch.done", {
        ...request.traceContext,
        providerType,
        segmentCount: request.segments.length,
        sourceCharCount,
        durationMs: elapsedMs(batchStartedAt),
        success: true,
      });
      return { items };
    } catch (error) {
      tracePerf("localAi.request.error", {
        ...request.traceContext,
        providerType,
        requestType: "translate",
        durationMs: elapsedMs(batchStartedAt),
        success: false,
        ...metadataForError(error),
      });
      throw mapTranslatorError(error, request.abortSignal?.aborted ?? false);
    } finally {
      await destroyTranslator(translator);
    }
  }

  private async createTranslator(options: TranslatorLanguageOptions & { abortSignal?: AbortSignal }) {
    assertExplicitSourceLanguage(options.sourceLanguage);
    if (options.abortSignal?.aborted) {
      throw new LocalAiError("aborted", "Chrome Built-in AI translation was cancelled.");
    }

    const translatorApi = this.dependencies.getTranslatorApi
      ? this.dependencies.getTranslatorApi()
      : getDefaultTranslatorApi();
    if (!translatorApi) {
      throw new LocalAiError(
        "apiUnavailable",
        "Chrome Built-in AI Translator API is not available.",
      );
    }

    const languageOptions = {
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
    };

    let availability: TranslatorAvailability;
    let startedAt = nowMs();
    try {
      availability = await translatorApi.availability(languageOptions);
      tracePerf("localAi.availability.done", {
        providerType,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        availability,
        durationMs: elapsedMs(startedAt),
        success: true,
      });
    } catch (error) {
      tracePerf("localAi.request.error", {
        providerType,
        requestType: "availability",
        durationMs: elapsedMs(startedAt),
        success: false,
        ...metadataForError(error),
      });
      throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
    }

    if (availability === "unavailable") {
      throw new LocalAiError(
        "languagePairUnavailable",
        "Chrome Built-in AI is not available for this language pair.",
      );
    }
    try {
      startedAt = nowMs();
      const translator = await translatorApi.create({
        ...languageOptions,
        signal: options.abortSignal,
      });
      tracePerf("localAi.createTranslator.done", {
        providerType,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        durationMs: elapsedMs(startedAt),
        success: true,
      });
      return translator;
    } catch (error) {
      tracePerf("localAi.request.error", {
        providerType,
        requestType: "create",
        durationMs: elapsedMs(startedAt),
        success: false,
        ...metadataForError(error),
      });
      throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
    }
  }
}
