import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

export type SubtitleSegmentValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export type SubtitleSegmentValidationOptions = {
  maxDurationMs?: number;
  maxWords?: number;
  maxChars?: number;
  characterStrategy?: boolean;
};

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function validateSegmentBounds(
  segment: SubtitleSegment,
  options: SubtitleSegmentValidationOptions,
): SubtitleSegmentValidationResult {
  if (
    options.maxDurationMs !== undefined &&
    segment.endMs - segment.startMs > options.maxDurationMs
  ) {
    return { valid: false, reason: "Segment exceeds maximum duration." };
  }

  if (
    options.characterStrategy === true &&
    options.maxChars !== undefined &&
    Array.from(segment.sourceText).length > options.maxChars
  ) {
    return { valid: false, reason: "Segment exceeds maximum character count." };
  }

  if (
    options.characterStrategy === false &&
    options.maxWords !== undefined &&
    countWords(segment.sourceText) > options.maxWords
  ) {
    return { valid: false, reason: "Segment exceeds maximum word count." };
  }

  return { valid: true };
}

export function validateSubtitleSegments(
  cues: readonly SubtitleCue[],
  segments: readonly SubtitleSegment[],
  options: SubtitleSegmentValidationOptions = {},
): SubtitleSegmentValidationResult {
  if (cues.length === 0 || segments.length === 0) {
    return { valid: false, reason: "Segments must cover at least one cue." };
  }

  let expectedCuePosition = 0;
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex]!;
    const expectedCue = cues[expectedCuePosition];
    if (
      !expectedCue ||
      segment.sourceCueStartIndex !== expectedCue.index
    ) {
      return {
        valid: false,
        reason: "Segments do not continuously cover source cues.",
      };
    }
    if (segment.sourceCueEndIndex < segment.sourceCueStartIndex) {
      return { valid: false, reason: "Segment range is invalid." };
    }

    if (segment.sourceCueStartIndex === segment.sourceCueEndIndex) {
      const cue = expectedCue;

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
        const boundsResult = validateSegmentBounds(splitSegment, options);
        if (!boundsResult.valid) {
          return boundsResult;
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

      expectedCuePosition += 1;
      continue;
    }

    const coveredEndPosition = cues.findIndex(
      (cue, position) =>
        position >= expectedCuePosition &&
        cue.index === segment.sourceCueEndIndex,
    );
    if (coveredEndPosition < expectedCuePosition) {
      return { valid: false, reason: "Segment does not cover any cues." };
    }
    const covered = cues.slice(expectedCuePosition, coveredEndPosition + 1);
    if (
      covered.map((cue) => cue.cueId).join("|") !==
      segment.sourceCueIds.join("|")
    ) {
      return { valid: false, reason: "Segment cue ids do not match its range." };
    }
    const boundsResult = validateSegmentBounds(segment, options);
    if (!boundsResult.valid) {
      return boundsResult;
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

    expectedCuePosition = coveredEndPosition + 1;
    segmentIndex += 1;
  }

  if (expectedCuePosition !== cues.length) {
    return {
      valid: false,
      reason: "Segments do not cover every source cue.",
    };
  }

  return { valid: true };
}
