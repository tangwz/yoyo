import type {
  SubtitleSourceLanguage,
  SubtitleTranslationMode,
} from "@/subtitle/types";

export type SubtitleSessionCacheKeyInput = {
  videoId: string;
  trackKey: string;
  sourceLanguage: SubtitleSourceLanguage;
  targetLanguage: string;
  providerId: string;
  modelKey: string;
  segmentTextHash: string;
  segmentationVersion: string;
  translationMode: SubtitleTranslationMode | string;
  promptVersion: string;
};

export type SubtitleSessionCacheKey = string;

export function createSubtitleSessionCacheKey(
  input: SubtitleSessionCacheKeyInput,
): SubtitleSessionCacheKey {
  return JSON.stringify([
    ["videoId", input.videoId],
    ["trackKey", input.trackKey],
    ["sourceLanguage", normalizeSourceLanguage(input.sourceLanguage)],
    ["targetLanguage", input.targetLanguage],
    ["providerId", input.providerId],
    ["modelKey", input.modelKey],
    ["segmentTextHash", input.segmentTextHash],
    ["segmentationVersion", input.segmentationVersion],
    ["translationMode", input.translationMode],
    ["promptVersion", input.promptVersion],
  ]);
}

export class SubtitleSessionCache {
  private readonly translations = new Map<SubtitleSessionCacheKey, string>();

  get(key: SubtitleSessionCacheKey): string | undefined {
    return this.translations.get(key);
  }

  set(key: SubtitleSessionCacheKey, translatedText: string): void {
    this.translations.set(key, translatedText);
  }

  has(key: SubtitleSessionCacheKey): boolean {
    return this.translations.has(key);
  }

  delete(key: SubtitleSessionCacheKey): void {
    this.translations.delete(key);
  }

  clear(): void {
    this.translations.clear();
  }
}

function normalizeSourceLanguage(
  sourceLanguage: SubtitleSourceLanguage,
): readonly [string, string?] {
  if (sourceLanguage.kind === "unknown") {
    return ["unknown"];
  }

  return ["known", sourceLanguage.code];
}
