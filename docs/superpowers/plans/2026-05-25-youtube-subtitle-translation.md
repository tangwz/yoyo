# YouTube Subtitle Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build YouTube subtitle real-time translation with a player toolbar toggle, bilingual overlay, deterministic segmentation, optional AI segmentation, provider-backed translation, and automated browser fixture coverage.

**Architecture:** Add an independent YouTube subtitle pipeline instead of reusing page DOM translation orchestration. Content owns YouTube/player lifecycle, subtitle timeline, prefetch scheduling, session cache, toolbar button, and overlay; background owns provider resolution, subtitle cache, batch translation, cancellation, and AI segmentation validation. Shared subtitle types and message contracts keep content/background boundaries explicit.

**Tech Stack:** TypeScript, WXT MV3, Vue-free DOM content modules, Chrome extension runtime messaging, Vitest/jsdom, Playwright Chromium extension fixture tests, pnpm.

---

## File Structure

- Create: `src/subtitle/types.ts`
  - Shared `SubtitleCue`, `SubtitleSegment`, translation item, preferences, runtime status, cache key, and protocol helper types.
- Create: `src/subtitle/hash.ts`
  - Stable hash helpers for cue text, segment text, and subtitle cache keys.
- Create: `src/subtitle/segmentationValidation.ts`
  - Shared segment coverage and timing validator used by content built-in segmentation and background AI segmentation.
- Modify: `src/storage/defaults.ts`
  - Add `defaultSubtitlePreferences`.
- Modify: `src/storage/storageKeys.ts`
  - Add `subtitlePreferences`.
- Modify: `src/storage/repositories.ts`
  - Add `subtitlePreferenceRepository` with schema and bounds normalization.
- Modify: `src/messaging/contracts.ts`
  - Add subtitle background request/response variants.
- Create: `src/content/youtubeSubtitle/captionParser.ts`
  - Parse YouTube `timedtext` `json3` events into normalized cues.
- Create: `src/content/youtubeSubtitle/trackSelection.ts`
  - Select the best caption track and build stable track keys.
- Create: `src/content/youtubeSubtitle/segmentation.ts`
  - Built-in subtitle segmentation with script-aware rules and validator helpers.
- Create: `src/content/youtubeSubtitle/scheduler.ts`
  - Prefetch window scanning, batching, retry state, and stale request guards.
- Create: `src/content/youtubeSubtitle/sessionCache.ts`
  - Current-page subtitle translation cache.
- Create: `src/content/youtubeSubtitle/overlay.ts`
  - Bilingual overlay DOM rendering and cleanup.
- Create: `src/content/youtubeSubtitle/playerButton.ts`
  - Yoyo green “文” toolbar button, badge states, idempotent mount.
- Create: `src/content/youtubeSubtitle/runtime.ts`
  - YouTube SPA/player lifecycle, caption loading, translation dispatch, overlay updates, cancellation.
- Modify: `entrypoints/content.ts`
  - Start YouTube subtitle runtime and keep existing content message routing.
- Create: `src/background/youtubeSubtitle/cache.ts`
  - Independent short-lived subtitle translation cache.
- Create: `src/background/youtubeSubtitle/service.ts`
  - Batch translation service, provider resolution, cancellation, error responses.
- Create: `src/background/youtubeSubtitle/aiSegmentation.ts`
  - AI segmentation prompt, parser, validator, fallback signaling.
- Modify: `entrypoints/background.ts`
  - Wire subtitle repositories and background message handlers.
- Modify: `package.json`
  - Add `test:browser` script.
- Create: `tests/subtitle/types.test.ts`
- Modify: `tests/storage/repositories.test.ts`
- Modify: `tests/messaging/contracts.test.ts`
- Create: `tests/content/youtubeSubtitle/captionParser.test.ts`
- Create: `tests/content/youtubeSubtitle/trackSelection.test.ts`
- Create: `tests/content/youtubeSubtitle/segmentation.test.ts`
- Create: `tests/content/youtubeSubtitle/scheduler.test.ts`
- Create: `tests/content/youtubeSubtitle/sessionCache.test.ts`
- Create: `tests/content/youtubeSubtitle/overlay.test.ts`
- Create: `tests/content/youtubeSubtitle/playerButton.test.ts`
- Create: `tests/background/youtubeSubtitle/cache.test.ts`
- Create: `tests/background/youtubeSubtitle/service.test.ts`
- Create: `tests/background/youtubeSubtitle/aiSegmentation.test.ts`
- Create: `tests/browser/youtube-subtitle-fixture.mjs`
- Create: `tests/browser/youtube-subtitle.spec.mjs`
- Create: `scripts/test-browser.mjs`

---

### Task 1: Shared Subtitle Types, Storage, and Messaging Contracts

**Files:**
- Create: `src/subtitle/types.ts`
- Create: `src/subtitle/hash.ts`
- Modify: `src/storage/defaults.ts`
- Modify: `src/storage/storageKeys.ts`
- Modify: `src/storage/repositories.ts`
- Modify: `src/messaging/contracts.ts`
- Create: `tests/subtitle/types.test.ts`
- Modify: `tests/storage/repositories.test.ts`
- Modify: `tests/messaging/contracts.test.ts`

- [ ] **Step 1: Write failing type and storage tests**

Create `tests/subtitle/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
} from "@/subtitle/types";

describe("subtitle types", () => {
  it("normalizes corrupt preferences to bounded defaults", () => {
    expect(normalizeSubtitlePreferences(null)).toEqual(defaultSubtitlePreferences);
    expect(
      normalizeSubtitlePreferences({
        schemaVersion: 1,
        youtubeEnabled: "yes",
        aiSegmentationEnabled: "no",
        prefetchBeforeMs: -1,
        prefetchAfterMs: 999999,
        maxRetryCount: 99,
      }),
    ).toEqual(defaultSubtitlePreferences);
  });

  it("keeps valid bounded subtitle preferences", () => {
    expect(
      normalizeSubtitlePreferences({
        schemaVersion: 1,
        youtubeEnabled: false,
        aiSegmentationEnabled: true,
        prefetchBeforeMs: 5000,
        prefetchAfterMs: 60000,
        maxRetryCount: 3,
      }),
    ).toEqual({
      schemaVersion: 1,
      youtubeEnabled: false,
      aiSegmentationEnabled: true,
      prefetchBeforeMs: 5000,
      prefetchAfterMs: 60000,
      maxRetryCount: 3,
    });
  });
});
```

Append to `tests/storage/repositories.test.ts`:

```ts
import {
  subtitlePreferenceRepository,
} from "@/storage/repositories";
import {
  defaultSubtitlePreferences,
} from "@/subtitle/types";

it("stores subtitle preferences in sync storage", async () => {
  const sync = createInMemoryStorageArea();
  const repository = subtitlePreferenceRepository({ syncedStorage: sync });

  await expect(repository.get()).resolves.toEqual(defaultSubtitlePreferences);

  await repository.save({
    schemaVersion: 1,
    youtubeEnabled: false,
    aiSegmentationEnabled: true,
    prefetchBeforeMs: 1000,
    prefetchAfterMs: 45000,
    maxRetryCount: 1,
  });

  expect(await sync.get("yoyo.subtitlePreferences")).toEqual({
    "yoyo.subtitlePreferences": {
      schemaVersion: 1,
      youtubeEnabled: false,
      aiSegmentationEnabled: true,
      prefetchBeforeMs: 1000,
      prefetchAfterMs: 45000,
      maxRetryCount: 1,
    },
  });
});
```

Append to `tests/messaging/contracts.test.ts`:

```ts
it("supports subtitle translation batch requests", () => {
  const request = {
    type: "translateSubtitleBatch",
    runtimeSessionId: "runtime-1",
    configVersion: 2,
    requestId: "request-1",
    videoId: "video-1",
    trackKey: "video-1|en|asr",
    sourceLanguage: { kind: "known", code: "en" },
    targetLanguage: "zh-CN",
    providerId: "provider-1",
    modelKey: "gpt-5-mini",
    promptVersion: "subtitle-translation-v1",
    segmentationVersion: "builtin-v1",
    translationMode: "youtubeSubtitleRealtime",
    segments: [
      {
        segmentId: "seg-1",
        sourceCueIds: ["cue-1"],
        sourceCueStartIndex: 0,
        sourceCueEndIndex: 0,
        startMs: 1000,
        endMs: 2500,
        sourceText: "Hello world.",
        textHash: "hash-1",
      },
    ],
  } satisfies BackgroundRequest;

  expect(request.type).toBe("translateSubtitleBatch");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/subtitle/types.test.ts tests/storage/repositories.test.ts tests/messaging/contracts.test.ts
```

Expected: FAIL because subtitle types, storage repository, key, and messaging variants do not exist.

- [ ] **Step 3: Add shared subtitle types and normalization**

Create `src/subtitle/types.ts`:

```ts
export type SubtitleSourceLanguage =
  | { kind: "known"; code: string }
  | { kind: "unknown" };

export type SubtitleTranslationMode = "youtubeSubtitleRealtime";

export type SubtitleCue = {
  cueId: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type SubtitleSegment = {
  segmentId: string;
  sourceCueIds: string[];
  sourceCueStartIndex: number;
  sourceCueEndIndex: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  textHash: string;
};

export type SubtitleTranslationItem = {
  segmentId: string;
  translatedText: string;
};

export type SubtitlePreferences = {
  schemaVersion: 1;
  youtubeEnabled: boolean;
  aiSegmentationEnabled: boolean;
  prefetchBeforeMs: number;
  prefetchAfterMs: number;
  maxRetryCount: number;
};

export const defaultSubtitlePreferences: SubtitlePreferences = {
  schemaVersion: 1,
  youtubeEnabled: true,
  aiSegmentationEnabled: false,
  prefetchBeforeMs: 2000,
  prefetchAfterMs: 90000,
  maxRetryCount: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

export function normalizeSubtitlePreferences(value: unknown): SubtitlePreferences {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return defaultSubtitlePreferences;
  }

  return {
    schemaVersion: 1,
    youtubeEnabled:
      typeof value.youtubeEnabled === "boolean"
        ? value.youtubeEnabled
        : defaultSubtitlePreferences.youtubeEnabled,
    aiSegmentationEnabled:
      typeof value.aiSegmentationEnabled === "boolean"
        ? value.aiSegmentationEnabled
        : defaultSubtitlePreferences.aiSegmentationEnabled,
    prefetchBeforeMs: boundedNumber(
      value.prefetchBeforeMs,
      0,
      10000,
      defaultSubtitlePreferences.prefetchBeforeMs,
    ),
    prefetchAfterMs: boundedNumber(
      value.prefetchAfterMs,
      15000,
      180000,
      defaultSubtitlePreferences.prefetchAfterMs,
    ),
    maxRetryCount: boundedNumber(
      value.maxRetryCount,
      0,
      5,
      defaultSubtitlePreferences.maxRetryCount,
    ),
  };
}
```

Create `src/subtitle/hash.ts`:

```ts
export function hashSubtitleText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
```

- [ ] **Step 4: Wire storage defaults and repositories**

Modify `src/storage/defaults.ts`:

```ts
export {
  defaultSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";
```

Modify `src/storage/storageKeys.ts`:

```ts
subtitlePreferences: "yoyo.subtitlePreferences",
```

Modify `src/storage/repositories.ts` imports:

```ts
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";
```

Add dependency type and repository:

```ts
type SubtitlePreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};

export function subtitlePreferenceRepository({
  syncedStorage,
}: SubtitlePreferenceRepositoryDependencies) {
  async function get(): Promise<SubtitlePreferences> {
    const result = await syncedStorage.get({
      [storageKeys.subtitlePreferences]: defaultSubtitlePreferences,
    });
    return normalizeSubtitlePreferences(result[storageKeys.subtitlePreferences]);
  }

  async function save(preferences: SubtitlePreferences): Promise<void> {
    await syncedStorage.set({
      [storageKeys.subtitlePreferences]: normalizeSubtitlePreferences(preferences),
    });
  }

  return { get, save };
}
```

Add repository to `createStorageRepositories()`:

```ts
subtitlePreferences: subtitlePreferenceRepository({ syncedStorage: storage.sync }),
```

- [ ] **Step 5: Add messaging variants**

Modify `src/messaging/contracts.ts` imports:

```ts
import type {
  SubtitleCue,
  SubtitleSegment,
  SubtitleSourceLanguage,
  SubtitleTranslationItem,
  SubtitleTranslationMode,
} from "@/subtitle/types";
```

Add `BackgroundRequest` variants:

```ts
| {
    type: "translateSubtitleBatch";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    videoId: string;
    trackKey: string;
    sourceLanguage: SubtitleSourceLanguage;
    targetLanguage: string;
    providerId: string;
    modelKey: string;
    promptVersion: string;
    segmentationVersion: string;
    translationMode: SubtitleTranslationMode;
    segments: SubtitleSegment[];
  }
| {
    type: "cancelSubtitleRequests";
    runtimeSessionId: string;
    reason: "userDisabled" | "videoChanged" | "configChanged" | "pageUnloaded";
  }
| {
    type: "segmentSubtitleChunk";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    videoId: string;
    trackKey: string;
    sourceLanguage: SubtitleSourceLanguage;
    targetLanguage: string;
    providerId: string;
    modelKey: string;
    segmentationPromptVersion: string;
    segmentationVersion: string;
    sourceCues: SubtitleCue[];
    previousContext?: string;
    nextContext?: string;
  }
```

Add `BackgroundResponse` variants:

```ts
| {
    type: "subtitleTranslateBatchResult";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    items: SubtitleTranslationItem[];
  }
| {
    type: "subtitleTranslateBatchError";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    message: string;
    retryable: boolean;
  }
| {
    type: "segmentSubtitleChunkResult";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    segments: Array<SubtitleSegment & { translatedText?: string }>;
  }
| {
    type: "segmentSubtitleChunkError";
    runtimeSessionId: string;
    configVersion: number;
    requestId: string;
    message: string;
    fallbackRequired: true;
  }
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm vitest run tests/subtitle/types.test.ts tests/storage/repositories.test.ts tests/messaging/contracts.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/subtitle src/storage/defaults.ts src/storage/storageKeys.ts src/storage/repositories.ts src/messaging/contracts.ts tests/subtitle/types.test.ts tests/storage/repositories.test.ts tests/messaging/contracts.test.ts
git commit -m "Add subtitle preferences and message contracts"
```

---

### Task 2: Caption Parsing, Track Selection, and Built-In Segmentation

**Files:**
- Create: `src/content/youtubeSubtitle/captionParser.ts`
- Create: `src/content/youtubeSubtitle/trackSelection.ts`
- Create: `src/content/youtubeSubtitle/segmentation.ts`
- Create: `tests/content/youtubeSubtitle/captionParser.test.ts`
- Create: `tests/content/youtubeSubtitle/trackSelection.test.ts`
- Create: `tests/content/youtubeSubtitle/segmentation.test.ts`
- Create: `src/subtitle/segmentationValidation.ts`

- [ ] **Step 1: Write failing caption parser tests**

Create `tests/content/youtubeSubtitle/captionParser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseYouTubeJson3Cues } from "@/content/youtubeSubtitle/captionParser";

describe("parseYouTubeJson3Cues", () => {
  it("normalizes json3 events into valid cues", () => {
    const cues = parseYouTubeJson3Cues({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [{ utf8: " Hello " }, { utf8: "<b>world</b>" }],
        },
        {
          tStartMs: 3500,
          dDurationMs: 500,
          segs: [{ utf8: "\n" }],
        },
        {
          tStartMs: 4500,
          dDurationMs: 1500,
          segs: [{ utf8: "Next line" }],
        },
      ],
    });

    expect(cues).toEqual([
      {
        cueId: "cue-0",
        index: 0,
        startMs: 1000,
        endMs: 3000,
        text: "Hello world",
      },
      {
        cueId: "cue-1",
        index: 1,
        startMs: 4500,
        endMs: 6000,
        text: "Next line",
      },
    ]);
  });

  it("drops cues with empty text or invalid timing", () => {
    expect(
      parseYouTubeJson3Cues({
        events: [
          { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: "No duration" }] },
          { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "   " }] },
        ],
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Write failing segmentation tests**

Create `tests/content/youtubeSubtitle/segmentation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  segmentSubtitleCues,
  validateSubtitleSegments,
} from "@/content/youtubeSubtitle/segmentation";
import type { SubtitleCue } from "@/subtitle/types";

function cue(index: number, startMs: number, endMs: number, text: string): SubtitleCue {
  return {
    cueId: `cue-${index}`,
    index,
    startMs,
    endMs,
    text,
  };
}

describe("segmentSubtitleCues", () => {
  it("merges short English cues forward until punctuation", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 700, "Hello"),
        cue(1, 700, 1400, "world."),
        cue(2, 1600, 2500, "Next sentence."),
      ],
      { sourceLanguage: { kind: "known", code: "en" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "Hello world.",
      "Next sentence.",
    ]);
    expect(segments[0]?.sourceCueIds).toEqual(["cue-0", "cue-1"]);
  });

  it("uses character strategy for CJK cues", () => {
    const segments = segmentSubtitleCues(
      [
        cue(0, 0, 1000, "你好"),
        cue(1, 1000, 2000, "世界。"),
        cue(2, 2300, 3200, "下一句。"),
      ],
      { sourceLanguage: { kind: "known", code: "zh-CN" } },
    );

    expect(segments.map((segment) => segment.sourceText)).toEqual([
      "你好世界。",
      "下一句。",
    ]);
  });

  it("rejects non-contiguous segment coverage", () => {
    const cues = [
      cue(0, 0, 1000, "One."),
      cue(1, 1000, 2000, "Two."),
    ];
    const result = validateSubtitleSegments(cues, [
      {
        segmentId: "seg-1",
        sourceCueIds: ["cue-0"],
        sourceCueStartIndex: 0,
        sourceCueEndIndex: 1,
        startMs: 0,
        endMs: 2000,
        sourceText: "One. Two.",
        textHash: "hash",
      },
    ]);

    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 3: Run parser and segmentation tests and verify failure**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/captionParser.test.ts tests/content/youtubeSubtitle/segmentation.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement caption parsing**

Create `src/content/youtubeSubtitle/captionParser.ts`:

```ts
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

export function parseYouTubeJson3Cues(payload: YouTubeJson3Payload): SubtitleCue[] {
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
```

- [ ] **Step 5: Implement shared segment validation**

Create `src/subtitle/segmentationValidation.ts`:

```ts
import type { SubtitleCue, SubtitleSegment } from "@/subtitle/types";

export type SubtitleSegmentValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateSubtitleSegments(
  cues: readonly SubtitleCue[],
  segments: readonly SubtitleSegment[],
): SubtitleSegmentValidationResult {
  for (const segment of segments) {
    const covered = cues.slice(
      segment.sourceCueStartIndex,
      segment.sourceCueEndIndex + 1,
    );
    if (covered.length === 0) {
      return { valid: false, reason: "Segment does not cover any cues." };
    }
    if (
      covered.map((cue) => cue.cueId).join("|") !==
      segment.sourceCueIds.join("|")
    ) {
      return { valid: false, reason: "Segment cue ids do not match its range." };
    }
    if (segment.startMs !== covered[0]!.startMs || segment.endMs !== covered.at(-1)!.endMs) {
      return { valid: false, reason: "Segment timing does not come from source cues." };
    }
  }
  return { valid: true };
}
```

- [ ] **Step 6: Implement built-in segmentation**

Create `src/content/youtubeSubtitle/segmentation.ts`:

```ts
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
  return characterStrategy ? text.length : text.split(/\s+/).filter(Boolean).length;
}

function joinCueText(cues: readonly SubtitleCue[], characterStrategy: boolean): string {
  return characterStrategy
    ? cues.map((cue) => cue.text).join("")
    : cues.map((cue) => cue.text).join(" ").replace(/\s+/g, " ").trim();
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
  const characterStrategy = shouldUseCharacterStrategy(cues, options.sourceLanguage);
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

```

- [ ] **Step 7: Implement track selection**

Create `tests/content/youtubeSubtitle/trackSelection.test.ts`:

```ts
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
```

Create `src/content/youtubeSubtitle/trackSelection.ts`:

```ts
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

export function buildTrackKey(videoId: string, track: YouTubeCaptionTrack): string {
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
  return (
    usableTracks.find(
      (track) =>
        track.languageCode === preference.languageCode &&
        (track.kind ?? null) === (preference.kind ?? null),
    ) ??
    usableTracks.find((track) => track.languageCode === preference.languageCode) ??
    usableTracks.find((track) => track.kind !== "asr") ??
    usableTracks.find((track) => track.kind === "asr") ??
    usableTracks[0]
  );
}
```

- [ ] **Step 8: Run tests and commit**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/captionParser.test.ts tests/content/youtubeSubtitle/trackSelection.test.ts tests/content/youtubeSubtitle/segmentation.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/content/youtubeSubtitle/captionParser.ts src/content/youtubeSubtitle/trackSelection.ts src/content/youtubeSubtitle/segmentation.ts src/subtitle/segmentationValidation.ts tests/content/youtubeSubtitle/captionParser.test.ts tests/content/youtubeSubtitle/trackSelection.test.ts tests/content/youtubeSubtitle/segmentation.test.ts
git commit -m "Add YouTube subtitle parsing and segmentation"
```

---

### Task 3: Subtitle Scheduler and Session Cache

**Files:**
- Create: `src/content/youtubeSubtitle/scheduler.ts`
- Create: `src/content/youtubeSubtitle/sessionCache.ts`
- Create: `tests/content/youtubeSubtitle/scheduler.test.ts`
- Create: `tests/content/youtubeSubtitle/sessionCache.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Create `tests/content/youtubeSubtitle/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SubtitleScheduler } from "@/content/youtubeSubtitle/scheduler";
import type { SubtitleSegment } from "@/subtitle/types";

function segment(index: number, startMs: number, endMs: number): SubtitleSegment {
  return {
    segmentId: `seg-${index}`,
    sourceCueIds: [`cue-${index}`],
    sourceCueStartIndex: index,
    sourceCueEndIndex: index,
    startMs,
    endMs,
    sourceText: `Text ${index}`,
    textHash: `hash-${index}`,
  };
}

describe("SubtitleScheduler", () => {
  it("queues untranslated segments inside the prefetch window", () => {
    const scheduler = new SubtitleScheduler({
      prefetchBeforeMs: 2000,
      prefetchAfterMs: 60000,
      maxRetryCount: 2,
      maxBatchSegments: 2,
      maxBatchChars: 100,
    });

    scheduler.replaceTimeline([
      segment(1, 0, 1000),
      segment(2, 10000, 11000),
      segment(3, 80000, 81000),
    ]);

    expect(scheduler.scanWindow(12000).map((item) => item.segmentId)).toEqual([
      "seg-1",
      "seg-2",
    ]);
    expect(scheduler.takeBatch("request-1").map((item) => item.segmentId)).toEqual([
      "seg-1",
      "seg-2",
    ]);
  });

  it("does not enqueue stale translated or retry-exhausted segments", () => {
    const scheduler = new SubtitleScheduler({
      prefetchBeforeMs: 0,
      prefetchAfterMs: 90000,
      maxRetryCount: 1,
      maxBatchSegments: 10,
      maxBatchChars: 1000,
    });
    scheduler.replaceTimeline([segment(1, 0, 1000)]);
    scheduler.scanWindow(0);
    scheduler.takeBatch("request-1");
    scheduler.markFailed(["seg-1"]);
    scheduler.scanWindow(0);
    scheduler.takeBatch("request-2");
    scheduler.markFailed(["seg-1"]);

    expect(scheduler.scanWindow(0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write failing cache tests**

Create `tests/content/youtubeSubtitle/sessionCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SubtitleSessionCache,
  createSubtitleSessionCacheKey,
} from "@/content/youtubeSubtitle/sessionCache";

describe("SubtitleSessionCache", () => {
  it("keys translations by video, track, provider, model, prompt, and segmentation", () => {
    const base = {
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "model-1",
      segmentTextHash: "hash-1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime" as const,
      promptVersion: "subtitle-translation-v1",
    };

    expect(createSubtitleSessionCacheKey(base)).not.toBe(
      createSubtitleSessionCacheKey({ ...base, promptVersion: "subtitle-translation-v2" }),
    );
  });

  it("stores and reads current page translations", () => {
    const cache = new SubtitleSessionCache();
    const key = createSubtitleSessionCacheKey({
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "model-1",
      segmentTextHash: "hash-1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime",
      promptVersion: "subtitle-translation-v1",
    });

    cache.set(key, "你好");
    expect(cache.get(key)).toBe("你好");
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/scheduler.test.ts tests/content/youtubeSubtitle/sessionCache.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement scheduler**

Create `src/content/youtubeSubtitle/scheduler.ts`:

```ts
import type { SubtitleSegment } from "@/subtitle/types";

type SchedulerOptions = {
  prefetchBeforeMs: number;
  prefetchAfterMs: number;
  maxRetryCount: number;
  maxBatchSegments: number;
  maxBatchChars: number;
};

type SegmentState = "pending" | "inFlight" | "translated" | "failed";

export class SubtitleScheduler {
  private timeline: SubtitleSegment[] = [];
  private pending = new Map<string, SubtitleSegment>();
  private state = new Map<string, SegmentState>();
  private failures = new Map<string, number>();

  constructor(private readonly options: SchedulerOptions) {}

  replaceTimeline(segments: SubtitleSegment[]): void {
    this.timeline = segments;
    this.pending.clear();
    this.state.clear();
    this.failures.clear();
  }

  scanWindow(currentTimeMs: number): SubtitleSegment[] {
    const min = currentTimeMs - this.options.prefetchBeforeMs;
    const max = currentTimeMs + this.options.prefetchAfterMs;
    const queued: SubtitleSegment[] = [];

    for (const segment of this.timeline) {
      const inWindow = segment.endMs >= min && segment.startMs <= max;
      const state = this.state.get(segment.segmentId);
      const failures = this.failures.get(segment.segmentId) ?? 0;
      if (
        inWindow &&
        state !== "inFlight" &&
        state !== "translated" &&
        failures <= this.options.maxRetryCount &&
        !this.pending.has(segment.segmentId)
      ) {
        this.pending.set(segment.segmentId, segment);
        this.state.set(segment.segmentId, "pending");
        queued.push(segment);
      }
    }

    return queued;
  }

  takeBatch(_requestId: string): SubtitleSegment[] {
    const batch: SubtitleSegment[] = [];
    let chars = 0;

    for (const segment of this.pending.values()) {
      const nextChars = chars + segment.sourceText.length;
      if (
        batch.length > 0 &&
        (batch.length >= this.options.maxBatchSegments ||
          nextChars > this.options.maxBatchChars)
      ) {
        break;
      }
      batch.push(segment);
      chars = nextChars;
    }

    for (const segment of batch) {
      this.pending.delete(segment.segmentId);
      this.state.set(segment.segmentId, "inFlight");
    }

    return batch;
  }

  markTranslated(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      this.pending.delete(segmentId);
      this.state.set(segmentId, "translated");
    }
  }

  markFailed(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      this.pending.delete(segmentId);
      this.state.set(segmentId, "failed");
      this.failures.set(segmentId, (this.failures.get(segmentId) ?? 0) + 1);
    }
  }

  clearInFlight(): void {
    for (const [segmentId, state] of this.state) {
      if (state === "inFlight") {
        this.state.delete(segmentId);
      }
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 5: Implement session cache**

Create `src/content/youtubeSubtitle/sessionCache.ts`:

```ts
import type { SubtitleTranslationMode } from "@/subtitle/types";

type SubtitleSessionCacheKeyInput = {
  videoId: string;
  trackKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerId: string;
  modelKey: string;
  segmentTextHash: string;
  segmentationVersion: string;
  translationMode: SubtitleTranslationMode;
  promptVersion: string;
};

export function createSubtitleSessionCacheKey(input: SubtitleSessionCacheKeyInput): string {
  return [
    input.videoId,
    input.trackKey,
    input.sourceLanguage,
    input.targetLanguage,
    input.providerId,
    input.modelKey,
    input.segmentTextHash,
    input.segmentationVersion,
    input.translationMode,
    input.promptVersion,
  ].join("\u001f");
}

export class SubtitleSessionCache {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, translatedText: string): void {
    this.values.set(key, translatedText);
  }

  clear(): void {
    this.values.clear();
  }
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/scheduler.test.ts tests/content/youtubeSubtitle/sessionCache.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/content/youtubeSubtitle/scheduler.ts src/content/youtubeSubtitle/sessionCache.ts tests/content/youtubeSubtitle/scheduler.test.ts tests/content/youtubeSubtitle/sessionCache.test.ts
git commit -m "Add subtitle scheduler and session cache"
```

---

### Task 4: Background Subtitle Translation Service and Cache

**Files:**
- Create: `src/background/youtubeSubtitle/cache.ts`
- Create: `src/background/youtubeSubtitle/service.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/provider/types.ts`
- Create: `tests/background/youtubeSubtitle/cache.test.ts`
- Create: `tests/background/youtubeSubtitle/service.test.ts`

- [ ] **Step 1: Write failing background cache tests**

Create `tests/background/youtubeSubtitle/cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SubtitleTranslationCache } from "@/background/youtubeSubtitle/cache";

describe("SubtitleTranslationCache", () => {
  it("evicts least recently used entries", () => {
    const cache = new SubtitleTranslationCache(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
  });
});
```

- [ ] **Step 2: Write failing service tests**

Create `tests/background/youtubeSubtitle/service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSubtitleTranslationService } from "@/background/youtubeSubtitle/service";
import type { ProviderProfile } from "@/provider/types";

const profile: ProviderProfile = {
  id: "provider-1",
  displayName: "Provider",
  type: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "secret",
  textModel: "gpt-5-mini",
};

describe("createSubtitleTranslationService", () => {
  it("translates subtitle batches with the active provider", async () => {
    const translateBatch = vi.fn(async () => ({
      items: [{ segmentId: "seg-1", translatedText: "你好" }],
    }));
    const service = createSubtitleTranslationService({
      getActiveProfile: vi.fn(async () => profile),
      getTranslationProvider: vi.fn(() => ({ translateText: vi.fn(), translateBatch })),
      detectSourceLanguage: vi.fn(),
    });

    const response = await service.translateBatch({
      type: "translateSubtitleBatch",
      runtimeSessionId: "runtime-1",
      configVersion: 1,
      requestId: "request-1",
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: { kind: "known", code: "en" },
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "gpt-5-mini",
      promptVersion: "subtitle-translation-v1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime",
      segments: [
        {
          segmentId: "seg-1",
          sourceCueIds: ["cue-1"],
          sourceCueStartIndex: 0,
          sourceCueEndIndex: 0,
          startMs: 0,
          endMs: 1000,
          sourceText: "Hello",
          textHash: "hash-1",
        },
      ],
    });

    expect(response).toEqual({
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: "runtime-1",
      configVersion: 1,
      requestId: "request-1",
      items: [{ segmentId: "seg-1", translatedText: "你好" }],
    });
  });

  it("returns retryable batch errors for provider failures", async () => {
    const service = createSubtitleTranslationService({
      getActiveProfile: vi.fn(async () => profile),
      getTranslationProvider: vi.fn(() => ({
        translateText: vi.fn(),
        translateBatch: vi.fn(async () => {
          throw new Error("Rate limited");
        }),
      })),
      detectSourceLanguage: vi.fn(),
    });

    const response = await service.translateBatch({
      type: "translateSubtitleBatch",
      runtimeSessionId: "runtime-1",
      configVersion: 1,
      requestId: "request-1",
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: { kind: "unknown" },
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "gpt-5-mini",
      promptVersion: "subtitle-translation-v1",
      segmentationVersion: "builtin-v1",
      translationMode: "youtubeSubtitleRealtime",
      segments: [],
    });

    expect(response).toMatchObject({
      type: "subtitleTranslateBatchError",
      retryable: true,
      message: "Rate limited",
    });
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/cache.test.ts tests/background/youtubeSubtitle/service.test.ts
```

Expected: FAIL because background subtitle modules do not exist.

- [ ] **Step 4: Implement background cache**

Create `src/background/youtubeSubtitle/cache.ts`:

```ts
export class SubtitleTranslationCache {
  private readonly values = new Map<string, string>();

  constructor(private readonly maxEntries = 500) {}

  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.values.has(key)) {
      this.values.delete(key);
    }
    this.values.set(key, value);
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.values.delete(oldest);
    }
  }
}
```

- [ ] **Step 5: Implement translation service**

Create `src/background/youtubeSubtitle/service.ts`:

```ts
import type {
  BackgroundRequest,
  BackgroundResponse,
} from "@/messaging/contracts";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";

type TranslateSubtitleBatchRequest = Extract<
  BackgroundRequest,
  { type: "translateSubtitleBatch" }
>;

type SubtitleServiceDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  detectSourceLanguage: (text: string, signal: AbortSignal) => Promise<string | undefined>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Subtitle translation failed.";
}

export function createSubtitleTranslationService(
  dependencies: SubtitleServiceDependencies,
) {
  const controllers = new Map<string, Set<AbortController>>();

  async function translateBatch(
    request: TranslateSubtitleBatchRequest,
  ): Promise<BackgroundResponse> {
    const controller = new AbortController();
    const runtimeControllers =
      controllers.get(request.runtimeSessionId) ?? new Set<AbortController>();
    runtimeControllers.add(controller);
    controllers.set(request.runtimeSessionId, runtimeControllers);

    try {
      const profile = await dependencies.getActiveProfile();
      if (!profile) {
        return {
          type: "subtitleTranslateBatchError",
          runtimeSessionId: request.runtimeSessionId,
          configVersion: request.configVersion,
          requestId: request.requestId,
          message: "No translation provider is configured.",
          retryable: false,
        };
      }

      const sourceLanguage =
        request.sourceLanguage.kind === "known"
          ? request.sourceLanguage.code
          : (await dependencies.detectSourceLanguage(
              request.segments.map((segment) => segment.sourceText).join("\n"),
              controller.signal,
            )) ?? "auto";

      const provider = dependencies.getTranslationProvider(profile);
      const response = await provider.translateBatch({
        profile,
        sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: request.segments.map((segment, order) => ({
          id: segment.segmentId,
          order,
          sourceText: segment.sourceText,
          kind: "paragraph",
          priority: "viewport",
          pathHint: `youtube.subtitle.${segment.segmentId}`,
          textHash: segment.textHash,
        })),
        abortSignal: controller.signal,
        traceContext: {
          stage: "subtitle",
          providerType: profile.type,
          taskId: request.runtimeSessionId,
          batchId: request.requestId,
        },
      });

      return {
        type: "subtitleTranslateBatchResult",
        runtimeSessionId: request.runtimeSessionId,
        configVersion: request.configVersion,
        requestId: request.requestId,
        items: response.items.map((item) => ({
          segmentId: item.segmentId,
          translatedText: item.translatedText,
        })),
      };
    } catch (error) {
      return {
        type: "subtitleTranslateBatchError",
        runtimeSessionId: request.runtimeSessionId,
        configVersion: request.configVersion,
        requestId: request.requestId,
        message: errorMessage(error),
        retryable: !controller.signal.aborted,
      };
    } finally {
      runtimeControllers.delete(controller);
    }
  }

  function cancel(runtimeSessionId: string): void {
    for (const controller of controllers.get(runtimeSessionId) ?? []) {
      controller.abort();
    }
    controllers.delete(runtimeSessionId);
  }

  return { translateBatch, cancel };
}
```

Modify `src/provider/types.ts` so subtitle provider calls have an explicit trace stage:

```ts
stage?: "page" | "lazy" | "selection" | "summary" | "subtitle";
```

- [ ] **Step 6: Wire background message handlers**

In `entrypoints/background.ts`, create the service after `translationProviderResolver`:

```ts
const subtitleTranslationService = createSubtitleTranslationService({
  getActiveProfile,
  getTranslationProvider: (profile) =>
    translationProviderResolver.getTranslationProvider(profile),
  detectSourceLanguage: (text, signal) =>
    getChromeBuiltInAiOffscreenClient().detectLanguage(text, signal),
});
```

Add imports:

```ts
import { createSubtitleTranslationService } from "@/background/youtubeSubtitle/service";
```

Add cases in `addRuntimeMessageListener`:

```ts
case "translateSubtitleBatch":
  return subtitleTranslationService.translateBatch(request);
case "cancelSubtitleRequests":
  subtitleTranslationService.cancel(request.runtimeSessionId);
  return { type: "backgroundActionResult", success: true };
```

- [ ] **Step 7: Run tests and commit**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/cache.test.ts tests/background/youtubeSubtitle/service.test.ts tests/messaging/contracts.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/background/youtubeSubtitle src/provider/types.ts entrypoints/background.ts tests/background/youtubeSubtitle tests/messaging/contracts.test.ts
git commit -m "Add background subtitle translation service"
```

---

### Task 5: Overlay and Player Button UI

**Files:**
- Create: `src/content/youtubeSubtitle/overlay.ts`
- Create: `src/content/youtubeSubtitle/playerButton.ts`
- Create: `tests/content/youtubeSubtitle/overlay.test.ts`
- Create: `tests/content/youtubeSubtitle/playerButton.test.ts`

- [ ] **Step 1: Write failing overlay tests**

Create `tests/content/youtubeSubtitle/overlay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createSubtitleOverlay,
} from "@/content/youtubeSubtitle/overlay";

describe("createSubtitleOverlay", () => {
  it("renders bilingual notranslate overlay without pointer interception", () => {
    document.body.innerHTML = `<div id="player"></div>`;
    const player = document.querySelector("#player") as HTMLElement;
    const overlay = createSubtitleOverlay(player);

    overlay.render({
      sourceText: "Hello world.",
      translatedText: "你好，世界。",
      state: "translated",
    });

    const root = player.querySelector("[data-yoyo-youtube-subtitle-overlay]");
    expect(root).toHaveAttribute("translate", "no");
    expect(root).toHaveClass("notranslate");
    expect(root).toHaveStyle({ pointerEvents: "none" });
    expect(root?.textContent).toContain("Hello world.");
    expect(root?.textContent).toContain("你好，世界。");
  });

  it("removes overlay on destroy", () => {
    const player = document.createElement("div");
    document.body.appendChild(player);
    const overlay = createSubtitleOverlay(player);
    overlay.render({ sourceText: "Hello", state: "loading" });
    overlay.destroy();

    expect(player.querySelector("[data-yoyo-youtube-subtitle-overlay]")).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing player button tests**

Create `tests/content/youtubeSubtitle/playerButton.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  mountSubtitlePlayerButton,
} from "@/content/youtubeSubtitle/playerButton";

describe("mountSubtitlePlayerButton", () => {
  it("mounts a single green Yoyo text button with enabled badge", () => {
    document.body.innerHTML = `<div class="ytp-right-controls"></div>`;
    const controls = document.querySelector(".ytp-right-controls") as HTMLElement;
    const onToggle = vi.fn();

    mountSubtitlePlayerButton(controls, { status: "enabled", onToggle });
    mountSubtitlePlayerButton(controls, { status: "enabled", onToggle });

    expect(controls.querySelectorAll("[data-yoyo-youtube-subtitle-button]")).toHaveLength(1);
    expect(controls.textContent).toContain("文");
    expect(controls.querySelector("[data-yoyo-subtitle-badge]")).toHaveTextContent("✓");
  });

  it("updates badge and calls toggle handler", () => {
    const controls = document.createElement("div");
    const onToggle = vi.fn();
    const button = mountSubtitlePlayerButton(controls, { status: "disabled", onToggle });

    expect(controls.querySelector("[data-yoyo-subtitle-badge]")).toHaveTextContent("×");
    button.element.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    button.update({ status: "warning", onToggle });
    expect(controls.querySelector("[data-yoyo-subtitle-badge]")).toHaveTextContent("!");
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/overlay.test.ts tests/content/youtubeSubtitle/playerButton.test.ts
```

Expected: FAIL because UI modules do not exist.

- [ ] **Step 4: Implement overlay**

Create `src/content/youtubeSubtitle/overlay.ts`:

```ts
type OverlayRenderInput = {
  sourceText: string;
  translatedText?: string;
  state: "loading" | "translated" | "failed";
};

function createLine(className: string, text: string): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  line.style.margin = "0";
  line.style.display = "-webkit-box";
  line.style.webkitLineClamp = "2";
  line.style.webkitBoxOrient = "vertical";
  line.style.overflow = "hidden";
  return line;
}

export function createSubtitleOverlay(player: HTMLElement) {
  const root = document.createElement("div");
  root.dataset.yoyoYoutubeSubtitleOverlay = "true";
  root.className = "notranslate";
  root.setAttribute("translate", "no");
  Object.assign(root.style, {
    position: "absolute",
    left: "50%",
    bottom: "12%",
    transform: "translateX(-50%)",
    maxWidth: "82%",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "rgba(0, 0, 0, 0.62)",
    color: "#fff",
    textAlign: "center",
    pointerEvents: "none",
    zIndex: "2147483647",
    fontSize: "16px",
    lineHeight: "1.35",
  });
  player.style.position ||= "relative";
  player.appendChild(root);

  function render(input: OverlayRenderInput): void {
    const translated =
      input.state === "failed"
        ? "Translation failed"
        : input.translatedText ?? "Translating...";
    const source = createLine("yoyo-youtube-subtitle-source", input.sourceText);
    const translation = createLine("yoyo-youtube-subtitle-translation", translated);
    translation.style.color = input.state === "failed" ? "#fca5a5" : "#bbf7d0";
    root.replaceChildren(source, translation);
  }

  function hide(): void {
    root.replaceChildren();
  }

  function destroy(): void {
    root.remove();
  }

  return { render, hide, destroy };
}
```

- [ ] **Step 5: Implement player button**

Create `src/content/youtubeSubtitle/playerButton.ts`:

```ts
export type SubtitleButtonStatus = "enabled" | "disabled" | "warning" | "loading";

type ButtonOptions = {
  status: SubtitleButtonStatus;
  onToggle: () => void;
};

function badgeText(status: SubtitleButtonStatus): string {
  switch (status) {
    case "enabled":
      return "✓";
    case "disabled":
      return "×";
    case "warning":
      return "!";
    case "loading":
      return "•";
  }
}

function badgeColor(status: SubtitleButtonStatus): string {
  switch (status) {
    case "enabled":
      return "#22c55e";
    case "disabled":
      return "#ef4444";
    case "warning":
      return "#f59e0b";
    case "loading":
      return "#9ca3af";
  }
}

function applyButtonContent(button: HTMLButtonElement, status: SubtitleButtonStatus): void {
  const mark = document.createElement("span");
  mark.textContent = "文";
  Object.assign(mark.style, {
    color: "#fff9ef",
    fontWeight: "900",
    fontSize: "20px",
    lineHeight: "1",
  });

  const badge = document.createElement("span");
  badge.dataset.yoyoSubtitleBadge = "true";
  badge.textContent = badgeText(status);
  Object.assign(badge.style, {
    position: "absolute",
    right: "-4px",
    top: "-4px",
    width: "16px",
    height: "16px",
    borderRadius: "999px",
    background: badgeColor(status),
    color: "white",
    fontSize: "11px",
    lineHeight: "16px",
    textAlign: "center",
    border: "2px solid #050505",
  });

  button.replaceChildren(mark, badge);
}

export function mountSubtitlePlayerButton(container: HTMLElement, options: ButtonOptions) {
  let button = container.querySelector<HTMLButtonElement>(
    "[data-yoyo-youtube-subtitle-button]",
  );

  if (!button) {
    button = document.createElement("button");
    button.dataset.yoyoYoutubeSubtitleButton = "true";
    button.type = "button";
    button.title = "Yoyo subtitle translation";
    Object.assign(button.style, {
      position: "relative",
      width: "36px",
      height: "36px",
      border: "0",
      borderRadius: "9px",
      margin: "0 6px",
      background: "linear-gradient(135deg,#0ea558,#43d35e 56%,#b6ea2c)",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
    });
    container.appendChild(button);
  }

  button.onclick = options.onToggle;
  applyButtonContent(button, options.status);

  return {
    element: button,
    update(nextOptions: ButtonOptions): void {
      button.onclick = nextOptions.onToggle;
      applyButtonContent(button, nextOptions.status);
    },
    destroy(): void {
      button.remove();
    },
  };
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/overlay.test.ts tests/content/youtubeSubtitle/playerButton.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/content/youtubeSubtitle/overlay.ts src/content/youtubeSubtitle/playerButton.ts tests/content/youtubeSubtitle/overlay.test.ts tests/content/youtubeSubtitle/playerButton.test.ts
git commit -m "Add YouTube subtitle overlay and player button"
```

---

### Task 6: Content Runtime Wiring

**Files:**
- Create: `src/content/youtubeSubtitle/runtime.ts`
- Modify: `entrypoints/content.ts`
- Create: `tests/content/youtubeSubtitle/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/content/youtubeSubtitle/runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createYouTubeSubtitleRuntime } from "@/content/youtubeSubtitle/runtime";

describe("createYouTubeSubtitleRuntime", () => {
  it("mounts a player button once and toggles stored preference", async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video></video>
        <div class="ytp-right-controls"></div>
      </div>
    `;
    const savePreferences = vi.fn();
    const runtime = createYouTubeSubtitleRuntime({
      loadPreferences: vi.fn(async () => ({
        schemaVersion: 1,
        youtubeEnabled: true,
        aiSegmentationEnabled: false,
        prefetchBeforeMs: 2000,
        prefetchAfterMs: 90000,
        maxRetryCount: 2,
      })),
      savePreferences,
      sendBackgroundMessage: vi.fn(),
      fetchCaptionPayload: vi.fn(),
      now: () => 0,
    });

    await runtime.start();
    await runtime.start();
    expect(document.querySelectorAll("[data-yoyo-youtube-subtitle-button]")).toHaveLength(1);

    document.querySelector<HTMLButtonElement>("[data-yoyo-youtube-subtitle-button]")?.click();
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ youtubeEnabled: false }),
    );
  });

  it("destroys overlay and cancels requests on stop", async () => {
    const sendBackgroundMessage = vi.fn();
    const runtime = createYouTubeSubtitleRuntime({
      loadPreferences: vi.fn(async () => ({
        schemaVersion: 1,
        youtubeEnabled: true,
        aiSegmentationEnabled: false,
        prefetchBeforeMs: 2000,
        prefetchAfterMs: 90000,
        maxRetryCount: 2,
      })),
      savePreferences: vi.fn(),
      sendBackgroundMessage,
      fetchCaptionPayload: vi.fn(),
      now: () => 0,
    });

    await runtime.start();
    runtime.stop("pageUnloaded");

    expect(sendBackgroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancelSubtitleRequests" }),
    );
  });
});
```

- [ ] **Step 2: Run runtime tests and verify failure**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/runtime.test.ts
```

Expected: FAIL because runtime module does not exist.

- [ ] **Step 3: Implement minimal runtime**

Create `src/content/youtubeSubtitle/runtime.ts`:

```ts
import { mountSubtitlePlayerButton, type SubtitleButtonStatus } from "@/content/youtubeSubtitle/playerButton";
import { createSubtitleOverlay } from "@/content/youtubeSubtitle/overlay";
import type { BackgroundRequest, BackgroundResponse } from "@/messaging/contracts";
import type { SubtitlePreferences } from "@/subtitle/types";

type RuntimeDependencies = {
  loadPreferences: () => Promise<SubtitlePreferences>;
  savePreferences: (preferences: SubtitlePreferences) => Promise<void>;
  sendBackgroundMessage: (message: BackgroundRequest) => Promise<BackgroundResponse>;
  fetchCaptionPayload: (url: string) => Promise<unknown>;
  now: () => number;
};

type StopReason = "userDisabled" | "videoChanged" | "configChanged" | "pageUnloaded";

function createRuntimeSessionId(): string {
  return `youtube-subtitle-${Date.now()}-${crypto.randomUUID()}`;
}

function findPlayer(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>("#movie_player") ?? undefined;
}

function findControls(player: HTMLElement): HTMLElement | undefined {
  return player.querySelector<HTMLElement>(".ytp-right-controls") ?? undefined;
}

export function createYouTubeSubtitleRuntime(dependencies: RuntimeDependencies) {
  let preferences: SubtitlePreferences | undefined;
  let runtimeSessionId = createRuntimeSessionId();
  let configVersion = 1;
  let button:
    | ReturnType<typeof mountSubtitlePlayerButton>
    | undefined;
  let overlay: ReturnType<typeof createSubtitleOverlay> | undefined;
  let observer: MutationObserver | undefined;

  function statusForPreference(): SubtitleButtonStatus {
    return preferences?.youtubeEnabled ? "loading" : "disabled";
  }

  function mount(): void {
    const player = findPlayer();
    if (!player) {
      return;
    }
    const controls = findControls(player);
    if (!controls) {
      return;
    }
    button = mountSubtitlePlayerButton(controls, {
      status: statusForPreference(),
      onToggle: () => {
        void toggleEnabled();
      },
    });
    overlay ??= createSubtitleOverlay(player);
  }

  async function toggleEnabled(): Promise<void> {
    if (!preferences) {
      return;
    }
    preferences = {
      ...preferences,
      youtubeEnabled: !preferences.youtubeEnabled,
    };
    await dependencies.savePreferences(preferences);
    configVersion += 1;
    if (!preferences.youtubeEnabled) {
      stop("userDisabled");
    } else {
      runtimeSessionId = createRuntimeSessionId();
      mount();
    }
    button?.update({
      status: preferences.youtubeEnabled ? "enabled" : "disabled",
      onToggle: () => {
        void toggleEnabled();
      },
    });
  }

  async function start(): Promise<void> {
    preferences = await dependencies.loadPreferences();
    mount();
    observer ??= new MutationObserver(() => mount());
    observer.observe(document.body, { childList: true, subtree: true });
    button?.update({
      status: preferences.youtubeEnabled ? "enabled" : "disabled",
      onToggle: () => {
        void toggleEnabled();
      },
    });
  }

  function stop(reason: StopReason): void {
    overlay?.destroy();
    overlay = undefined;
    void dependencies.sendBackgroundMessage({
      type: "cancelSubtitleRequests",
      runtimeSessionId,
      reason,
    });
    runtimeSessionId = createRuntimeSessionId();
    configVersion += 1;
  }

  function destroy(): void {
    observer?.disconnect();
    observer = undefined;
    button?.destroy();
    button = undefined;
    stop("pageUnloaded");
  }

  return { start, stop, destroy };
}
```

- [ ] **Step 4: Wire content entrypoint**

Modify `entrypoints/content.ts` imports:

```ts
import { createYouTubeSubtitleRuntime } from "@/content/youtubeSubtitle/runtime";
import { createStorageRepositories } from "@/storage/repositories";
import { sendRuntimeMessage } from "@/messaging/runtime";
```

Inside `main()`, after `console.info`:

```ts
const storage = createStorageRepositories();
const youtubeSubtitleRuntime = createYouTubeSubtitleRuntime({
  loadPreferences: () => storage.subtitlePreferences.get(),
  savePreferences: (preferences) => storage.subtitlePreferences.save(preferences),
  sendBackgroundMessage: (message) =>
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message),
  fetchCaptionPayload: async (url) => fetch(url).then((response) => response.json()),
  now: () => Date.now(),
});

if (location.hostname === "www.youtube.com") {
  void youtubeSubtitleRuntime.start();
  window.addEventListener("pagehide", () => youtubeSubtitleRuntime.destroy(), {
    once: true,
  });
}
```

If import name conflicts occur because `sendRuntimeMessage` already exists in `pageRuntime.ts`, keep the content entrypoint import explicit and use it only in this block.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/runtime.test.ts tests/content/youtubeSubtitle/playerButton.test.ts tests/content/youtubeSubtitle/overlay.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/content/youtubeSubtitle/runtime.ts entrypoints/content.ts tests/content/youtubeSubtitle/runtime.test.ts
git commit -m "Wire YouTube subtitle content runtime"
```

---

### Task 7: AI Segmentation Service

**Files:**
- Create: `src/background/youtubeSubtitle/aiSegmentation.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/subtitle/segmentationValidation.ts`
- Create: `tests/background/youtubeSubtitle/aiSegmentation.test.ts`

- [ ] **Step 1: Write failing AI segmentation tests**

Create `tests/background/youtubeSubtitle/aiSegmentation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAiSubtitleSegmentationService } from "@/background/youtubeSubtitle/aiSegmentation";
import type { ProviderProfile } from "@/provider/types";

const profile: ProviderProfile = {
  id: "provider-1",
  displayName: "Provider",
  type: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "secret",
  textModel: "gpt-5-mini",
};

describe("createAiSubtitleSegmentationService", () => {
  it("returns validated AI segments", async () => {
    const service = createAiSubtitleSegmentationService({
      getActiveProfile: vi.fn(async () => profile),
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          segments: [
            {
              sourceCueIds: ["cue-0", "cue-1"],
              translatedText: "你好，世界。",
            },
          ],
        }),
      })),
    });

    const response = await service.segmentChunk({
      type: "segmentSubtitleChunk",
      runtimeSessionId: "runtime-1",
      configVersion: 1,
      requestId: "request-1",
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: { kind: "known", code: "en" },
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "gpt-5-mini",
      segmentationPromptVersion: "subtitle-segmentation-v1",
      segmentationVersion: "ai-v1",
      sourceCues: [
        { cueId: "cue-0", index: 0, startMs: 0, endMs: 500, text: "Hello" },
        { cueId: "cue-1", index: 1, startMs: 500, endMs: 1000, text: "world." },
      ],
    });

    expect(response).toMatchObject({
      type: "segmentSubtitleChunkResult",
      segments: [
        expect.objectContaining({
          sourceCueIds: ["cue-0", "cue-1"],
          translatedText: "你好，世界。",
        }),
      ],
    });
  });

  it("returns fallback errors for invalid AI coverage", async () => {
    const service = createAiSubtitleSegmentationService({
      getActiveProfile: vi.fn(async () => profile),
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          segments: [{ sourceCueIds: ["missing-cue"], translatedText: "Bad" }],
        }),
      })),
    });

    const response = await service.segmentChunk({
      type: "segmentSubtitleChunk",
      runtimeSessionId: "runtime-1",
      configVersion: 1,
      requestId: "request-1",
      videoId: "video-1",
      trackKey: "track-1",
      sourceLanguage: { kind: "known", code: "en" },
      targetLanguage: "zh-CN",
      providerId: "provider-1",
      modelKey: "gpt-5-mini",
      segmentationPromptVersion: "subtitle-segmentation-v1",
      segmentationVersion: "ai-v1",
      sourceCues: [{ cueId: "cue-0", index: 0, startMs: 0, endMs: 500, text: "Hello" }],
    });

    expect(response).toMatchObject({
      type: "segmentSubtitleChunkError",
      fallbackRequired: true,
    });
  });
});
```

- [ ] **Step 2: Run AI segmentation tests and verify failure**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/aiSegmentation.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement AI segmentation service**

Create `src/background/youtubeSubtitle/aiSegmentation.ts`:

```ts
import { validateSubtitleSegments } from "@/subtitle/segmentationValidation";
import { hashSubtitleText } from "@/subtitle/hash";
import type { BackgroundRequest, BackgroundResponse } from "@/messaging/contracts";
import type { GenerateTextResponse, ProviderProfile } from "@/provider/types";

type SegmentSubtitleChunkRequest = Extract<
  BackgroundRequest,
  { type: "segmentSubtitleChunk" }
>;

type Dependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  generateText: (input: {
    profile: ProviderProfile;
    prompt: string;
    abortSignal?: AbortSignal;
  }) => Promise<GenerateTextResponse>;
};

type AiSegment = {
  sourceCueIds?: string[];
  translatedText?: string;
};

function buildPrompt(request: SegmentSubtitleChunkRequest): string {
  return [
    "Group the input subtitle cues into readable bilingual subtitle segments.",
    `Target language: ${request.targetLanguage}`,
    "Return JSON only: {\"segments\":[{\"sourceCueIds\":[\"cue-0\"],\"translatedText\":\"...\"}]}",
    "Use only cue ids from the input. Do not invent timestamps.",
    JSON.stringify({ cues: request.sourceCues }),
  ].join("\n");
}

function parseAiSegments(text: string): AiSegment[] {
  const parsed = JSON.parse(text) as { segments?: AiSegment[] };
  return Array.isArray(parsed.segments) ? parsed.segments : [];
}

export function createAiSubtitleSegmentationService(dependencies: Dependencies) {
  async function segmentChunk(
    request: SegmentSubtitleChunkRequest,
  ): Promise<BackgroundResponse> {
    try {
      const profile = await dependencies.getActiveProfile();
      if (!profile) {
        throw new Error("No translation provider is configured.");
      }

      const response = await dependencies.generateText({
        profile,
        prompt: buildPrompt(request),
      });
      const cueById = new Map(request.sourceCues.map((cue) => [cue.cueId, cue]));
      const segments = parseAiSegments(response.text).map((item, index) => {
        const sourceCueIds = item.sourceCueIds ?? [];
        const cues = sourceCueIds.map((cueId) => cueById.get(cueId));
        if (cues.some((cue) => cue === undefined)) {
          throw new Error("AI segmentation referenced unknown cue ids.");
        }
        const definedCues = cues as NonNullable<(typeof cues)[number]>[];
        const first = definedCues[0];
        const last = definedCues.at(-1);
        if (!first || !last) {
          throw new Error("AI segmentation returned an empty segment.");
        }
        const sourceText = definedCues.map((cue) => cue.text).join(" ");
        return {
          segmentId: `ai-${first.index}-${last.index}-${hashSubtitleText(sourceText)}`,
          sourceCueIds,
          sourceCueStartIndex: first.index,
          sourceCueEndIndex: last.index,
          startMs: first.startMs,
          endMs: last.endMs,
          sourceText,
          textHash: hashSubtitleText(sourceText),
          translatedText: item.translatedText,
        };
      });

      const validation = validateSubtitleSegments(request.sourceCues, segments);
      if (!validation.valid) {
        throw new Error(validation.reason);
      }

      return {
        type: "segmentSubtitleChunkResult",
        runtimeSessionId: request.runtimeSessionId,
        configVersion: request.configVersion,
        requestId: request.requestId,
        segments,
      };
    } catch (error) {
      return {
        type: "segmentSubtitleChunkError",
        runtimeSessionId: request.runtimeSessionId,
        configVersion: request.configVersion,
        requestId: request.requestId,
        message: error instanceof Error ? error.message : "AI segmentation failed.",
        fallbackRequired: true,
      };
    }
  }

  return { segmentChunk };
}
```

- [ ] **Step 4: Wire background AI segmentation**

In `entrypoints/background.ts`, import and create the service:

```ts
import { createAiSubtitleSegmentationService } from "@/background/youtubeSubtitle/aiSegmentation";

const aiSubtitleSegmentationService = createAiSubtitleSegmentationService({
  getActiveProfile,
  generateText: (input) => provider.generateText(input),
});
```

Add case:

```ts
case "segmentSubtitleChunk":
  return aiSubtitleSegmentationService.segmentChunk(request);
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/aiSegmentation.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add src/background/youtubeSubtitle/aiSegmentation.ts entrypoints/background.ts tests/background/youtubeSubtitle/aiSegmentation.test.ts
git commit -m "Add AI subtitle segmentation service"
```

---

### Task 8: Browser Fixture Automation and Verification Script

**Files:**
- Create: `tests/browser/youtube-subtitle-fixture.mjs`
- Create: `tests/browser/youtube-subtitle.spec.mjs`
- Create: `scripts/test-browser.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing browser test runner script**

Create `tests/browser/youtube-subtitle-fixture.mjs`:

```js
import { createServer } from "node:http";

export function createYouTubeSubtitleFixtureServer() {
  const html = `<!doctype html>
    <html>
      <body>
        <div id="movie_player">
          <video></video>
          <div class="ytp-right-controls"></div>
        </div>
      </body>
    </html>`;

  const timedText = {
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "world." }] },
    ],
  };

  const server = createServer((request, response) => {
    if (request.url === "/api/timedtext") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(timedText));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/watch?v=fixture`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
```

Create `tests/browser/youtube-subtitle.spec.mjs`:

```js
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { createYouTubeSubtitleFixtureServer } from "./youtube-subtitle-fixture.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const fixture = await createYouTubeSubtitleFixtureServer();
  const userDataDir = resolve(".tmp/yoyo-browser-test-profile");
  const extensionPath = resolve("build/chrome-mv3");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    await page.waitForSelector("[data-yoyo-youtube-subtitle-button]", {
      timeout: 10000,
    });
    const buttonCount = await page.locator("[data-yoyo-youtube-subtitle-button]").count();
    assert(buttonCount === 1, `Expected one subtitle button, got ${buttonCount}.`);

    await page.locator("[data-yoyo-youtube-subtitle-button]").click();
    const badgeText = await page.locator("[data-yoyo-subtitle-badge]").innerText();
    assert(badgeText === "×", `Expected disabled badge, got ${badgeText}.`);
  } finally {
    await context.close();
    await fixture.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Create `scripts/test-browser.mjs`:

```js
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
    child.on("error", reject);
  });
}

await run("pnpm", ["build"]);
await run("node", ["tests/browser/youtube-subtitle.spec.mjs"]);
```

Modify `package.json` scripts:

```json
"test:browser": "node scripts/test-browser.mjs"
```

- [ ] **Step 2: Add narrow fixture activation before running the browser test**

Modify `entrypoints/content.ts` to use a narrow test predicate:

```ts
function isYouTubeSubtitleRuntimeAllowed(): boolean {
  return (
    location.hostname === "www.youtube.com" ||
    location.search.includes("yoyoSubtitleFixture=1")
  );
}
```

Change the runtime start guard to:

```ts
if (isYouTubeSubtitleRuntimeAllowed()) {
  void youtubeSubtitleRuntime.start();
  window.addEventListener("pagehide", () => youtubeSubtitleRuntime.destroy(), {
    once: true,
  });
}
```

Update the browser fixture URL in `tests/browser/youtube-subtitle-fixture.mjs`:

```js
url: `http://127.0.0.1:${address.port}/watch?v=fixture&yoyoSubtitleFixture=1`,
```

Use this predicate only for test activation. Caption track fetching in production still requires explicit YouTube track parsing; fixture-specific data stays in the browser test server.

- [ ] **Step 3: Run browser test and verify fixture coverage**

Run:

```bash
pnpm test:browser
```

Expected: FAIL with a timeout waiting for `[data-yoyo-youtube-subtitle-overlay]` when overlay rendering is not wired to the fixture yet. The button mount assertion passes before adding overlay assertions.

- [ ] **Step 4: Extend browser assertions**

Update `tests/browser/youtube-subtitle.spec.mjs` after the disabled badge assertion:

```js
await page.locator("[data-yoyo-youtube-subtitle-button]").click();
await page.waitForFunction(() => {
  const badge = document.querySelector("[data-yoyo-subtitle-badge]");
  return badge?.textContent === "✓" || badge?.textContent === "•";
});
const overlay = page.locator("[data-yoyo-youtube-subtitle-overlay]");
await overlay.waitFor({ timeout: 10000 });
const translateAttr = await overlay.getAttribute("translate");
const className = await overlay.getAttribute("class");
const pointerEvents = await overlay.evaluate((node) =>
  getComputedStyle(node).pointerEvents,
);
assert(translateAttr === "no", "Overlay must set translate=no.");
assert(className.includes("notranslate"), "Overlay must use notranslate.");
assert(pointerEvents === "none", "Overlay must not intercept pointer events.");
```

- [ ] **Step 5: Run browser test, full verification, and commit**

Run:

```bash
pnpm test:browser
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:extension
```

Expected: PASS.

Commit:

```bash
git add tests/browser scripts/test-browser.mjs package.json src/content/youtubeSubtitle/runtime.ts entrypoints/content.ts
git commit -m "Add automated browser coverage for YouTube subtitles"
```

---

## Final Verification

After all tasks are complete, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:browser
pnpm verify:extension
git status --short
```

Expected:

- Typecheck passes.
- Lint passes.
- Vitest passes.
- Browser fixture test passes.
- Extension smoke verification passes.
- `git status --short` shows no unexpected uncommitted changes.

## Self-Review Notes

- Spec coverage: tasks cover shared protocol, storage, parser, track selection, segmentation, scheduler, cache, background service, AI fallback, button, overlay, content runtime, and automated browser fixture tests.
- Placeholder scan: plan contains no deferred implementation markers.
- Type consistency: subtitle fields use `sourceCueIds`, `runtimeSessionId`, `configVersion`, `requestId`, `modelKey`, `promptVersion`, `segmentationVersion`, and `translationMode` consistently across protocol, cache, and tests.
