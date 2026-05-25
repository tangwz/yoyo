import { describe, expect, it } from "vitest";
import { SubtitleTranslationCache } from "@/background/youtubeSubtitle/cache";

describe("SubtitleTranslationCache", () => {
  it("refreshes recency on get and evicts the oldest entry", () => {
    const cache = new SubtitleTranslationCache<string>(2);

    cache.set("first", "First");
    cache.set("second", "Second");

    expect(cache.get("first")).toBe("First");

    cache.set("third", "Third");

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("First");
    expect(cache.get("third")).toBe("Third");
  });

  it("overwrites an existing entry without consuming extra capacity", () => {
    const cache = new SubtitleTranslationCache<string>(2);

    cache.set("first", "First");
    cache.set("second", "Second");
    cache.set("first", "Updated first");
    cache.set("third", "Third");

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("Updated first");
    expect(cache.get("third")).toBe("Third");
    expect(cache.size).toBe(2);
  });

  it("supports delete and clear", () => {
    const cache = new SubtitleTranslationCache<string>(2);

    cache.set("first", "First");
    cache.set("second", "Second");

    expect(cache.delete("first")).toBe(true);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.clear();

    expect(cache.get("second")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
