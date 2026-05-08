import type { PageSegment } from "@/translation/types";

export type BatchOptions = {
  maxCharsPerBatch: number;
  maxSegmentsPerBatch: number;
};

export function splitSegmentsIntoBatches(
  segments: readonly PageSegment[],
  options: BatchOptions,
): PageSegment[][] {
  const orderedSegments = [...segments].sort((left, right) => left.order - right.order);
  const batches: PageSegment[][] = [];
  let currentBatch: PageSegment[] = [];
  let currentChars = 0;

  for (const segment of orderedSegments) {
    const segmentChars = segment.sourceText.length;
    const wouldExceedChars =
      currentBatch.length > 0 &&
      currentChars + segmentChars > options.maxCharsPerBatch;
    const wouldExceedSegments =
      currentBatch.length >= options.maxSegmentsPerBatch;

    if (wouldExceedChars || wouldExceedSegments) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(segment);
    currentChars += segmentChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
