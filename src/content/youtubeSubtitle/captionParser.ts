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

    if (
      !text ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(durationMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      durationMs <= 0 ||
      endMs <= startMs
    ) {
      continue;
    }

    const previous = cues.at(-1);
    if (previous && startMs < previous.endMs) {
      if (startMs <= previous.startMs) {
        continue;
      }
      previous.endMs = startMs;
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
