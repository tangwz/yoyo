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
    ).toBe("English ASR");
    expect(
      selectCaptionTrack(
        tracks.filter((track) => track.name !== "French manual"),
        { languageCode: "it", kind: "asr" },
      )?.name,
    ).toBe("English ASR");
    expect(
      selectCaptionTrack(
        tracks.filter((track) => !track.name?.includes("manual")),
        { languageCode: "it", kind: null },
      )?.name,
    ).toBe("English ASR");
  });

  it("prefers same-language manual tracks before ASR regardless of source order", () => {
    const track = selectCaptionTrack(
      [
        { languageCode: "en", kind: "asr", name: "English ASR" },
        { languageCode: "en", name: "English manual" },
      ],
      { languageCode: "en" },
    );

    expect(track?.name).toBe("English manual");
  });

  it("falls back to the first usable track when no same-language track exists", () => {
    const track = selectCaptionTrack(
      [
        { languageCode: "en", kind: "asr", name: "English ASR" },
        { languageCode: "fr", name: "French manual" },
      ],
      { languageCode: "de" },
    );

    expect(track?.name).toBe("English ASR");
  });

  it("filters live chat tracks by kind as well as name", () => {
    const track = selectCaptionTrack(
      [
        { languageCode: "en", kind: "live_chat", name: "English" },
        { languageCode: "fr", name: "French manual" },
      ],
      { languageCode: "de" },
    );

    expect(track?.name).toBe("French manual");
  });

  it("builds stable track keys", () => {
    expect(
      buildTrackKey("video-1", {
        languageCode: "en",
        kind: "asr",
        name: "English",
      }),
    ).toBe("video-1|en|asr|English|");
  });

  it("keeps same-name tracks distinct by stable track identity", () => {
    const first = buildTrackKey("video-1", {
      languageCode: "en",
      kind: "asr",
      name: "English",
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&fmt=json3",
    });
    const second = buildTrackKey("video-1", {
      languageCode: "en",
      kind: "asr",
      name: "English",
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&fmt=vtt",
    });

    expect(first).not.toBe(second);
  });

  it("prefers vssId over URL identity for track keys", () => {
    expect(
      buildTrackKey("video-1", {
        languageCode: "en",
        kind: "asr",
        name: "English",
        baseUrl: "https://example.com/one",
        vssId: "a.en",
      }),
    ).toBe("video-1|en|asr|English|a.en");
  });
});
