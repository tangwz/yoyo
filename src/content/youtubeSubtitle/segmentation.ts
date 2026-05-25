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

function isCjkCharacter(char: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(char);
}

function isLatinCharacter(char: string): boolean {
  return /\p{Script=Latin}/u.test(char);
}

function countWhitespaceSeparatedWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function shouldUseCharacterStrategy(
  cues: readonly SubtitleCue[],
  sourceLanguage: SubtitleSourceLanguage,
): boolean {
  const combined = cues.map((cue) => cue.text).join(" ");
  let cjkCount = 0;
  let latinCount = 0;

  for (const char of combined) {
    if (isCjkCharacter(char)) {
      cjkCount += 1;
    } else if (isLatinCharacter(char)) {
      latinCount += 1;
    }
  }

  if (cjkCount > latinCount) {
    return true;
  }
  if (latinCount > cjkCount) {
    return false;
  }

  const nonWhitespaceLength = Array.from(combined).filter(
    (char) => char.trim().length > 0,
  ).length;
  const wordCount = countWhitespaceSeparatedWords(combined);
  if (nonWhitespaceLength > 1 && wordCount <= 1) {
    return true;
  }

  if (sourceLanguage.kind === "known") {
    return /^(zh|ja|ko)/i.test(sourceLanguage.code);
  }
  return false;
}

function hasStrongSentenceEnd(text: string): boolean {
  return /[.!?。！？…\])]$/.test(text.trim());
}

function measureText(text: string, characterStrategy: boolean): number {
  return characterStrategy
    ? Array.from(text).length
    : countWhitespaceSeparatedWords(text);
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
  const sourceCueIds = cues.map((cue) => cue.cueId);
  const textHash = hashSubtitleText(sourceText);
  const segmentHash = hashSubtitleText(
    [sourceCueIds.join(","), first.startMs, last.endMs, sourceText].join("|"),
  );
  return {
    segmentId: `sub-${first.index}-${last.index}-${segmentHash}`,
    sourceCueIds,
    sourceCueStartIndex: first.index,
    sourceCueEndIndex: last.index,
    startMs: first.startMs,
    endMs: last.endMs,
    sourceText,
    textHash,
  };
}

function splitTextIntoUnits(text: string, characterStrategy: boolean): string[] {
  return characterStrategy
    ? Array.from(text)
    : text.split(/\s+/).filter(Boolean);
}

function splitUnitsEvenly(
  units: readonly string[],
  chunkCount: number,
): string[][] {
  const chunks: string[][] = [];
  let unitOffset = 0;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const remainingUnits = units.length - unitOffset;
    const remainingChunks = chunkCount - chunkIndex;
    const chunkSize = Math.ceil(remainingUnits / remainingChunks);
    chunks.push(units.slice(unitOffset, unitOffset + chunkSize));
    unitOffset += chunkSize;
  }

  return chunks;
}

function joinUnits(units: readonly string[], characterStrategy: boolean): string {
  return characterStrategy ? units.join("") : units.join(" ");
}

function buildSplitCueSegment(
  cue: SubtitleCue,
  sourceText: string,
  startMs: number,
  endMs: number,
): SubtitleSegment {
  const textHash = hashSubtitleText(sourceText);
  const segmentHash = hashSubtitleText(
    [[cue.cueId].join(","), startMs, endMs, sourceText].join("|"),
  );
  return {
    segmentId: `sub-${cue.index}-${cue.index}-${startMs}-${endMs}-${segmentHash}`,
    sourceCueIds: [cue.cueId],
    sourceCueStartIndex: cue.index,
    sourceCueEndIndex: cue.index,
    startMs,
    endMs,
    sourceText,
    textHash,
  };
}

function buildSingleCueSegments(
  cue: SubtitleCue,
  characterStrategy: boolean,
  maxDurationMs: number,
  maxUnits: number,
): SubtitleSegment[] {
  const safeMaxDurationMs = Math.max(1, maxDurationMs);
  const safeMaxUnits = Math.max(1, maxUnits);
  const units = splitTextIntoUnits(cue.text, characterStrategy);
  const durationMs = cue.endMs - cue.startMs;
  const chunkCount = Math.max(
    Math.ceil(durationMs / safeMaxDurationMs),
    Math.ceil(units.length / safeMaxUnits),
  );

  if (chunkCount <= 1) {
    return [buildSegment([cue], characterStrategy)];
  }

  const textChunks =
    chunkCount <= units.length
      ? splitUnitsEvenly(units, chunkCount).map((chunk) =>
          joinUnits(chunk, characterStrategy),
        )
      : splitUnitsEvenly(
          Array.from(cue.text).filter((char) => char.trim()),
          chunkCount,
        ).map((chunk) => chunk.join(""));

  return textChunks
    .map((sourceText, index) => {
      const startMs =
        index === 0
          ? cue.startMs
          : cue.startMs + Math.round((durationMs * index) / textChunks.length);
      const endMs =
        index === textChunks.length - 1
          ? cue.endMs
          : cue.startMs +
            Math.round((durationMs * (index + 1)) / textChunks.length);
      return buildSplitCueSegment(cue, sourceText, startMs, endMs);
    })
    .filter((segment) => segment.sourceText && segment.endMs > segment.startMs);
}

function buildSegments(
  cues: readonly SubtitleCue[],
  characterStrategy: boolean,
  maxDurationMs: number,
  maxUnits: number,
): SubtitleSegment[] {
  if (cues.length === 1) {
    return buildSingleCueSegments(
      cues[0]!,
      characterStrategy,
      maxDurationMs,
      maxUnits,
    );
  }

  return [buildSegment(cues, characterStrategy)];
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
      segments.push(
        ...buildSegments(buffer, characterStrategy, maxDurationMs, maxUnits),
      );
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
