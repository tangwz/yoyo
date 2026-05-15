import { LocalAiError } from "@/provider/localAiErrors";
import type {
  TranslationProvider,
  TranslateBatchRequest,
  TranslateTextRequest,
} from "@/provider/translationProvider";

export type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export type TranslatorLanguageOptions = {
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslatorCreateOptions = TranslatorLanguageOptions & {
  signal?: AbortSignal;
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

type ChromeBuiltInTranslatorProviderDependencies = {
  getTranslatorApi?: () => TranslatorApi | undefined;
};

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
    case "ApiUnavailableError":
      return new LocalAiError(
        "apiUnavailable",
        "Chrome Built-in AI Translator API is not available.",
        error,
      );
    default:
      return new LocalAiError("unknown", "Chrome Built-in AI translation failed.", error);
  }
}

async function destroyTranslator(translator: TranslatorInstance): Promise<void> {
  try {
    await translator.destroy?.();
  } catch (error) {
    console.warn("[yoyo] failed to destroy Chrome Built-in AI translator", error);
  }
}

export class ChromeBuiltInTranslatorProvider implements TranslationProvider {
  constructor(
    private readonly dependencies: ChromeBuiltInTranslatorProviderDependencies = {},
  ) {}

  async translateText(request: TranslateTextRequest) {
    assertChromeBuiltInProfile(request.profile);
    const translator = await this.createTranslator({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
    });

    try {
      return {
        translatedText: await translator.translate(request.text, {
          signal: request.abortSignal,
        }),
      };
    } catch (error) {
      throw mapTranslatorError(error, request.abortSignal?.aborted ?? false);
    } finally {
      await destroyTranslator(translator);
    }
  }

  async translateBatch(request: TranslateBatchRequest) {
    assertChromeBuiltInProfile(request.profile);
    const translator = await this.createTranslator({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
    });

    try {
      const items = [];
      for (const segment of request.segments) {
        items.push({
          segmentId: segment.id,
          translatedText: await translator.translate(segment.sourceText, {
            signal: request.abortSignal,
          }),
        });
      }

      return { items };
    } catch (error) {
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
    try {
      availability = await translatorApi.availability(languageOptions);
    } catch (error) {
      throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
    }

    if (availability === "unavailable") {
      throw new LocalAiError(
        "languagePairUnavailable",
        "Chrome Built-in AI is not available for this language pair.",
      );
    }
    if (availability === "downloadable" || availability === "downloading") {
      throw new LocalAiError(
        "modelDownloadRequired",
        "Chrome needs to download a local translation model before translating this language pair.",
      );
    }

    try {
      return await translatorApi.create({
        ...languageOptions,
        signal: options.abortSignal,
      });
    } catch (error) {
      throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
    }
  }
}
