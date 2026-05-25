import { describe, expect, it } from "vitest";
import {
  segmentSubtitleCues,
  validateSubtitleSegments,
} from "@/content/youtubeSubtitle/segmentation";
import type { SubtitleCue } from "@/subtitle/types";

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
) {
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
});
