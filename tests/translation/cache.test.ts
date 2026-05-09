import { describe, expect, it } from "vitest";
import { SessionTranslationCache } from "@/translation/cache";
import type { TranslationCacheKey, TranslationResultItem } from "@/translation/types";

function cacheKey(sourceLanguage: string): TranslationCacheKey {
  return {
    normalizedTextHash: "hash",
    sourceLanguage,
    targetLanguage: "zh-CN",
    providerId: "openai-compatible",
    textModel: "gpt-4.1-mini",
    translationStyle: "concise",
    promptVersion: "v1",
  };
}

describe("SessionTranslationCache", () => {
  it("gets, sets, and clears cached translations", () => {
    const cache = new SessionTranslationCache();
    const key = cacheKey("en");
    const item: TranslationResultItem = {
      segmentId: "a",
      translatedText: "Alpha",
    };

    expect(cache.get(key)).toBeUndefined();

    cache.set(key, item);
    expect(cache.get(key)).toEqual(item);

    cache.clear();
    expect(cache.get(key)).toBeUndefined();
  });

  it("keeps source-language-separated keys independent", () => {
    const cache = new SessionTranslationCache();
    const englishKey = cacheKey("en");
    const spanishKey = cacheKey("es");

    cache.set(englishKey, {
      segmentId: "a",
      translatedText: "English source",
    });

    expect(cache.get(spanishKey)).toBeUndefined();
  });
});
