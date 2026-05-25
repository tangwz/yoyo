import { describe, expect, it } from "vitest";
import { parseYouTubeJson3Cues } from "@/content/youtubeSubtitle/captionParser";

describe("parseYouTubeJson3Cues", () => {
  it("normalizes json3 events into valid cues", () => {
    const cues = parseYouTubeJson3Cues({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [{ utf8: " Hello " }, { utf8: "<b>world</b>" }],
        },
        {
          tStartMs: 3500,
          dDurationMs: 500,
          segs: [{ utf8: "\n" }],
        },
        {
          tStartMs: 4500,
          dDurationMs: 1500,
          segs: [{ utf8: "Next line" }],
        },
      ],
    });

    expect(cues).toEqual([
      {
        cueId: "cue-0",
        index: 0,
        startMs: 1000,
        endMs: 3000,
        text: "Hello world",
      },
      {
        cueId: "cue-1",
        index: 1,
        startMs: 4500,
        endMs: 6000,
        text: "Next line",
      },
    ]);
  });

  it("drops cues with empty text or invalid timing", () => {
    expect(
      parseYouTubeJson3Cues({
        events: [
          { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: "No duration" }] },
          {
            tStartMs: -100,
            dDurationMs: 500,
            segs: [{ utf8: "Negative start" }],
          },
          {
            tStartMs: Number.POSITIVE_INFINITY,
            dDurationMs: 500,
            segs: [{ utf8: "Infinite start" }],
          },
          {
            tStartMs: 1000,
            dDurationMs: Number.NaN,
            segs: [{ utf8: "NaN duration" }],
          },
          { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "   " }] },
        ],
      }),
    ).toEqual([]);
  });

  it("clamps the previous cue when the next accepted cue overlaps", () => {
    const cues = parseYouTubeJson3Cues({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [{ utf8: "First" }],
        },
        {
          tStartMs: 2500,
          dDurationMs: 1000,
          segs: [{ utf8: "Second" }],
        },
      ],
    });

    expect(cues).toEqual([
      {
        cueId: "cue-0",
        index: 0,
        startMs: 1000,
        endMs: 2500,
        text: "First",
      },
      {
        cueId: "cue-1",
        index: 1,
        startMs: 2500,
        endMs: 3500,
        text: "Second",
      },
    ]);
  });

  it("drops non-monotonic cues that cannot repair the previous cue", () => {
    const cues = parseYouTubeJson3Cues({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 1000,
          segs: [{ utf8: "First" }],
        },
        {
          tStartMs: 900,
          dDurationMs: 500,
          segs: [{ utf8: "Backwards" }],
        },
        {
          tStartMs: 2200,
          dDurationMs: 500,
          segs: [{ utf8: "Third" }],
        },
      ],
    });

    expect(cues.map((cue) => cue.text)).toEqual(["First", "Third"]);
    expect(cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([
      [1000, 2000],
      [2200, 2700],
    ]);
  });
});
