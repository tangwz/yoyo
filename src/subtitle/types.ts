export type SubtitleSourceLanguage =
  | { kind: "known"; code: string }
  | { kind: "unknown" };

export type SubtitleTranslationMode = "youtubeSubtitleRealtime";

export type SubtitleCue = {
  cueId: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type SubtitleSegment = {
  segmentId: string;
  sourceCueIds: string[];
  sourceCueStartIndex: number;
  sourceCueEndIndex: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  textHash: string;
};

export type SubtitleTranslationItem = {
  segmentId: string;
  translatedText: string;
};

export type SubtitlePreferences = {
  schemaVersion: 1;
  youtubeEnabled: boolean;
  aiSegmentationEnabled: boolean;
  prefetchBeforeMs: number;
  prefetchAfterMs: number;
  maxRetryCount: number;
};

export const defaultSubtitlePreferences: SubtitlePreferences = {
  schemaVersion: 1,
  youtubeEnabled: true,
  aiSegmentationEnabled: false,
  prefetchBeforeMs: 2000,
  prefetchAfterMs: 90000,
  maxRetryCount: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

export function normalizeSubtitlePreferences(value: unknown): SubtitlePreferences {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return defaultSubtitlePreferences;
  }

  return {
    schemaVersion: 1,
    youtubeEnabled:
      typeof value.youtubeEnabled === "boolean"
        ? value.youtubeEnabled
        : defaultSubtitlePreferences.youtubeEnabled,
    aiSegmentationEnabled:
      typeof value.aiSegmentationEnabled === "boolean"
        ? value.aiSegmentationEnabled
        : defaultSubtitlePreferences.aiSegmentationEnabled,
    prefetchBeforeMs: boundedNumber(
      value.prefetchBeforeMs,
      0,
      10000,
      defaultSubtitlePreferences.prefetchBeforeMs,
    ),
    prefetchAfterMs: boundedNumber(
      value.prefetchAfterMs,
      15000,
      180000,
      defaultSubtitlePreferences.prefetchAfterMs,
    ),
    maxRetryCount: boundedNumber(
      value.maxRetryCount,
      0,
      5,
      defaultSubtitlePreferences.maxRetryCount,
    ),
  };
}
