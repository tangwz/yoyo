import { describe, expect, it } from "vitest";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
} from "@/subtitle/types";

describe("subtitle types", () => {
  it("normalizes corrupt preferences to bounded defaults", () => {
    expect(normalizeSubtitlePreferences(null)).toEqual(defaultSubtitlePreferences);
    expect(
      normalizeSubtitlePreferences({
        schemaVersion: 1,
        youtubeEnabled: "yes",
        aiSegmentationEnabled: "no",
        prefetchBeforeMs: -1,
        prefetchAfterMs: 999999,
        maxRetryCount: 99,
      }),
    ).toEqual(defaultSubtitlePreferences);
  });

  it("keeps valid bounded subtitle preferences", () => {
    expect(
      normalizeSubtitlePreferences({
        schemaVersion: 1,
        youtubeEnabled: false,
        aiSegmentationEnabled: true,
        prefetchBeforeMs: 5000,
        prefetchAfterMs: 60000,
        maxRetryCount: 3,
      }),
    ).toEqual({
      schemaVersion: 1,
      youtubeEnabled: false,
      aiSegmentationEnabled: true,
      prefetchBeforeMs: 5000,
      prefetchAfterMs: 60000,
      maxRetryCount: 3,
    });
  });
});
