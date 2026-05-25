import type { SubtitleCue } from "@/subtitle/types";

type YouTubeJson3Segment = {
  utf8?: string;
};

type YouTubeJson3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: YouTubeJson3Segment[];
};

type YouTubeJson3Payload = {
  events?: YouTubeJson3Event[];
};

function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseYouTubeJson3Cues(
  payload: YouTubeJson3Payload,
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  for (const event of payload.events ?? []) {
    const startMs = event.tStartMs ?? 0;
    const durationMs = event.dDurationMs ?? 0;
    const endMs = startMs + durationMs;
    const text = cleanCueText(
      (event.segs ?? []).map((segment) => segment.utf8 ?? "").join(""),
    );

    if (!text || durationMs <= 0 || endMs <= startMs) {
      continue;
    }

    cues.push({
      cueId: `cue-${cues.length}`,
      index: cues.length,
      startMs,
      endMs,
      text,
    });
  }

  return cues;
}
