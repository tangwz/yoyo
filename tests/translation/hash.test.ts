import { describe, expect, it } from "vitest";
import {
  createCacheKey,
  hashNormalizedText,
  serializeCacheKey,
} from "@/translation/hash";

describe("translation hash helpers", () => {
  it("normalizes whitespace before hashing", async () => {
    await expect(hashNormalizedText(" Hello\n   world ")).resolves.toBe(
      await hashNormalizedText("Hello world"),
    );
  });

  it("creates stable cache keys from normalized text and translation settings", async () => {
    const key = await createCacheKey({
      sourceText: " Hello\n   world ",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-4.1-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(key).toEqual({
      normalizedTextHash: await hashNormalizedText("Hello world"),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-4.1-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(serializeCacheKey(key)).toBe(serializeCacheKey({ ...key }));
    expect(JSON.parse(serializeCacheKey(key))).toEqual(key);
  });

  it("separates cache identity by source language", async () => {
    const baseInput = {
      sourceText: "Hello",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-4.1-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    };

    const englishKey = await createCacheKey({
      ...baseInput,
      sourceLanguage: "en",
    });
    const spanishKey = await createCacheKey({
      ...baseInput,
      sourceLanguage: "es",
    });

    expect(englishKey.normalizedTextHash).toBe(spanishKey.normalizedTextHash);
    expect(serializeCacheKey(englishKey)).not.toBe(serializeCacheKey(spanishKey));
    expect(JSON.parse(serializeCacheKey(englishKey))).toMatchObject({
      sourceLanguage: "en",
    });
  });
});
