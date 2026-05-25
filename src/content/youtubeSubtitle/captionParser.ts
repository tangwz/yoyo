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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson3Payload(payload: unknown): YouTubeJson3Payload {
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    return {};
  }

  return {
    events: payload.events
      .filter(isRecord)
      .map((event) => ({
        tStartMs:
          typeof event.tStartMs === "number" ? event.tStartMs : undefined,
        dDurationMs:
          typeof event.dDurationMs === "number" ? event.dDurationMs : undefined,
        segs: Array.isArray(event.segs)
          ? event.segs.filter(isRecord).map((segment) => ({
              utf8: typeof segment.utf8 === "string" ? segment.utf8 : undefined,
            }))
          : undefined,
      })),
  };
}

function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseYouTubeJson3Cues(payload: unknown): SubtitleCue[] {
  const json3Payload = toJson3Payload(payload);
  const cues: SubtitleCue[] = [];

  for (const event of json3Payload.events ?? []) {
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
