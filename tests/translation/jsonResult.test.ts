import { describe, expect, it } from "vitest";
import { parseTranslationBatchResult } from "@/translation/jsonResult";

describe("translation JSON result parser", () => {
  it("parses valid items and ignores unknown segment IDs with warnings", () => {
    const result = parseTranslationBatchResult(
      JSON.stringify({
        items: [
          { segmentId: "a", translatedText: "Alpha" },
          { segmentId: "unknown", translatedText: "Ignored" },
          { segmentId: "b", translatedText: "Beta" },
        ],
      }),
      ["a", "b"],
    );

    expect(result.items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
      { segmentId: "b", translatedText: "Beta" },
    ]);
    expect(result.missingSegmentIds).toEqual([]);
    expect(result.warnings).toEqual([
      'Ignoring unknown segmentId "unknown".',
    ]);
  });

  it("extracts a JSON object from surrounding text and reports missing expected IDs", () => {
    const result = parseTranslationBatchResult(
      'Here is the result:\n{"items":[{"segmentId":"a","translatedText":"Alpha"}]}\nDone.',
      ["a", "b"],
    );

    expect(result.items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
    ]);
    expect(result.missingSegmentIds).toEqual(["b"]);
    expect(result.warnings).toEqual([]);
  });

  it("continues scanning after an invalid balanced object", () => {
    const result = parseTranslationBatchResult(
      'Note: {not json}\n{"items":[{"segmentId":"a","translatedText":"Alpha"}]}',
      ["a"],
    );

    expect(result.items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
    ]);
    expect(result.missingSegmentIds).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("ignores invalid items and duplicate segment IDs with warnings", () => {
    const result = parseTranslationBatchResult(
      JSON.stringify({
        items: [
          { segmentId: "a", translatedText: "Alpha" },
          { segmentId: "a", translatedText: "Duplicate" },
          { segmentId: "b", translatedText: 123 },
          null,
        ],
      }),
      ["a", "b"],
    );

    expect(result.items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
    ]);
    expect(result.missingSegmentIds).toEqual(["b"]);
    expect(result.warnings).toEqual([
      'Ignoring duplicate segmentId "a".',
      "Ignoring invalid item at index 2.",
      "Ignoring invalid item at index 3.",
    ]);
  });

  it("throws a clear error for invalid top-level shape", () => {
    expect(() => parseTranslationBatchResult('{"items":{}}', ["a"])).toThrow(
      'Translation result must be a JSON object with an "items" array.',
    );
  });

  it("throws a clear error when no JSON object can be found", () => {
    expect(() => parseTranslationBatchResult("No structured data", ["a"])).toThrow(
      "Translation result does not contain a JSON object.",
    );
  });
});
