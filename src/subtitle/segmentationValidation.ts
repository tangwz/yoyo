import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

export type SubtitleSegmentValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateSubtitleSegments(
  cues: readonly SubtitleCue[],
  segments: readonly SubtitleSegment[],
): SubtitleSegmentValidationResult {
  let expectedCueIndex = 0;

  for (const segment of segments) {
    if (segment.sourceCueStartIndex !== expectedCueIndex) {
      return {
        valid: false,
        reason: "Segments do not continuously cover source cues.",
      };
    }
    if (segment.sourceCueEndIndex < segment.sourceCueStartIndex) {
      return { valid: false, reason: "Segment range is invalid." };
    }

    const covered = cues.slice(
      segment.sourceCueStartIndex,
      segment.sourceCueEndIndex + 1,
    );
    if (covered.length === 0) {
      return { valid: false, reason: "Segment does not cover any cues." };
    }
    if (
      covered.map((cue) => cue.cueId).join("|") !==
      segment.sourceCueIds.join("|")
    ) {
      return { valid: false, reason: "Segment cue ids do not match its range." };
    }
    if (
      segment.startMs !== covered[0]!.startMs ||
      segment.endMs !== covered.at(-1)!.endMs
    ) {
      return {
        valid: false,
        reason: "Segment timing does not come from source cues.",
      };
    }

    expectedCueIndex = segment.sourceCueEndIndex + 1;
  }

  if (expectedCueIndex !== cues.length) {
    return {
      valid: false,
      reason: "Segments do not cover every source cue.",
    };
  }

  return { valid: true };
}
