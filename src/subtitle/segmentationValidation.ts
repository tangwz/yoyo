import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

export type SubtitleSegmentValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateSubtitleSegments(
  cues: readonly SubtitleCue[],
  segments: readonly SubtitleSegment[],
): SubtitleSegmentValidationResult {
  if (cues.length === 0 || segments.length === 0) {
    return { valid: false, reason: "Segments must cover at least one cue." };
  }

  let expectedCueIndex = 0;
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex]!;
    if (segment.sourceCueStartIndex !== expectedCueIndex) {
      return {
        valid: false,
        reason: "Segments do not continuously cover source cues.",
      };
    }
    if (segment.sourceCueEndIndex < segment.sourceCueStartIndex) {
      return { valid: false, reason: "Segment range is invalid." };
    }

    if (segment.sourceCueStartIndex === segment.sourceCueEndIndex) {
      const cue = cues[segment.sourceCueStartIndex];
      if (!cue) {
        return { valid: false, reason: "Segment does not cover any cues." };
      }

      let expectedStartMs = cue.startMs;
      while (segmentIndex < segments.length) {
        const splitSegment = segments[segmentIndex]!;
        if (
          splitSegment.sourceCueStartIndex !== cue.index ||
          splitSegment.sourceCueEndIndex !== cue.index
        ) {
          break;
        }
        if (splitSegment.sourceCueIds.join("|") !== cue.cueId) {
          return {
            valid: false,
            reason: "Segment cue ids do not match its range.",
          };
        }
        if (
          splitSegment.startMs !== expectedStartMs ||
          splitSegment.endMs <= splitSegment.startMs ||
          splitSegment.endMs > cue.endMs
        ) {
          return {
            valid: false,
            reason: "Split segment timing does not cover its source cue.",
          };
        }

        expectedStartMs = splitSegment.endMs;
        segmentIndex += 1;
      }

      if (expectedStartMs !== cue.endMs) {
        return {
          valid: false,
          reason: "Split segments do not cover their source cue.",
        };
      }

      expectedCueIndex += 1;
      continue;
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
    segmentIndex += 1;
  }

  if (expectedCueIndex !== cues.length) {
    return {
      valid: false,
      reason: "Segments do not cover every source cue.",
    };
  }

  return { valid: true };
}
