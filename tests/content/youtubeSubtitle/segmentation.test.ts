import { describe, expect, it } from "vitest";
import {
  segmentSubtitleCues,
  validateSubtitleSegments,
} from "@/content/youtubeSubtitle/segmentation";
import { hashSubtitleText } from "@/subtitle/hash";
import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

function cue(
  index: number,
  startMs: number,
  endMs: number,
  text: string,
): SubtitleCue {
  return {
    cueId: `cue-${index}`,
    index,
    startMs,
    endMs,
    text,
  };
}

function segment(
  startIndex: number,
  endIndex: number,
  cues: readonly SubtitleCue[],
): SubtitleSegment {
  const covered = cues.slice(startIndex, endIndex + 1);
  const first = covered[0]!;
  const last = covered.at(-1)!;
  return {
    segmentId: `seg-${startIndex}-${endIndex}`,
    sourceCueIds: covered.map((sourceCue) => sourceCue.cueId),
    sourceCueStartIndex: startIndex,
    sourceCueEndIndex: endIndex,
    startMs: first.startMs,
    endMs: last.endMs,
    sourceText: covered.map((sourceCue) => sourceCue.text).join(" "),
    textHash: "hash",
  };
}

function splitSegment(
  cue: SubtitleCue,
  startMs: number,
  endMs: number,
  sourceText: string,
): SubtitleSegment {
  const textHash = hashSubtitleText(sourceText);
  return {
    segmentId: `seg-${cue.index}-${startMs}-${endMs}-${textHash}`,
    sourceCueIds: [cue.cueId],
    sourceCueStartIndex: cue.index,
    sourceCueEndIndex: cue.index,
    startMs,
    endMs,
    sourceText,
    textHash,
  };
}

describe("segmentSubtitleCues", () => {
  it("merges short English cues forward until punctuation", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 700, "Hello"),
        cue(1, 700, 1400, "world."),
        cue(2, 1600, 2500, "Next sentence."),
      ],
      { sourceLanguage: { kind: "known", code: "en" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Hello world.",
      "Next sentence.",
    ]);
    expect(segments[0]?.sourceCueIds).toEqual(["cue-0", "cue-1"]);
  });

  it("uses character strategy for CJK cues", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 1000, "你好"),
        cue(1, 1000, 2000, "世界。"),
        cue(2, 2300, 3200, "下一句。"),
      ],
      { sourceLanguage: { kind: "known", code: "zh-CN" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "你好世界。",
      "下一句。",
    ]);
  });

  it("uses word strategy for non-CJK cues", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "Hello"), cue(1, 1000, 2000, "world")],
      { sourceLanguage: { kind: "known", code: "en" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Hello world",
    ]);
  });

  it("uses word strategy when Latin text is dominant in mixed cues", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 1000, "Hello world"),
        cue(1, 1000, 2000, "你好"),
      ],
      { sourceLanguage: { kind: "unknown" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Hello world 你好",
    ]);
  });

  it("uses character strategy when CJK text is dominant in mixed cues", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 1000, "你好世界朋友"),
        cue(1, 1000, 2000, "hi"),
      ],
      { sourceLanguage: { kind: "unknown" }, maxChars: 5 },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "你好世",
      "界朋友",
      "hi",
    ]);
    expect(segments.every((segment) => Array.from(segment.sourceText).length <= 5)).toBe(
      true,
    );
  });

  it("uses character strategy for unknown no-space non-Latin text", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "กขคงจฉ")],
      { sourceLanguage: { kind: "unknown" }, maxChars: 2 },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "กข",
      "คง",
      "จฉ",
    ]);
  });

  it("uses character strategy for dominant no-space non-Latin mixed text", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "กขคงจฉhi")],
      { sourceLanguage: { kind: "unknown" }, maxChars: 3 },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "กขค",
      "งจฉ",
      "hi",
    ]);
  });

  it("uses word strategy for known space-separated non-Latin text", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "Привет"), cue(1, 1000, 2000, "мир.")],
      { sourceLanguage: { kind: "known", code: "ru" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Привет мир.",
    ]);
  });

  it("uses word strategy for unknown non-Latin text with spaces", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "Привет мир один два")],
      { sourceLanguage: { kind: "unknown" }, maxWords: 2 },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Привет мир",
      "один два",
    ]);
  });

  it("splits at long pauses", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 1000, "Hello"), cue(1, 2500, 3500, "world")],
      { sourceLanguage: { kind: "known", code: "en" }, longPauseMs: 1200 },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Hello",
      "world",
    ]);
  });

  it("splits before exceeding max duration across cues", () => {
    const segments = segmentSubtitleCues(
      [cue(0, 0, 2000, "Hello"), cue(1, 2000, 4500, "world")],
      { sourceLanguage: { kind: "known", code: "en" }, maxDurationMs: 3000 },
    );

    expect(segments.map((segment) => segment.sourceCueIds)).toEqual([
      ["cue-0"],
      ["cue-1"],
    ]);
  });

  it("splits oversized single English cues by max words", () => {
    const cues = [cue(0, 0, 4000, "one two three four five")];
    const segments = segmentSubtitleCues(cues, {
      sourceLanguage: { kind: "known", code: "en" },
      maxWords: 2,
    });

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "one two",
      "three four",
      "five",
    ]);
    expect(
      segments.every(
        (segment) => segment.sourceText.split(/\s+/).filter(Boolean).length <= 2,
      ),
    ).toBe(true);
    expect(segments.every((segment) => segment.sourceCueIds[0] === "cue-0")).toBe(
      true,
    );
    expect(validateSubtitleSegments(cues, segments).valid).toBe(true);
  });

  it("splits oversized single CJK cues by max chars", () => {
    const cues = [cue(0, 0, 4000, "你好世界朋友")];
    const segments = segmentSubtitleCues(cues, {
      sourceLanguage: { kind: "known", code: "zh-CN" },
      maxChars: 2,
    });

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "你好",
      "世界",
      "朋友",
    ]);
    expect(segments.every((segment) => segment.sourceText.length <= 2)).toBe(
      true,
    );
    expect(validateSubtitleSegments(cues, segments).valid).toBe(true);
  });

  it("splits oversized single cues by max duration", () => {
    const cues = [cue(0, 0, 6000, "one two three four five six")];
    const segments = segmentSubtitleCues(cues, {
      sourceLanguage: { kind: "known", code: "en" },
      maxDurationMs: 2000,
      maxWords: 10,
    });

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "one two",
      "three four",
      "five six",
    ]);
    expect(segments.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 6000],
    ]);
    expect(
      segments.every((segment) => segment.endMs - segment.startMs <= 2000),
    ).toBe(true);
    expect(validateSubtitleSegments(cues, segments).valid).toBe(true);
  });

  it("builds stable hash-based segment ids", () => {
    const cues = [cue(0, 0, 1000, "Hello world.")];
    const first = segmentSubtitleCues(cues, {
      sourceLanguage: { kind: "known", code: "en" },
    });
    const second = segmentSubtitleCues(cues, {
      sourceLanguage: { kind: "known", code: "en" },
    });
    const expectedHash = hashSubtitleText("cue-0|0|1000|Hello world.");

    expect(first[0]?.segmentId).toBe(
      `sub-0-0-${expectedHash}`,
    );
    expect(first[0]?.segmentId).toBe(second[0]?.segmentId);
  });

  it("changes segment ids when source cue ids or timing changes", () => {
    const first = segmentSubtitleCues([cue(0, 0, 1000, "Hello world.")], {
      sourceLanguage: { kind: "known", code: "en" },
    });
    const differentCueId = segmentSubtitleCues(
      [{ ...cue(0, 0, 1000, "Hello world."), cueId: "cue-external" }],
      { sourceLanguage: { kind: "known", code: "en" } },
    );
    const differentTiming = segmentSubtitleCues(
      [cue(0, 100, 1100, "Hello world.")],
      { sourceLanguage: { kind: "known", code: "en" } },
    );

    expect(first[0]?.segmentId).not.toBe(differentCueId[0]?.segmentId);
    expect(first[0]?.segmentId).not.toBe(differentTiming[0]?.segmentId);
  });

  it("rejects non-contiguous segment coverage", () => {
    const cues = [cue(0, 0, 1000, "One."), cue(1, 1000, 2000, "Two.")];
    const result = validateSubtitleSegments(cues, [
      {
        segmentId: "seg-1",
        sourceCueIds: ["cue-0"],
        sourceCueStartIndex: 0,
        sourceCueEndIndex: 1,
        startMs: 0,
        endMs: 2000,
        sourceText: "One. Two.",
        textHash: "hash",
      },
    ]);

    expect(result.valid).toBe(false);
  });

  it("rejects non-empty cues with empty segments", () => {
    const cues = [cue(0, 0, 1000, "One.")];

    expect(validateSubtitleSegments(cues, []).valid).toBe(false);
  });

  it("rejects segments missing a cue", () => {
    const cues = [
      cue(0, 0, 1000, "One."),
      cue(1, 1000, 2000, "Two."),
    ];

    expect(validateSubtitleSegments(cues, [segment(0, 0, cues)]).valid).toBe(
      false,
    );
  });

  it("rejects overlapping or out-of-order ranges", () => {
    const cues = [
      cue(0, 0, 1000, "One."),
      cue(1, 1000, 2000, "Two."),
    ];

    expect(
      validateSubtitleSegments(cues, [
        segment(0, 1, cues),
        segment(1, 1, cues),
      ]).valid,
    ).toBe(false);
    expect(
      validateSubtitleSegments(cues, [
        segment(1, 1, cues),
        segment(0, 0, cues),
      ]).valid,
    ).toBe(false);
  });

  it("accepts complete contiguous segmentation", () => {
    const cues = [
      cue(0, 0, 1000, "One."),
      cue(1, 1000, 2000, "Two."),
      cue(2, 2000, 3000, "Three."),
    ];

    expect(
      validateSubtitleSegments(cues, [
        segment(0, 1, cues),
        segment(2, 2, cues),
      ]).valid,
    ).toBe(true);
  });

  it("accepts complete segmentation for cue chunks with non-zero source indexes", () => {
    const cues = [
      cue(30, 30000, 31000, "Thirty."),
      cue(31, 31000, 32000, "Thirty one."),
    ];

    expect(
      validateSubtitleSegments(cues, [
        {
          segmentId: "seg-30-31",
          sourceCueIds: ["cue-30", "cue-31"],
          sourceCueStartIndex: 30,
          sourceCueEndIndex: 31,
          startMs: 30000,
          endMs: 32000,
          sourceText: "Thirty. Thirty one.",
          textHash: "hash",
        },
      ]).valid,
    ).toBe(true);
  });

  it("rejects segments that exceed validation bounds", () => {
    const cues = [cue(0, 0, 3000, "one two three")];

    expect(
      validateSubtitleSegments(cues, [segment(0, 0, cues)], {
        maxDurationMs: 2000,
        maxWords: 2,
        characterStrategy: false,
      }).valid,
    ).toBe(false);
  });

  it("rejects empty cues with empty segments", () => {
    expect(validateSubtitleSegments([], []).valid).toBe(false);
  });

  it("accepts split subranges for the same cue", () => {
    const cues = [cue(0, 0, 4000, "one two three four")];

    expect(
      validateSubtitleSegments(cues, [
        splitSegment(cues[0]!, 0, 2000, "one two"),
        splitSegment(cues[0]!, 2000, 4000, "three four"),
      ]).valid,
    ).toBe(true);
  });

  it("rejects overlapping split subranges for the same cue", () => {
    const cues = [cue(0, 0, 4000, "one two three four")];

    expect(
      validateSubtitleSegments(cues, [
        splitSegment(cues[0]!, 0, 2500, "one two"),
        splitSegment(cues[0]!, 2000, 4000, "three four"),
      ]).valid,
    ).toBe(false);
  });

  it("rejects segment timing that is not derived from source cue boundaries", () => {
    const cues = [cue(0, 0, 1000, "One."), cue(1, 1000, 2000, "Two.")];
    const invalidTiming = {
      ...segment(0, 1, cues),
      endMs: 1900,
    };

    expect(validateSubtitleSegments(cues, [invalidTiming]).valid).toBe(false);
  });
});
