import { hashSubtitleText } from "@/subtitle/hash";
import type {
  SubtitleCue,
  SubtitleSegment,
  SubtitleSourceLanguage,
} from "@/subtitle/types";

export { validateSubtitleSegments } from "@/subtitle/segmentationValidation";

type SegmentOptions = {
  sourceLanguage: SubtitleSourceLanguage;
  maxDurationMs?: number;
  maxWords?: number;
  maxChars?: number;
  longPauseMs?: number;
};

const defaultMaxDurationMs = 7000;
const defaultMaxWords = 30;
const defaultMaxChars = 80;
const defaultLongPauseMs = 1200;

function isCjkText(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
}

function shouldUseCharacterStrategy(
  cues: readonly SubtitleCue[],
  sourceLanguage: SubtitleSourceLanguage,
): boolean {
  if (sourceLanguage.kind === "known") {
    return /^(zh|ja|ko)/i.test(sourceLanguage.code);
  }
  const combined = cues.map((cue) => cue.text).join("");
  return isCjkText(combined);
}

function hasStrongSentenceEnd(text: string): boolean {
  return /[.!?。！？…\])]$/.test(text.trim());
}

function measureText(text: string, characterStrategy: boolean): number {
  return characterStrategy
    ? text.length
    : text.split(/\s+/).filter(Boolean).length;
}

function joinCueText(
  cues: readonly SubtitleCue[],
  characterStrategy: boolean,
): string {
  return characterStrategy
    ? cues.map((cue) => cue.text).join("")
    : cues
        .map((cue) => cue.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

function buildSegment(
  cues: readonly SubtitleCue[],
  characterStrategy: boolean,
): SubtitleSegment {
  const first = cues[0];
  const last = cues[cues.length - 1];
  if (!first || !last) {
    throw new Error("Cannot build a subtitle segment without cues.");
  }
  const sourceText = joinCueText(cues, characterStrategy);
  return {
    segmentId: `sub-${first.index}-${last.index}-${hashSubtitleText(sourceText)}`,
    sourceCueIds: cues.map((cue) => cue.cueId),
    sourceCueStartIndex: first.index,
    sourceCueEndIndex: last.index,
    startMs: first.startMs,
    endMs: last.endMs,
    sourceText,
    textHash: hashSubtitleText(sourceText),
  };
}

export function segmentSubtitleCues(
  cues: readonly SubtitleCue[],
  options: SegmentOptions,
): SubtitleSegment[] {
  const characterStrategy = shouldUseCharacterStrategy(
    cues,
    options.sourceLanguage,
  );
  const maxDurationMs = options.maxDurationMs ?? defaultMaxDurationMs;
  const maxUnits = characterStrategy
    ? options.maxChars ?? defaultMaxChars
    : options.maxWords ?? defaultMaxWords;
  const longPauseMs = options.longPauseMs ?? defaultLongPauseMs;
  const segments: SubtitleSegment[] = [];
  let buffer: SubtitleCue[] = [];

  function flush(): void {
    if (buffer.length > 0) {
      segments.push(buildSegment(buffer, characterStrategy));
      buffer = [];
    }
  }

  for (const cue of cues) {
    const previous = buffer.at(-1);
    if (previous) {
      const pauseMs = cue.startMs - previous.endMs;
      const candidate = [...buffer, cue];
      const candidateText = joinCueText(candidate, characterStrategy);
      const candidateDurationMs = cue.endMs - buffer[0]!.startMs;
      const candidateUnits = measureText(candidateText, characterStrategy);

      if (
        pauseMs >= longPauseMs ||
        hasStrongSentenceEnd(previous.text) ||
        candidateDurationMs > maxDurationMs ||
        candidateUnits > maxUnits
      ) {
        flush();
      }
    }

    buffer.push(cue);
  }

  flush();
  return segments;
}
