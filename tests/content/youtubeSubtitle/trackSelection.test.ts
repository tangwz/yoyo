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
