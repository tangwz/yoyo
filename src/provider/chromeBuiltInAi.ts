import { LocalAiError } from "@/provider/localAiErrors";
import type {
  TranslationProvider,
  TranslateBatchRequest,
  TranslateTextRequest,
} from "@/provider/translationProvider";

type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

type TranslatorCreateOptions = {
  sourceLanguage: string;
  targetLanguage: string;
};

type TranslatorInstance = {
  translate(text: string): Promise<string>;
  destroy?: () => void;
};

type TranslatorApi = {
  availability(options: TranslatorCreateOptions): Promise<TranslatorAvailability>;
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

export class ChromeBuiltInTranslatorProvider implements TranslationProvider {
  constructor(
    private readonly dependencies: ChromeBuiltInTranslatorProviderDependencies = {},
  ) {}

  async translateText(request: TranslateTextRequest) {
    assertChromeBuiltInProfile(request.profile);
    if (request.abortSignal?.aborted) {
      throw new LocalAiError("aborted", "Chrome Built-in AI translation was cancelled.");
    }

    const translatorApi =
      this.dependencies.getTranslatorApi?.() ?? getDefaultTranslatorApi();
    if (!translatorApi) {
      throw new LocalAiError(
        "apiUnavailable",
        "Chrome Built-in AI Translator API is not available.",
      );
    }

    const options = {
      sourceLanguage: request.sourceLanguage === "auto" ? "" : request.sourceLanguage,
      targetLanguage: request.targetLanguage,
    };
    const availability = await translatorApi.availability(options);
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

    const translator = await translatorApi.create(options);
    try {
      return {
        translatedText: await translator.translate(request.text),
      };
    } catch (error) {
      if (request.abortSignal?.aborted) {
        throw new LocalAiError(
          "aborted",
          "Chrome Built-in AI translation was cancelled.",
          error,
        );
      }
      throw new LocalAiError("unknown", "Chrome Built-in AI translation failed.", error);
    } finally {
      translator.destroy?.();
    }
  }

  async translateBatch(request: TranslateBatchRequest) {
    const items = [];
    for (const segment of request.segments) {
      const response = await this.translateText({
        profile: request.profile,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        text: segment.sourceText,
        abortSignal: request.abortSignal,
      });
      items.push({
        segmentId: segment.id,
        translatedText: response.translatedText,
      });
    }

    return { items };
  }
}
