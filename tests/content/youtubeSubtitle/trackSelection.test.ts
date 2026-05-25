import { describe, expect, it } from "vitest";
import {
  buildTrackKey,
  selectCaptionTrack,
} from "@/content/youtubeSubtitle/trackSelection";

describe("trackSelection", () => {
  it("prefers non-chat ASR when no exact track exists", () => {
    const track = selectCaptionTrack(
      [
        { languageCode: "en", kind: "asr", name: "English" },
        { languageCode: "en", kind: "asr", name: "Live chat" },
      ],
      { languageCode: "fr" },
    );

    expect(track?.name).toBe("English");
  });

  it("uses fallback order with chat tracks filtered", () => {
    const tracks = [
      { languageCode: "fr", kind: "asr", name: "French chat" },
      { languageCode: "en", kind: "asr", name: "English ASR" },
      { languageCode: "fr", name: "French manual" },
      { languageCode: "es", name: "Spanish manual" },
      { languageCode: "de", kind: "asr", name: "German ASR" },
    ];

    expect(
      selectCaptionTrack(tracks, { languageCode: "fr", kind: null })?.name,
    ).toBe("French manual");
    expect(
      selectCaptionTrack(tracks, { languageCode: "fr", kind: "asr" })?.name,
    ).toBe("French manual");
    expect(
      selectCaptionTrack(tracks, { languageCode: "it", kind: "asr" })?.name,
    ).toBe("French manual");
    expect(
      selectCaptionTrack(
        tracks.filter((track) => track.name !== "French manual"),
        { languageCode: "it", kind: "asr" },
      )?.name,
    ).toBe("Spanish manual");
    expect(
      selectCaptionTrack(
        tracks.filter((track) => !track.name?.includes("manual")),
        { languageCode: "it", kind: null },
      )?.name,
    ).toBe("English ASR");
  });

  it("builds stable track keys", () => {
    expect(
      buildTrackKey("video-1", {
        languageCode: "en",
        kind: "asr",
        name: "English",
      }),
    ).toBe("video-1|en|asr|English");
  });
});
