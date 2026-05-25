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
          { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "   " }] },
        ],
      }),
    ).toEqual([]);
  });
});
