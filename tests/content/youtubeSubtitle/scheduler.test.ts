import { describe, expect, it } from "vitest";
import {
  defaultSubtitleSchedulerOptions,
  SubtitleScheduler,
} from "@/content/youtubeSubtitle/scheduler";
import type { SubtitleSegment } from "@/subtitle/types";

function segment(
  segmentId: string,
  startMs: number,
  endMs: number,
  sourceText = segmentId,
): SubtitleSegment {
  return {
    segmentId,
    sourceCueIds: [`cue-${segmentId}`],
    sourceCueStartIndex: startMs,
    sourceCueEndIndex: endMs,
    startMs,
    endMs,
    sourceText,
    textHash: `hash-${segmentId}`,
  };
}

function scheduler(
  options: Partial<ConstructorParameters<typeof SubtitleScheduler>[0]> = {},
): SubtitleScheduler {
  return new SubtitleScheduler({
    ...defaultSubtitleSchedulerOptions,
    prefetchBeforeMs: 1000,
    prefetchAfterMs: 2000,
    maxRetryCount: 1,
    maxBatchSegments: 10,
    maxBatchChars: 100,
    ...options,
  });
}

describe("SubtitleScheduler", () => {
  it("enqueues segments that intersect the prefetch window in timeline order", () => {
    const queue = scheduler();
    queue.replaceTimeline([
      segment("before", 0, 999),
      segment("left-edge", 1000, 1500),
      segment("inside", 2500, 2600),
      segment("right-edge", 3990, 4000),
      segment("after", 4001, 5000),
    ]);

    queue.scanWindow(2000);

    expect(queue.takeBatch("request-1").map((entry) => entry.segmentId)).toEqual([
      "left-edge",
      "inside",
      "right-edge",
    ]);
  });

  it("respects segment count and character budgets while keeping oversized singles", () => {
    const byCount = scheduler({ maxBatchSegments: 2, maxBatchChars: 100 });
    byCount.replaceTimeline([
      segment("one", 0, 100, "1111"),
      segment("two", 100, 200, "2222"),
      segment("three", 200, 300, "3333"),
    ]);
    byCount.scanWindow(100);

    expect(byCount.takeBatch("count-1").map((entry) => entry.segmentId)).toEqual([
      "one",
      "two",
    ]);
    expect(byCount.takeBatch("count-2").map((entry) => entry.segmentId)).toEqual([
      "three",
    ]);

    const byChars = scheduler({ maxBatchSegments: 10, maxBatchChars: 5 });
    byChars.replaceTimeline([
      segment("large", 0, 100, "123456789"),
      segment("small", 100, 200, "12"),
      segment("next", 200, 300, "34"),
    ]);
    byChars.scanWindow(100);

    expect(byChars.takeBatch("chars-1").map((entry) => entry.segmentId)).toEqual([
      "large",
    ]);
    expect(byChars.takeBatch("chars-2").map((entry) => entry.segmentId)).toEqual([
      "small",
      "next",
    ]);
  });

  it("does not requeue translated or in-flight segments", () => {
    const queue = scheduler();
    queue.replaceTimeline([
      segment("one", 0, 100),
      segment("two", 100, 200),
      segment("three", 200, 300),
    ]);
    queue.scanWindow(100);

    const first = queue.takeBatch("request-1");
    queue.markTranslated(["one"]);
    queue.scanWindow(100);

    expect(first.map((entry) => entry.segmentId)).toEqual(["one", "two", "three"]);
    expect(queue.takeBatch("request-2")).toEqual([]);
  });

  it("allows retries until maxRetryCount is exceeded", () => {
    const queue = scheduler({ maxRetryCount: 1 });
    queue.replaceTimeline([segment("retry", 0, 100)]);

    queue.scanWindow(0);
    expect(queue.takeBatch("request-1").map((entry) => entry.segmentId)).toEqual([
      "retry",
    ]);

    queue.markFailed(["retry"]);
    queue.scanWindow(0);
    expect(queue.takeBatch("request-2").map((entry) => entry.segmentId)).toEqual([
      "retry",
    ]);

    queue.markFailed(["retry"]);
    queue.scanWindow(0);
    expect(queue.takeBatch("request-3")).toEqual([]);
  });

  it("makes in-flight entries eligible again after clearInFlight", () => {
    const queue = scheduler();
    queue.replaceTimeline([segment("one", 0, 100), segment("two", 100, 200)]);
    queue.scanWindow(0);

    expect(queue.takeBatch("request-1").map((entry) => entry.segmentId)).toEqual([
      "one",
      "two",
    ]);

    queue.clearInFlight();
    queue.scanWindow(0);

    expect(queue.takeBatch("request-2").map((entry) => entry.segmentId)).toEqual([
      "one",
      "two",
    ]);
  });

  it("replaceTimeline clears old pending, in-flight, translated, and retry state", () => {
    const queue = scheduler({ maxRetryCount: 0 });
    queue.replaceTimeline([segment("old", 0, 100), segment("failed", 100, 200)]);
    queue.scanWindow(0);
    queue.takeBatch("request-1");
    queue.markTranslated(["old"]);
    queue.markFailed(["failed"]);

    queue.replaceTimeline([segment("old", 0, 100), segment("new", 100, 200)]);
    queue.scanWindow(0);

    expect(queue.takeBatch("request-2").map((entry) => entry.segmentId)).toEqual([
      "old",
      "new",
    ]);
  });
});
