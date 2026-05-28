import { describe, expect, it } from "vitest";
import {
  createCacheKey,
  hashNormalizedText,
  hashSourceText,
  serializeCacheKey,
} from "@/translation/hash";

describe("translation hash helpers", () => {
  it("normalizes whitespace before hashing", async () => {
    await expect(hashNormalizedText(" Hello\n   world ")).resolves.toBe(
      await hashNormalizedText("Hello world"),
    );
  });

  it("normalizes non-breaking spaces before hashing", async () => {
    await expect(hashNormalizedText("Hello\u00A0world")).resolves.toBe(
      await hashNormalizedText("Hello world"),
    );
  });

  it("can hash source text without whitespace normalization", async () => {
    await expect(hashSourceText("Hello\nworld")).resolves.not.toBe(
      await hashSourceText("Hello world"),
    );
  });

  it("creates stable cache keys from normalized text and translation settings", async () => {
    const key = await createCacheKey({
      sourceText: " Hello\n   world ",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-5-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(key).toEqual({
      normalizedTextHash: await hashNormalizedText("Hello world"),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-5-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(serializeCacheKey(key)).toBe(serializeCacheKey({ ...key }));
    expect(JSON.parse(serializeCacheKey(key))).toEqual(key);
  });

  it("creates formatting-sensitive cache keys for preserved whitespace", async () => {
    const baseInput = {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-5-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    };

    const formattedKey = await createCacheKey({
      ...baseInput,
      sourceText: "foo\nbar",
      preserveWhitespace: true,
    });
    const flattenedKey = await createCacheKey({
      ...baseInput,
      sourceText: "foo bar",
      preserveWhitespace: true,
    });

    expect(serializeCacheKey(formattedKey)).not.toBe(
      serializeCacheKey(flattenedKey),
    );
  });

  it("separates cache identity by source language", async () => {
    const baseInput = {
      sourceText: "Hello",
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-5-mini",
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
