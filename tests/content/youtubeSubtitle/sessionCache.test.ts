import { describe, expect, it } from "vitest";
import {
  createSubtitleSessionCacheKey,
  SubtitleSessionCache,
  type SubtitleSessionCacheKeyInput,
} from "@/content/youtubeSubtitle/sessionCache";

function keyInput(
  overrides: Partial<SubtitleSessionCacheKeyInput> = {},
): SubtitleSessionCacheKeyInput {
  return {
    videoId: "video-1",
    trackKey: "track-1",
    sourceLanguage: { kind: "known", code: "en" },
    targetLanguage: "zh-CN",
    providerId: "openai",
    modelKey: "gpt-4.1-mini",
    segmentTextHash: "text-hash-1",
    segmentationVersion: "v1",
    translationMode: "youtubeSubtitleRealtime",
    promptVersion: "prompt-v1",
    ...overrides,
  };
}

describe("createSubtitleSessionCacheKey", () => {
  it("uses an unambiguous JSON tuple representation", () => {
    expect(() => JSON.parse(createSubtitleSessionCacheKey(keyInput()))).not.toThrow();
    expect(
      createSubtitleSessionCacheKey(
        keyInput({ videoId: "a|b", trackKey: "c", segmentTextHash: "d" }),
      ),
    ).not.toBe(
      createSubtitleSessionCacheKey(
        keyInput({ videoId: "a", trackKey: "b|c", segmentTextHash: "d" }),
      ),
    );
  });

  it.each([
    ["videoId", { videoId: "video-2" }],
    ["trackKey", { trackKey: "track-2" }],
    ["promptVersion", { promptVersion: "prompt-v2" }],
    ["segmentationVersion", { segmentationVersion: "v2" }],
    ["translationMode", { translationMode: "youtubeSubtitleRealtime:v2" }],
    ["known source language", { sourceLanguage: { kind: "known", code: "ja" } }],
    ["unknown source language", { sourceLanguage: { kind: "unknown" } }],
    ["providerId", { providerId: "chrome-ai" }],
    ["modelKey", { modelKey: "gemini-nano" }],
    ["targetLanguage", { targetLanguage: "ja" }],
    ["segmentTextHash", { segmentTextHash: "text-hash-2" }],
  ] satisfies Array<[string, Partial<SubtitleSessionCacheKeyInput>]>)(
    "varies by %s",
    (_name, overrides) => {
      expect(createSubtitleSessionCacheKey(keyInput(overrides))).not.toBe(
        createSubtitleSessionCacheKey(keyInput()),
      );
    },
  );

  it("distinguishes unknown source language from a known language named unknown", () => {
    expect(
      createSubtitleSessionCacheKey(
        keyInput({ sourceLanguage: { kind: "unknown" } }),
      ),
    ).not.toBe(
      createSubtitleSessionCacheKey(
        keyInput({ sourceLanguage: { kind: "known", code: "unknown" } }),
      ),
    );
  });
});

describe("SubtitleSessionCache", () => {
  it("stores, overwrites, deletes, and clears current session translations", () => {
    const cache = new SubtitleSessionCache();
    const key = createSubtitleSessionCacheKey(keyInput());

    expect(cache.has(key)).toBe(false);
    expect(cache.get(key)).toBeUndefined();

    cache.set(key, "First translation.");
    expect(cache.has(key)).toBe(true);
    expect(cache.get(key)).toBe("First translation.");

    cache.set(key, "Second translation.");
    expect(cache.get(key)).toBe("Second translation.");

    cache.delete(key);
    expect(cache.has(key)).toBe(false);

    cache.set(key, "Third translation.");
    cache.clear();
    expect(cache.get(key)).toBeUndefined();
  });
});
