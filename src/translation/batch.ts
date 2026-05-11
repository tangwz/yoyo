import type { PageSegment } from "@/translation/types";

export type BatchOptions = {
  maxCharsPerBatch: number;
  maxSegmentsPerBatch: number;
};

export function splitSegmentsIntoBatches(
  segments: readonly PageSegment[],
  options: BatchOptions,
): PageSegment[][] {
  if (options.maxCharsPerBatch <= 0) {
    throw new Error("maxCharsPerBatch must be greater than 0.");
  }

  if (options.maxSegmentsPerBatch <= 0) {
    throw new Error("maxSegmentsPerBatch must be greater than 0.");
  }

  const priorityRank: Record<PageSegment["priority"], number> = {
    viewport: 0,
    nearViewport: 1,
    normal: 2,
  };
  const orderedSegments = [...segments].sort(
    (left, right) =>
      priorityRank[left.priority] - priorityRank[right.priority] ||
      left.order - right.order,
  );
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
