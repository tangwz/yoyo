import type { PageSegment } from "@/translation/types";

export type TranslationQueueOptions = {
  firstFlushDelayMs: number;
  regularFlushDelayMs: number;
  firstBatchMaxSegments: number;
  regularBatchMaxSegments: number;
  firstBatchMaxChars: number;
  regularBatchMaxChars: number;
};

type QueueState = "pending" | "translating" | "translated" | "failed";

type QueueEntry = {
  segment: PageSegment;
  state: QueueState;
};

export const defaultTranslationQueueOptions: TranslationQueueOptions = {
  firstFlushDelayMs: 0,
  regularFlushDelayMs: 150,
  firstBatchMaxSegments: 4,
  regularBatchMaxSegments: 10,
  firstBatchMaxChars: 1600,
  regularBatchMaxChars: 4200,
};

const priorityRank: Record<PageSegment["priority"], number> = {
  viewport: 0,
  nearViewport: 1,
  normal: 2,
};

export class TranslationQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private firstBatchDispatched = false;

  constructor(private readonly options: TranslationQueueOptions) {
    assertPositiveOption(options.firstBatchMaxSegments, "firstBatchMaxSegments");
    assertPositiveOption(
      options.regularBatchMaxSegments,
      "regularBatchMaxSegments",
    );
    assertPositiveOption(options.firstBatchMaxChars, "firstBatchMaxChars");
    assertPositiveOption(options.regularBatchMaxChars, "regularBatchMaxChars");
  }

  enqueue(input: PageSegment | readonly PageSegment[]): void {
    const segments = Array.isArray(input) ? input : [input];

    for (const segment of segments) {
      if (this.entries.has(segment.id)) {
        continue;
      }

      this.entries.set(segment.id, { segment, state: "pending" });
    }
  }

  retryFailed(
    segmentIds: readonly string[],
    segments: readonly PageSegment[],
  ): void {
    const segmentsById = new Map(
      segments.map((segment) => [segment.id, segment]),
    );

    for (const segmentId of segmentIds) {
      const existing = this.entries.get(segmentId);
      const segment = segmentsById.get(segmentId);
      if (existing?.state !== "failed" || !segment) {
        continue;
      }

      this.entries.set(segmentId, { segment, state: "pending" });
    }
  }

  takeNextBatch(): PageSegment[] {
    const limits = this.currentLimits();
    const batch: PageSegment[] = [];
    let batchChars = 0;

    for (const segment of this.pendingSegments()) {
      const segmentChars = segment.sourceText.length;
      const wouldExceedSegments = batch.length >= limits.maxSegments;
      const wouldExceedChars =
        batch.length > 0 && batchChars + segmentChars > limits.maxChars;

      if (wouldExceedSegments || wouldExceedChars) {
        break;
      }

      batch.push(segment);
      batchChars += segmentChars;
    }

    if (batch.length > 0) {
      this.firstBatchDispatched = true;
      this.markTranslating(batch.map((segment) => segment.id));
    }

    return batch;
  }

  nextDelayMs(): number {
    return this.firstBatchDispatched
      ? this.options.regularFlushDelayMs
      : this.options.firstFlushDelayMs;
  }

  markTranslating(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry?.state === "pending") {
        entry.state = "translating";
      }
    }
  }

  markTranslated(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry) {
        entry.state = "translated";
      }
    }
  }

  markFailed(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry) {
        entry.state = "failed";
      }
    }
  }

  size(): number {
    return this.pendingSegments().length;
  }

  hasPending(): boolean {
    return this.size() > 0;
  }

  clear(): void {
    this.entries.clear();
    this.firstBatchDispatched = false;
  }

  private currentLimits(): { maxSegments: number; maxChars: number } {
    if (this.firstBatchDispatched) {
      return {
        maxSegments: this.options.regularBatchMaxSegments,
        maxChars: this.options.regularBatchMaxChars,
      };
    }

    return {
      maxSegments: this.options.firstBatchMaxSegments,
      maxChars: this.options.firstBatchMaxChars,
    };
  }

  private pendingSegments(): PageSegment[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === "pending")
      .map((entry) => entry.segment)
      .sort(
        (left, right) =>
          priorityRank[left.priority] - priorityRank[right.priority] ||
          left.order - right.order,
      );
  }
}

function assertPositiveOption(value: number, name: string): void {
  if (value <= 0) {
    throw new Error(`${name} must be greater than 0.`);
  }
}
