import { hashSubtitleText } from "@/subtitle/hash";

export type YouTubeCaptionTrack = {
  languageCode?: string;
  kind?: string;
  name?: string;
  baseUrl?: string;
  vssId?: string;
};

type TrackPreference = {
  languageCode?: string;
  kind?: string | null;
  vssId?: string;
};

function isChatTrack(track: YouTubeCaptionTrack): boolean {
  return /chat/i.test(`${track.name ?? ""} ${track.kind ?? ""}`);
}

function normalizeTrackUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

export function buildTrackKey(
  videoId: string,
  track: YouTubeCaptionTrack,
): string {
  const trackIdentity =
    track.vssId ??
    (track.baseUrl ? hashSubtitleText(normalizeTrackUrl(track.baseUrl)) : "");
  return [
    videoId,
    track.languageCode ?? "unknown",
    track.kind ?? "manual",
    track.name ?? "",
    trackIdentity,
  ].join("|");
}

export function selectCaptionTrack(
  tracks: readonly YouTubeCaptionTrack[],
  preference: TrackPreference = {},
): YouTubeCaptionTrack | undefined {
  const usableTracks = tracks.filter((track) => !isChatTrack(track));
  const sameVssIdTrack = usableTracks.find(
    (track) => preference.vssId && track.vssId === preference.vssId,
  );
  const sameLanguageTracks = usableTracks.filter(
    (track) => track.languageCode === preference.languageCode,
  );
  const preferredKind = preference.kind ?? null;
  return (
    sameVssIdTrack ??
    usableTracks.find(
      (track) =>
        track.languageCode === preference.languageCode &&
        (track.kind ?? null) === preferredKind,
    ) ??
    sameLanguageTracks.find((track) => track.kind !== "asr") ??
    sameLanguageTracks.find((track) => track.kind === "asr") ??
    usableTracks[0]
  );
}
