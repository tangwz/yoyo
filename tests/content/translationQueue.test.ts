import { describe, expect, it } from "vitest";
import {
  defaultTranslationQueueOptions,
  TranslationQueue,
} from "@/content/translationQueue";
import type { PageSegment } from "@/translation/types";

function segment(
  id: string,
  order: number,
  sourceText: string,
  priority: PageSegment["priority"] = "normal",
): PageSegment {
  return {
    id,
    order,
    sourceText,
    kind: "paragraph",
    priority,
    pathHint: `body.${id}`,
    textHash: `hash-${id}`,
  };
}

describe("TranslationQueue", () => {
  it("flushes viewport and near-viewport segments first with first-batch limits", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 2,
      firstBatchMaxChars: 100,
      regularBatchMaxSegments: 10,
      regularBatchMaxChars: 100,
    });

    queue.enqueue(segment("normal", 1, "Normal.", "normal"));
    queue.enqueue(segment("near", 2, "Near.", "nearViewport"));
    queue.enqueue(segment("viewport", 3, "Viewport.", "viewport"));

    expect(queue.nextDelayMs()).toBe(
      defaultTranslationQueueOptions.firstFlushDelayMs,
    );
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual([
      "viewport",
      "near",
    ]);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["normal"]);
  });

  it("uses regular limits and delay after the first non-empty batch", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 1,
      regularBatchMaxSegments: 3,
      firstBatchMaxChars: 100,
      regularBatchMaxChars: 100,
    });

    expect(queue.takeNextBatch()).toEqual([]);
    expect(queue.nextDelayMs()).toBe(
      defaultTranslationQueueOptions.firstFlushDelayMs,
    );

    queue.enqueue([
      segment("one", 1, "One.", "viewport"),
      segment("two", 2, "Two.", "viewport"),
      segment("three", 3, "Three.", "viewport"),
      segment("four", 4, "Four.", "viewport"),
    ]);

    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["one"]);
    expect(queue.nextDelayMs()).toBe(
      defaultTranslationQueueOptions.regularFlushDelayMs,
    );
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("respects character budgets without dropping an oversized first segment", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 5,
      regularBatchMaxSegments: 5,
      firstBatchMaxChars: 10,
      regularBatchMaxChars: 10,
    });

    queue.enqueue([
      segment("large", 1, "123456789012345", "viewport"),
      segment("small", 2, "12", "viewport"),
    ]);

    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["large"]);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["small"]);
  });

  it("suppresses duplicate pending, translating, and translated segment ids", () => {
    const queue = new TranslationQueue(defaultTranslationQueueOptions);
    const item = segment("one", 1, "One.", "viewport");

    queue.enqueue(item);
    queue.enqueue(item);
    expect(queue.size()).toBe(1);

    const batch = queue.takeNextBatch();
    queue.markTranslating(batch.map((entry) => entry.id));
    queue.enqueue(item);
    expect(queue.size()).toBe(0);

    queue.markTranslated(["one"]);
    queue.enqueue(item);
    expect(queue.size()).toBe(0);
  });

  it("allows failed segments to be retried explicitly", () => {
    const queue = new TranslationQueue(defaultTranslationQueueOptions);
    const item = segment("one", 1, "One.", "viewport");

    queue.enqueue(item);
    const batch = queue.takeNextBatch();
    queue.markTranslating(batch.map((entry) => entry.id));
    queue.markFailed(["one"]);
    queue.retryFailed(["one"], [item]);

    expect(queue.takeNextBatch().map((entry) => entry.id)).toEqual(["one"]);
  });
});
