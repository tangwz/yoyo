# P1 Provider Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden provider batch execution so streaming, buffered fallback, missing-item retry, cache fan-out, cancellation, rate limiting, and privacy traces remain deterministic.

**Architecture:** Keep `TranslationTaskOrchestrator` as the background execution boundary and keep provider adapters thin. The orchestrator owns concurrency, retry/degrade, fan-out cache, cancellation, and progress; `OpenAiTranslationAdapter` owns prompt construction and JSON/NDJSON parsing. This plan adds missing boundary tests first, then applies small fixes only where behavior is not already covered.

**Tech Stack:** TypeScript, Vitest, WXT background runtime, OpenAI-compatible adapter, existing provider abstractions.

---

## Scope Check

This plan covers only P1 from the milestone spec:

- `src/background/taskOrchestrator.ts`
- `src/provider/openAiTranslationAdapter.ts`
- `src/translation/jsonResult.ts`
- `src/translation/hash.ts`
- provider pipeline tests

It does not change dynamic page DOM extraction or YouTube subtitle runtime. If a P1 fix exposes a content-runtime contract issue, capture it as a follow-up to P0 rather than broadening this plan.

## File Structure

- Modify: `tests/background/taskOrchestrator.test.ts`  
  Adds orchestrator-level regressions for partial streaming errors, stale cancellation, duplicate item filtering, cache fan-out privacy, and rate-limit recovery.

- Modify: `tests/provider/openAiTranslationAdapter.test.ts`  
  Adds adapter-level regressions for malformed streaming lines, duplicate streaming records, unknown ids, and invalid SSE errors.

- Modify: `tests/translation/jsonResult.test.ts`  
  Adds parser-level regressions for partial NDJSON and malformed lines.

- Potentially modify: `src/background/taskOrchestrator.ts`  
  Only if new orchestrator tests fail. Likely changes are in `requestAndApplyStreamingBatch`, `filterBatchItems`, or cancellation checks after apply.

- Potentially modify: `src/provider/openAiTranslationAdapter.ts` or `src/translation/jsonResult.ts`  
  Only if parser/adapter tests expose duplicate or malformed stream handling gaps.

## Task 1: Add Streaming Partial-Failure Orchestrator Coverage

**Files:**
- Modify: `tests/background/taskOrchestrator.test.ts`
- Potentially modify: `src/background/taskOrchestrator.ts`

- [ ] **Step 1: Add a failing test for partial streaming error recovery**

Insert this test near the existing streaming tests in `tests/background/taskOrchestrator.test.ts`:

```ts
  it("keeps streamed applied items and retries only missing segments after a stream error", async () => {
    const streamBatch = vi.fn(async function* () {
      yield {
        items: [{ segmentId: "segment-1", translatedText: "一。" }],
      };
      throw new Error("stream interrupted");
    });
    const translateBatch = vi.fn(async () => ({
      items: [{ segmentId: "segment-2", translatedText: "二。" }],
    }));
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({
        translateText: vi.fn(),
        translateBatch,
        streamBatch,
      }),
    });
    const applied: string[] = [];

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [
            segment({ id: "segment-1", sourceText: "One." }),
            segment({
              id: "segment-2",
              order: 2,
              sourceText: "Two.",
              textHash: "hash-2",
            }),
          ],
        };
      }

      if (message.type !== "applyTranslations") {
        throw new Error(`Unexpected content message: ${message.type}`);
      }

      applied.push(...message.items.map((item) => item.segmentId));
      return { type: "contentActionResult", success: true };
    });

    const progress = await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(streamBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].segments.map((item) => item.id)).toEqual([
      "segment-2",
    ]);
    expect(applied).toEqual(["segment-1", "segment-2"]);
    expect(progress).toMatchObject({
      state: "completed",
      translated: 2,
      failed: 0,
    });
  });
```

- [ ] **Step 2: Run the targeted orchestrator test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "keeps streamed applied items"
```

Expected before implementation: PASS if current streaming partial-error handling is already correct; otherwise FAIL by retrying all segments or marking the task failed.

- [ ] **Step 3: Apply the minimal orchestrator fix if needed**

If the test retries already-applied streamed segments, update `requestAndApplyStreamingBatch` in `src/background/taskOrchestrator.ts` so the catch branch returns only unapplied representatives:

```ts
      return {
        batchId: input.batchId,
        missingSegments: input.segments.filter(
          (segment) => !appliedRepresentativeIds.has(segment.id),
        ),
        error,
      };
```

If this code already exists, do not change it.

- [ ] **Step 4: Re-run the targeted test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "keeps streamed applied items"
```

Expected: PASS.

- [ ] **Step 5: Commit the partial streaming coverage**

Run:

```bash
git add tests/background/taskOrchestrator.test.ts src/background/taskOrchestrator.ts
git commit -m "Cover partial streaming retry behavior"
```

If `src/background/taskOrchestrator.ts` did not change, stage only the test file.

## Task 2: Add Adapter Streaming Parser Boundary Coverage

**Files:**
- Modify: `tests/provider/openAiTranslationAdapter.test.ts`
- Modify: `tests/translation/jsonResult.test.ts`
- Potentially modify: `src/translation/jsonResult.ts`

- [ ] **Step 1: Add adapter tests for duplicate and unknown streaming records**

Append these tests near the existing streaming adapter tests:

```ts
  it("ignores unknown and duplicate streaming records while preserving valid order", async () => {
    const generateText = vi.fn();
    const streamText = vi.fn<(request: StreamTextRequest) => AsyncGenerator<{ text: string }>>(
      () =>
        streamTextChunks([
          '{"id":"segment-unknown","text":"Ignore me."}\n',
          '{"id":"segment-1","text":"你好。"}\n',
          '{"id":"segment-1","text":"Duplicate should be ignored."}\n',
          '{"id":"segment-2","text":"早上好。"}\n',
        ]),
    );
    const adapter = new OpenAiTranslationAdapter({ generateText, streamText });
    const responses = [];

    for await (const response of adapter.streamBatch({
      profile: profile(),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      segments: [
        segment("segment-1", "Hello."),
        segment("segment-2", "Good morning."),
      ],
    })) {
      responses.push(response);
    }

    expect(responses).toEqual([
      { items: [{ segmentId: "segment-1", translatedText: "你好。" }] },
      { items: [{ segmentId: "segment-2", translatedText: "早上好。" }] },
    ]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("continues streaming after malformed records and reports only valid items", async () => {
    const generateText = vi.fn();
    const streamText = vi.fn<(request: StreamTextRequest) => AsyncGenerator<{ text: string }>>(
      () =>
        streamTextChunks([
          '{"id":"segment-1","text":"你好。"}\n',
          '{"id":"segment-2","text":\n',
          '{"id":"segment-2","text":"早上好。"}\n',
        ]),
    );
    const adapter = new OpenAiTranslationAdapter({ generateText, streamText });
    const responses = [];

    for await (const response of adapter.streamBatch({
      profile: profile(),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      segments: [
        segment("segment-1", "Hello."),
        segment("segment-2", "Good morning."),
      ],
    })) {
      responses.push(response);
    }

    expect(responses).toEqual([
      { items: [{ segmentId: "segment-1", translatedText: "你好。" }] },
      { items: [{ segmentId: "segment-2", translatedText: "早上好。" }] },
    ]);
  });
```

- [ ] **Step 2: Add parser-level tests**

Add these tests in `tests/translation/jsonResult.test.ts` inside `describe("streaming translation JSONL parser", () => { ... })`:

```ts
  it("recovers after malformed JSONL records", () => {
    const parser = createStreamingTranslationResultParser(["a", "b"]);

    expect(parser.push('{"id":"a","text":"A"}\n{"id":"b","text":\n')).toEqual([
      { segmentId: "a", translatedText: "A" },
    ]);
    expect(parser.push('{"id":"b","text":"B"}\n')).toEqual([
      { segmentId: "b", translatedText: "B" },
    ]);
    expect(parser.finish()).toEqual({
      items: [],
      missingSegmentIds: [],
    });
  });

  it("does not emit duplicate streaming records", () => {
    const parser = createStreamingTranslationResultParser(["a"]);

    expect(parser.push('{"id":"a","text":"A"}\n')).toEqual([
      { segmentId: "a", translatedText: "A" },
    ]);
    expect(parser.push('{"id":"a","text":"Duplicate"}\n')).toEqual([]);
    expect(parser.finish()).toEqual({
      items: [],
      missingSegmentIds: [],
    });
  });
```

- [ ] **Step 3: Run adapter and parser tests**

Run:

```bash
pnpm vitest run tests/provider/openAiTranslationAdapter.test.ts tests/translation/jsonResult.test.ts
```

Expected before implementation: PASS if parser already ignores bad/unknown/duplicate records correctly; otherwise FAIL with duplicate emissions or thrown malformed-record errors.

- [ ] **Step 4: Apply the minimal parser fix if needed**

If malformed JSONL throws or stops the parser, update `createStreamingTranslationResultParser` in `src/translation/jsonResult.ts` so invalid complete lines are ignored and parsing continues. The parser should keep a `seenIds` set and only emit records that pass all checks:

```ts
      if (!expectedSegmentIds.has(parsed.id) || seenIds.has(parsed.id)) {
        continue;
      }
      seenIds.add(parsed.id);
      items.push({
        segmentId: parsed.id,
        translatedText: parsed.text,
      });
```

If equivalent logic already exists, do not change it.

- [ ] **Step 5: Re-run adapter and parser tests**

Run:

```bash
pnpm vitest run tests/provider/openAiTranslationAdapter.test.ts tests/translation/jsonResult.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit parser boundary coverage**

Run:

```bash
git add tests/provider/openAiTranslationAdapter.test.ts tests/translation/jsonResult.test.ts src/translation/jsonResult.ts
git commit -m "Cover streaming parser boundaries"
```

If `src/translation/jsonResult.ts` did not change, stage only the tests.

## Task 3: Add Cache Fan-Out And Privacy Regression Coverage

**Files:**
- Modify: `tests/background/taskOrchestrator.test.ts`
- Potentially modify: `src/background/taskOrchestrator.ts`

- [ ] **Step 1: Add a cache fan-out regression test**

Insert this test near existing cache/fan-out orchestrator tests:

```ts
  it("translates repeated source text once and fans out cached results without leaking private text", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const privateSource = "Private repeated source.";
    const privateTranslation = "Private repeated translation.";
    const translateBatch = vi.fn(async () => ({
      items: [{ segmentId: "segment-1", translatedText: privateTranslation }],
    }));
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    });
    const applied: Array<{ segmentId: string; translatedText: string }> = [];

    try {
      sendToContent.mockImplementation(async (_tabId, message) => {
        if (message.type === "collectSegments") {
          return {
            type: "collectSegmentsResult",
            taskId: message.taskId,
            segments: [
              segment({ id: "segment-1", sourceText: privateSource, textHash: "same-hash" }),
              segment({
                id: "segment-2",
                order: 2,
                sourceText: privateSource,
                textHash: "same-hash",
              }),
            ],
          };
        }

        if (message.type !== "applyTranslations") {
          throw new Error(`Unexpected content message: ${message.type}`);
        }

        applied.push(...message.items);
        return { type: "contentActionResult", success: true };
      });

      await expect(
        orchestrator.translatePage({
          tabId: 7,
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        }),
      ).resolves.toMatchObject({
        state: "completed",
        translated: 2,
        failed: 0,
      });

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(translateBatch.mock.calls[0]?.[0].segments.map((item) => item.id)).toEqual([
        "segment-1",
      ]);
      expect(applied).toEqual([
        { segmentId: "segment-1", translatedText: privateTranslation },
        { segmentId: "segment-2", translatedText: privateTranslation },
      ]);
      const output = renderedConsoleOutput(infoSpy.mock.calls);
      expect(output).not.toContain(privateSource);
      expect(output).not.toContain(privateTranslation);
    } finally {
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
```

- [ ] **Step 2: Run the targeted fan-out test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "translates repeated source text once"
```

Expected before implementation: PASS if cache fan-out and trace privacy are already correct; otherwise FAIL by calling the provider twice, applying only one segment, or leaking private text in traces.

- [ ] **Step 3: Apply the minimal fan-out fix if needed**

If provider calls include both repeated segments, inspect `processSegmentsForTask` and ensure uncached representatives are grouped by serialized cache key before batching. The grouping must map one representative id to every segment in the group:

```ts
      const existingGroup = uncachedGroups.get(serializedKey);
      if (existingGroup) {
        existingGroup.push(segment);
      } else {
        const group = [segment];
        uncachedGroups.set(serializedKey, group);
        uncachedRepresentatives.push(segment);
      }
```

If equivalent logic already exists, do not change it.

- [ ] **Step 4: Re-run the targeted fan-out test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "translates repeated source text once"
```

Expected: PASS.

- [ ] **Step 5: Commit fan-out coverage**

Run:

```bash
git add tests/background/taskOrchestrator.test.ts src/background/taskOrchestrator.ts
git commit -m "Cover provider cache fan-out privacy"
```

If `src/background/taskOrchestrator.ts` did not change, stage only the test.

## Task 4: Add Cancellation And Stale Result Coverage

**Files:**
- Modify: `tests/background/taskOrchestrator.test.ts`
- Potentially modify: `src/background/taskOrchestrator.ts`

- [ ] **Step 1: Add a stale apply cancellation test**

Insert this test near cancellation tests:

```ts
  it("ignores provider results that resolve after task cancellation", async () => {
    vi.useFakeTimers();
    let resolveProvider:
      | ((value: { items: Array<{ segmentId: string; translatedText: string }> }) => void)
      | undefined;
    const translateBatch = vi.fn(
      () =>
        new Promise<{ items: Array<{ segmentId: string; translatedText: string }> }>(
          (resolve) => {
            resolveProvider = resolve;
          },
        ),
    );
    const { orchestrator, sendToContent } = createOrchestrator({
      getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
    });

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          segments: [segment({ id: "segment-1", sourceText: "One." })],
        };
      }

      if (message.type === "applyTranslations") {
        throw new Error("Stale provider result should not be applied.");
      }

      return { type: "contentActionResult", success: true };
    });

    const running = orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    await vi.waitFor(() => {
      expect(translateBatch).toHaveBeenCalledTimes(1);
    });
    const taskId = orchestrator.getTaskForTab(7)?.taskId;
    if (!taskId) {
      throw new Error("Expected running task.");
    }
    await orchestrator.cancelTask(taskId, "userCancelled");
    resolveProvider?.({
      items: [{ segmentId: "segment-1", translatedText: "Stale translation." }],
    });

    await expect(running).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(sendToContent).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "applyTranslations" }),
    );
  });
```

- [ ] **Step 2: Run the targeted cancellation test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "ignores provider results"
```

Expected before implementation: PASS if cancellation checks already guard stale provider results; otherwise FAIL by sending `applyTranslations`.

- [ ] **Step 3: Apply the minimal cancellation fix if needed**

If stale results are applied after cancellation, add `this.isTaskStopped(input.task)` checks immediately after provider responses and before `applyTranslations` in `requestAndApplyBufferedBatch` and `requestAndApplyStreamingBatch`.

The buffered guard should look like:

```ts
    if (this.isTaskStopped(input.task)) {
      this.traceBatchAborted(input, attempt, startedAt);
      return { batchId: input.batchId, missingSegments: [] };
    }
```

- [ ] **Step 4: Re-run the targeted cancellation test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts -t "ignores provider results"
```

Expected: PASS.

- [ ] **Step 5: Commit cancellation coverage**

Run:

```bash
git add tests/background/taskOrchestrator.test.ts src/background/taskOrchestrator.ts
git commit -m "Cover stale provider cancellation"
```

If `src/background/taskOrchestrator.ts` did not change, stage only the test.

## Task 5: Final P1 Verification

**Files:**
- Read: `docs/superpowers/specs/2026-05-30-kiss-like-hardening-milestone-design.md`
- Read: `docs/superpowers/plans/2026-05-30-p1-provider-pipeline-hardening.md`

- [ ] **Step 1: Run targeted provider pipeline tests**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts tests/provider/openAiTranslationAdapter.test.ts tests/translation/jsonResult.test.ts tests/translation/hash.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run standard checks**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Confirm P1 acceptance coverage**

Check the final diff covers:

```text
streaming progressive apply
empty streaming fallback
partial streaming error retry only missing segments
missing item retry
batch degrade and single fallback
rate-limit concurrency downshift and recovery
cache fan-out for duplicate source text
cancellation ignores stale provider results
trace privacy for source and translated text
```

- [ ] **Step 4: Commit any final test-only adjustments**

If final verification required only assertion text or timing adjustments, commit them:

```bash
git add tests/background/taskOrchestrator.test.ts tests/provider/openAiTranslationAdapter.test.ts tests/translation/jsonResult.test.ts
git commit -m "Stabilize provider pipeline hardening checks"
```

Skip this commit if all changes are already committed and `git status --short` is clean.

## Self-Review Notes

- Spec coverage: P1 goals map to Tasks 1-5. Streaming fallback, missing retry, cache fan-out, rate-limit behavior, cancellation, and privacy traces are all covered.
- Placeholders: the plan has no placeholder steps. Conditional fixes are concrete and tied to specific failures.
- Type consistency: snippets use existing helpers from `tests/background/taskOrchestrator.test.ts`, `tests/provider/openAiTranslationAdapter.test.ts`, and `tests/translation/jsonResult.test.ts`.
