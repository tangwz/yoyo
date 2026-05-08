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
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-4.1-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(key).toEqual({
      normalizedTextHash: await hashNormalizedText("Hello world"),
      targetLanguage: "zh-CN",
      providerId: "openai-compatible",
      textModel: "gpt-4.1-mini",
      translationStyle: "concise",
      promptVersion: "v1",
    });

    expect(serializeCacheKey(key)).toBe(serializeCacheKey({ ...key }));
    expect(JSON.parse(serializeCacheKey(key))).toEqual(key);
  });
});
