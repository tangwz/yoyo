import { describe, expect, it } from "vitest";
import {
  createStreamingTranslationResultParser,
  parseTranslationBatchResult,
} from "@/translation/jsonResult";

describe("translation JSON result parser", () => {
  it("parses compact v2 items and maps them to translation results", () => {
    const result = parseTranslationBatchResult(
      JSON.stringify({
        items: [
          { id: "a", text: "Alpha" },
          { id: "b", text: "Beta" },
        ],
      }),
      ["a", "b"],
    );

    expect(result.items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
      { segmentId: "b", translatedText: "Beta" },
    ]);
    expect(result.missingSegmentIds).toEqual([]);
  });

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

describe("streaming translation JSONL parser", () => {
  it("parses complete records across chunk boundaries", () => {
    const parser = createStreamingTranslationResultParser(["a", "b"]);

    expect(parser.push('{"id":"a","text":"Al')).toEqual([]);
    expect(parser.push('pha"}\n{"id":"b","text":"Beta"}\n')).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
      { segmentId: "b", translatedText: "Beta" },
    ]);
    expect(parser.finish()).toEqual({
      items: [],
      missingSegmentIds: [],
      warnings: [],
    });
  });

  it("ignores invalid, unknown, and duplicate streaming records while continuing", () => {
    const parser = createStreamingTranslationResultParser(["a", "b"]);

    const items = parser.push(
      [
        '{"id":"unknown","text":"Ignored"}',
        '{"id":"a","text":"Alpha"}',
        '{"id":"a","text":"Duplicate"}',
        '{"id":"b","text":123}',
        "not json",
        '{"id":"b","text":"Beta"}',
      ].join("\n") + "\n",
    );
    const result = parser.finish();

    expect(items).toEqual([
      { segmentId: "a", translatedText: "Alpha" },
      { segmentId: "b", translatedText: "Beta" },
    ]);
    expect(result.missingSegmentIds).toEqual([]);
    expect(result.warnings).toEqual([
      'Ignoring unknown segmentId "unknown".',
      'Ignoring duplicate segmentId "a".',
      "Ignoring invalid item at line 4.",
      "Ignoring invalid JSON at line 5.",
    ]);
  });

  it("recovers after malformed JSONL records", () => {
    const parser = createStreamingTranslationResultParser(["a", "b"]);

    expect(parser.push('{"id":"a","text":"A"}\n{"id":"b","text":\n')).toEqual([
      { segmentId: "a", translatedText: "A" },
    ]);
    expect(parser.push('{"id":"b","text":"B"}\n')).toEqual([
      { segmentId: "b", translatedText: "B" },
    ]);
    expect(parser.finish()).toEqual({
      items: [],
      missingSegmentIds: [],
      warnings: ["Ignoring invalid JSON at line 2."],
    });
  });

  it("does not emit duplicate streaming records", () => {
    const parser = createStreamingTranslationResultParser(["a"]);

    expect(parser.push('{"id":"a","text":"A"}\n')).toEqual([
      { segmentId: "a", translatedText: "A" },
    ]);
    expect(parser.push('{"id":"a","text":"Duplicate"}\n')).toEqual([]);
    expect(parser.finish()).toEqual({
      items: [],
      missingSegmentIds: [],
      warnings: ['Ignoring duplicate segmentId "a".'],
    });
  });
});
