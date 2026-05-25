export type YouTubeCaptionTrack = {
  languageCode?: string;
  kind?: string;
  name?: string;
  baseUrl?: string;
};

type TrackPreference = {
  languageCode?: string;
  kind?: string | null;
};

function isChatTrack(track: YouTubeCaptionTrack): boolean {
  return /chat/i.test(track.name ?? "");
}

export function buildTrackKey(
  videoId: string,
  track: YouTubeCaptionTrack,
): string {
  return [
    videoId,
    track.languageCode ?? "unknown",
    track.kind ?? "manual",
    track.name ?? "",
  ].join("|");
}

export function selectCaptionTrack(
  tracks: readonly YouTubeCaptionTrack[],
  preference: TrackPreference = {},
): YouTubeCaptionTrack | undefined {
  const usableTracks = tracks.filter((track) => !isChatTrack(track));
  const sameLanguageTracks = usableTracks.filter(
    (track) => track.languageCode === preference.languageCode,
  );
  const preferredKind = preference.kind ?? null;
  return (
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
