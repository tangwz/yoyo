import { describe, expect, it } from "vitest";
import { splitSegmentsIntoBatches } from "@/translation/batch";
import type { PageSegment } from "@/translation/types";

function segment(
  id: string,
  order: number,
  sourceText: string,
): PageSegment {
  return {
    id,
    order,
    sourceText,
    kind: "paragraph",
    pathHint: `body.${id}`,
    textHash: `hash-${id}`,
    priority: "normal",
  };
}

describe("translation batch helpers", () => {
  it("sorts segments by page order before batching", () => {
    const batches = splitSegmentsIntoBatches(
      [
        segment("third", 3, "C"),
        segment("first", 1, "A"),
        segment("second", 2, "B"),
      ],
      { maxCharsPerBatch: 10, maxSegmentsPerBatch: 10 },
    );

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["first", "second", "third"],
    ]);
  });

  it("sorts viewport and near-viewport segments before normal content", () => {
    const batches = splitSegmentsIntoBatches(
      [
        { ...segment("normal", 1, "A"), priority: "normal" },
        { ...segment("near", 2, "B"), priority: "nearViewport" },
        { ...segment("viewport", 3, "C"), priority: "viewport" },
      ],
      { maxCharsPerBatch: 10, maxSegmentsPerBatch: 10 },
    );

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["viewport", "near", "normal"],
    ]);
  });

  it("respects character and segment budgets without empty batches", () => {
    const batches = splitSegmentsIntoBatches(
      [
        segment("one", 1, "1234"),
        segment("two", 2, "12"),
        segment("three", 3, "12345"),
        segment("four", 4, "1"),
      ],
      { maxCharsPerBatch: 6, maxSegmentsPerBatch: 2 },
    );

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["one", "two"],
      ["three", "four"],
    ]);
  });

  it("emits an oversized segment as its own batch", () => {
    const batches = splitSegmentsIntoBatches(
      [
        segment("small-before", 1, "12"),
        segment("oversized", 2, "1234567"),
        segment("small-after", 3, "34"),
      ],
      { maxCharsPerBatch: 5, maxSegmentsPerBatch: 2 },
    );

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([
      ["small-before"],
      ["oversized"],
      ["small-after"],
    ]);
  });

  it("rejects non-positive character budgets", () => {
    expect(() =>
      splitSegmentsIntoBatches([segment("one", 1, "A")], {
        maxCharsPerBatch: 0,
        maxSegmentsPerBatch: 1,
      }),
    ).toThrow("maxCharsPerBatch must be greater than 0.");
  });

  it("rejects non-positive segment budgets", () => {
    expect(() =>
      splitSegmentsIntoBatches([segment("one", 1, "A")], {
        maxCharsPerBatch: 1,
        maxSegmentsPerBatch: 0,
      }),
    ).toThrow("maxSegmentsPerBatch must be greater than 0.");
  });
});
