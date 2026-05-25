import type { SubtitleSegment } from "@/subtitle/types";

export type SubtitleSchedulerOptions = {
  prefetchBeforeMs: number;
  prefetchAfterMs: number;
  maxRetryCount: number;
  maxBatchSegments: number;
  maxBatchChars: number;
};

export const defaultSubtitleSchedulerOptions: SubtitleSchedulerOptions = {
  prefetchBeforeMs: 2000,
  prefetchAfterMs: 90000,
  maxRetryCount: 2,
  maxBatchSegments: 8,
  maxBatchChars: 2400,
};

export class SubtitleScheduler {
  private timeline: SubtitleSegment[] = [];
  private readonly pendingSegmentIds = new Set<string>();
  private readonly inFlightSegmentIds = new Set<string>();
  private readonly translatedSegmentIds = new Set<string>();
  private readonly failureCounts = new Map<string, number>();
  private readonly requestIdsBySegmentId = new Map<string, string>();

  constructor(private readonly options: SubtitleSchedulerOptions) {
    assertNonNegativeOption(options.prefetchBeforeMs, "prefetchBeforeMs");
    assertNonNegativeOption(options.prefetchAfterMs, "prefetchAfterMs");
    assertNonNegativeOption(options.maxRetryCount, "maxRetryCount");
    assertPositiveOption(options.maxBatchSegments, "maxBatchSegments");
    assertPositiveOption(options.maxBatchChars, "maxBatchChars");
  }

  replaceTimeline(segments: readonly SubtitleSegment[]): void {
    this.timeline = [...segments];
    this.pendingSegmentIds.clear();
    this.inFlightSegmentIds.clear();
    this.translatedSegmentIds.clear();
    this.failureCounts.clear();
    this.requestIdsBySegmentId.clear();
  }

  scanWindow(currentTimeMs: number): void {
    const windowStartMs = currentTimeMs - this.options.prefetchBeforeMs;
    const windowEndMs = currentTimeMs + this.options.prefetchAfterMs;

    for (const segment of this.timeline) {
      if (
        intersectsWindow(segment, windowStartMs, windowEndMs) &&
        this.isEligible(segment.segmentId)
      ) {
        this.pendingSegmentIds.add(segment.segmentId);
      }
    }
  }

  takeBatch(requestId: string): SubtitleSegment[] {
    const batch: SubtitleSegment[] = [];
    let batchChars = 0;

    for (const segment of this.pendingSegments()) {
      const segmentChars = segment.sourceText.length;
      const wouldExceedSegmentLimit =
        batch.length >= this.options.maxBatchSegments;
      const wouldExceedCharLimit =
        batch.length > 0 &&
        batchChars + segmentChars > this.options.maxBatchChars;

      if (wouldExceedSegmentLimit || wouldExceedCharLimit) {
        break;
      }

      batch.push(segment);
      batchChars += segmentChars;
    }

    for (const segment of batch) {
      this.pendingSegmentIds.delete(segment.segmentId);
      this.inFlightSegmentIds.add(segment.segmentId);
      this.requestIdsBySegmentId.set(segment.segmentId, requestId);
    }

    return batch;
  }

  markTranslated(requestId: string, segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      if (!this.isCurrentRequest(segmentId, requestId)) {
        continue;
      }
      this.pendingSegmentIds.delete(segmentId);
      this.inFlightSegmentIds.delete(segmentId);
      this.requestIdsBySegmentId.delete(segmentId);
      this.translatedSegmentIds.add(segmentId);
      this.failureCounts.delete(segmentId);
    }
  }

  markFailed(requestId: string, segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      if (!this.isCurrentRequest(segmentId, requestId)) {
        continue;
      }
      this.pendingSegmentIds.delete(segmentId);
      this.inFlightSegmentIds.delete(segmentId);
      this.requestIdsBySegmentId.delete(segmentId);

      if (this.translatedSegmentIds.has(segmentId)) {
        continue;
      }

      this.failureCounts.set(segmentId, this.failureCount(segmentId) + 1);
    }
  }

  clearInFlight(): void {
    this.pendingSegmentIds.clear();
    this.inFlightSegmentIds.clear();
    this.requestIdsBySegmentId.clear();
  }

  hasPending(): boolean {
    return this.pendingSegmentIds.size > 0;
  }

  inFlightRequestId(segmentId: string): string | undefined {
    return this.requestIdsBySegmentId.get(segmentId);
  }

  private pendingSegments(): SubtitleSegment[] {
    return this.timeline.filter((segment) =>
      this.pendingSegmentIds.has(segment.segmentId),
    );
  }

  private isEligible(segmentId: string): boolean {
    return (
      !this.pendingSegmentIds.has(segmentId) &&
      !this.inFlightSegmentIds.has(segmentId) &&
      !this.translatedSegmentIds.has(segmentId) &&
      !this.isRetryExhausted(segmentId)
    );
  }

  private isRetryExhausted(segmentId: string): boolean {
    return this.failureCount(segmentId) > this.options.maxRetryCount;
  }

  private isCurrentRequest(segmentId: string, requestId: string): boolean {
    return this.requestIdsBySegmentId.get(segmentId) === requestId;
  }

  private failureCount(segmentId: string): number {
    return this.failureCounts.get(segmentId) ?? 0;
  }
}

function intersectsWindow(
  segment: SubtitleSegment,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  return segment.startMs <= windowEndMs && segment.endMs >= windowStartMs;
}

function assertNonNegativeOption(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be greater than or equal to 0.`);
  }
}

function assertPositiveOption(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than 0.`);
  }
}
