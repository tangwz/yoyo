# P2 YouTube Subtitle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing YouTube subtitle translation pipeline so player lifecycle, caption fallback states, seek behavior, stale responses, AI segmentation fallback, and browser smoke coverage are reliable.

**Architecture:** Keep YouTube subtitles as an independent pipeline. Content runtime owns YouTube SPA/player lifecycle, caption fetching, segmentation, scheduler, session cache, overlay, and button state; background subtitle services own provider execution, AI segmentation, cache, model pinning, language detection, and cancellation. This plan does not add selection translation to YouTube.

**Tech Stack:** TypeScript, WXT content/background scripts, Vitest, happy-dom, Playwright Core, existing YouTube subtitle fixture.

---

## Scope Check

This plan covers only P2 from the milestone spec:

- YouTube subtitle runtime hardening.
- YouTube subtitle background service hardening.
- YouTube subtitle browser smoke coverage.

It explicitly excludes:

- Selection translation in YouTube.
- ASR for videos without caption tracks.
- Non-YouTube video sites.
- Subtitle downloads, glossary, right-side transcript list, and complex style editors.

## File Structure

- Modify: `tests/content/youtubeSubtitle/runtime.test.ts`  
  Adds content runtime regressions for provider missing, caption missing, stale translation responses, seek rescheduling, and player remount behavior.

- Modify: `tests/content/youtubeSubtitle/scheduler.test.ts`  
  Adds scheduler regressions for seek-window prioritization and retry exhaustion.

- Modify: `tests/background/youtubeSubtitle/service.test.ts`  
  Adds subtitle service regressions for partial provider results, unknown source language detection, model mismatch, cache hits, and cancellation.

- Read: `tests/background/youtubeSubtitle/aiSegmentation.test.ts`  
  Existing coverage already exercises invalid coverage, unknown cue ids, cancellation, provider availability, and fallback-required errors. This plan relies on that coverage and does not expand AI segmentation unless runtime/service changes break it.

- Modify: `tests/browser/youtube-subtitle-fixture.mjs` and `tests/browser/youtube-subtitle.spec.mjs`  
  Extends browser fixture coverage for playback time changes, target-language changes, disabled state, and warning state.

- Potentially modify: `src/content/youtubeSubtitle/runtime.ts`  
  Only if runtime tests expose stale response, warning state, seek, or cleanup gaps.

- Potentially modify: `src/content/youtubeSubtitle/scheduler.ts`  
  Only if scheduler tests expose queue eligibility or stale request handling gaps.

- Potentially modify: `src/background/youtubeSubtitle/service.ts` or `src/background/youtubeSubtitle/aiSegmentation.ts`  
  Only if service tests expose cache, cancellation, model, or fallback gaps.

## Task 1: Add Runtime Warning And Stale Response Coverage

**Files:**
- Modify: `tests/content/youtubeSubtitle/runtime.test.ts`
- Potentially modify: `src/content/youtubeSubtitle/runtime.ts`

- [ ] **Step 1: Add tests for missing provider and missing captions**

Append these tests in `tests/content/youtubeSubtitle/runtime.test.ts` near the other runtime initialization tests:

```ts
  it("shows warning and does not fetch captions when the subtitle provider is missing", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "getSubtitleRuntimeConfig") {
          return {
            type: "subtitleRuntimeConfig",
            configured: false,
            targetLanguage: "zh-CN",
            message: "Provider missing.",
          };
        }
        return createBackgroundResponse(message);
      },
      fetchCaptionPayload: async () => {
        throw new Error("Captions should not be fetched without a provider.");
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(buttonStatus()).toBe("warning");
    expect(translateMessages(sentMessages)).toHaveLength(0);
    expect(mountedOverlay()).not.toBeNull();
    expect(mountedOverlay()?.hidden).toBe(true);
  });

  it("shows warning when no caption payload is available", async () => {
    createPlayerDom();
    const { runtime, sentMessages } = createRuntimeHarness({
      fetchCaptionPayload: async () => undefined,
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();

    expect(buttonStatus()).toBe("warning");
    expect(translateMessages(sentMessages)).toHaveLength(0);
    expect(mountedOverlay()).not.toBeNull();
    expect(mountedOverlay()?.hidden).toBe(true);
  });
```

- [ ] **Step 2: Add a stale translation response test**

Add this test near existing config/video invalidation tests:

```ts
  it("ignores stale subtitle translation responses after config changes", async () => {
    createPlayerDom();
    let resolveFirst:
      | ((response: BackgroundResponse) => void)
      | undefined;
    const { runtime, sentMessages } = createRuntimeHarness({
      sendBackgroundMessage: async (message) => {
        if (message.type === "translateSubtitleBatch") {
          if (!resolveFirst) {
            return new Promise<BackgroundResponse>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return createBackgroundResponse(message);
        }
        return createBackgroundResponse(message);
      },
    });
    trackRuntime(runtime);

    await runtime.start();
    await flushRuntime();
    await runtime.handleConfigChanged();
    await flushRuntime();

    const staleRequest = translateMessages(sentMessages)[0];
    if (!staleRequest) {
      throw new Error("Expected first subtitle request.");
    }
    resolveFirst?.({
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: staleRequest.runtimeSessionId,
      configVersion: staleRequest.configVersion,
      requestId: staleRequest.requestId,
      items: staleRequest.segments.map((segment) => ({
        segmentId: segment.segmentId,
        translatedText: "Stale translation.",
      })),
    });
    await flushRuntime();

    expect(mountedOverlay()?.textContent).not.toContain("Stale translation.");
    expect(mountedOverlay()?.textContent).toContain("Translated: Hello world.");
  });
```

- [ ] **Step 3: Run targeted runtime tests**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/runtime.test.ts
```

Expected before implementation: PASS if warning and stale response behavior already matches the design; otherwise FAIL with caption fetches, provider requests, or stale overlay text.

- [ ] **Step 4: Apply minimal runtime fixes if needed**

If missing provider still fetches captions, update `initializePipeline` in `src/content/youtubeSubtitle/runtime.ts` so caption fetching happens only after a configured `subtitleRuntimeConfig` response:

```ts
    if (
      configResponse.type !== "subtitleRuntimeConfig" ||
      !configResponse.configured
    ) {
      updateButtonStatus("warning");
      return;
    }
```

If stale responses update the overlay, ensure the response handler checks runtime session, config version, video key, and request id before mutating translations:

```ts
        if (
          response.type === "subtitleTranslateBatchResult" &&
          response.runtimeSessionId === active.runtimeSessionId &&
          response.configVersion === active.configVersion &&
          response.requestId === requestId
        ) {
          // Apply items only inside this guarded branch.
        }
```

- [ ] **Step 5: Re-run runtime tests**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit runtime warning/stale coverage**

Run:

```bash
git add tests/content/youtubeSubtitle/runtime.test.ts src/content/youtubeSubtitle/runtime.ts
git commit -m "Cover YouTube subtitle warning states"
```

If `src/content/youtubeSubtitle/runtime.ts` did not change, stage only the test file.

## Task 2: Add Seek Window And Retry Scheduler Coverage

**Files:**
- Modify: `tests/content/youtubeSubtitle/scheduler.test.ts`
- Potentially modify: `src/content/youtubeSubtitle/scheduler.ts`

- [ ] **Step 1: Add scheduler tests for seek windows**

Append these tests in `tests/content/youtubeSubtitle/scheduler.test.ts`:

```ts
  it("queues newly intersecting segments after seeking to a later window", () => {
    const queue = scheduler({ maxBatchSegments: 2 });
    queue.replaceTimeline([
      segment("early", 0, 1000),
      segment("middle", 10_000, 11_000),
      segment("late", 20_000, 21_000),
    ]);

    queue.scanWindow(0);
    expect(queue.takeBatch("request-1").map((entry) => entry.segmentId)).toEqual([
      "early",
    ]);
    queue.markTranslated("request-1", ["early"]);

    queue.scanWindow(10_000);
    expect(queue.takeBatch("request-2").map((entry) => entry.segmentId)).toEqual([
      "middle",
    ]);

    queue.scanWindow(20_000);
    expect(queue.takeBatch("request-3").map((entry) => entry.segmentId)).toEqual([
      "late",
    ]);
  });

  it("does not let stale failed requests exhaust a rescheduled segment", () => {
    const queue = scheduler({ maxRetryCount: 0 });
    queue.replaceTimeline([segment("one", 0, 100)]);

    queue.scanWindow(0);
    expect(queue.takeBatch("request-1").map((entry) => entry.segmentId)).toEqual([
      "one",
    ]);
    queue.clearInFlight();
    queue.scanWindow(0);
    expect(queue.takeBatch("request-2").map((entry) => entry.segmentId)).toEqual([
      "one",
    ]);

    queue.markFailed("request-1", ["one"]);
    queue.scanWindow(0);
    expect(queue.takeBatch("request-3")).toEqual([]);

    queue.markFailed("request-2", ["one"]);
    queue.scanWindow(0);
    expect(queue.takeBatch("request-4")).toEqual([]);
  });
```

- [ ] **Step 2: Run scheduler tests**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/scheduler.test.ts
```

Expected before implementation: PASS if seek and stale request handling are already correct; otherwise FAIL with incorrect queue eligibility.

- [ ] **Step 3: Apply the minimal scheduler fix if needed**

If stale failures affect the current request, keep `markFailed` and `markTranslated` guarded by the request id:

```ts
      if (!this.isCurrentRequest(segmentId, requestId)) {
        continue;
      }
```

If seek windows do not enqueue later segments, ensure `scanWindow` uses intersection rather than only current active segment:

```ts
      if (
        intersectsWindow(segment, windowStartMs, windowEndMs) &&
        this.isEligible(segment.segmentId)
      ) {
        this.pendingSegmentIds.add(segment.segmentId);
      }
```

- [ ] **Step 4: Re-run scheduler tests**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle/scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit scheduler coverage**

Run:

```bash
git add tests/content/youtubeSubtitle/scheduler.test.ts src/content/youtubeSubtitle/scheduler.ts
git commit -m "Cover subtitle scheduler seek behavior"
```

If `src/content/youtubeSubtitle/scheduler.ts` did not change, stage only the test file.

## Task 3: Add Subtitle Background Service Boundary Coverage

**Files:**
- Modify: `tests/background/youtubeSubtitle/service.test.ts`
- Potentially modify: `src/background/youtubeSubtitle/service.ts`

- [ ] **Step 1: Add partial provider-result coverage**

Append this test in `tests/background/youtubeSubtitle/service.test.ts`:

```ts
  it("returns only provider items that match requested subtitle segments", async () => {
    translateBatch.mockResolvedValueOnce({
      items: [
        { segmentId: "segment-1", translatedText: "One translated." },
        { segmentId: "unknown", translatedText: "Unknown translated." },
      ],
    });

    const response = await service().translateBatch(
      request({
        segments: [
          subtitleSegment({ segmentId: "segment-1", textHash: "hash-1" }),
          subtitleSegment({ segmentId: "segment-2", textHash: "hash-2" }),
        ],
      }),
    );

    expect(response).toEqual({
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: "runtime-1",
      configVersion: 2,
      requestId: "request-1",
      items: [{ segmentId: "segment-1", translatedText: "One translated." }],
    });
  });
```

- [ ] **Step 2: Add cancellation coverage for multiple active requests**

Append this test:

```ts
  it("cancels all active requests for a runtime session", async () => {
    translateBatch.mockImplementation(
      async ({ abortSignal }) =>
        new Promise((resolve, reject) => {
          abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("Request cancelled.", "AbortError"));
          });
          setTimeout(() => {
            resolve({ items: [] });
          }, 50);
        }),
    );
    const subtitleService = service();

    const first = subtitleService.translateBatch(request({ requestId: "request-1" }));
    const second = subtitleService.translateBatch(request({ requestId: "request-2" }));
    subtitleService.cancel("runtime-1");

    await expect(first).resolves.toMatchObject({
      type: "subtitleTranslateBatchError",
      retryable: false,
    });
    await expect(second).resolves.toMatchObject({
      type: "subtitleTranslateBatchError",
      retryable: false,
    });
  });
```

- [ ] **Step 3: Run subtitle service tests**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/service.test.ts
```

Expected before implementation: PASS if item filtering and cancellation already match the design; otherwise FAIL with unknown items or one uncancelled request.

- [ ] **Step 4: Apply minimal service fixes if needed**

If unknown provider items are returned, filter response items by requested segment ids before caching and response construction in `src/background/youtubeSubtitle/service.ts`:

```ts
      const missedById = new Map(
        missedSegments.map((segment) => [segment.segmentId, segment]),
      );
      for (const item of response.items) {
        const sourceSegment = missedById.get(item.segmentId);
        if (!sourceSegment) {
          continue;
        }
        cachedItems.set(item.segmentId, item.translatedText);
        this.cache.set(this.cacheKey(request, sourceSegment), item.translatedText);
      }
```

If cancel only aborts one request, ensure `controllersBySession` stores a map of request id to controller and `cancel(runtimeSessionId)` aborts every controller in that map.

- [ ] **Step 5: Re-run subtitle service tests**

Run:

```bash
pnpm vitest run tests/background/youtubeSubtitle/service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit service coverage**

Run:

```bash
git add tests/background/youtubeSubtitle/service.test.ts src/background/youtubeSubtitle/service.ts
git commit -m "Cover subtitle service request boundaries"
```

If `src/background/youtubeSubtitle/service.ts` did not change, stage only the test file.

## Task 4: Extend YouTube Browser Smoke Coverage

**Files:**
- Modify: `tests/browser/youtube-subtitle-fixture.mjs`
- Modify: `tests/browser/youtube-subtitle.spec.mjs`

- [ ] **Step 1: Add a longer timed text fixture**

In `tests/browser/youtube-subtitle-fixture.mjs`, extend `timedTextJson.events` with a later cue:

```js
    {
      tStartMs: 5000,
      dDurationMs: 1800,
      segs: [{ utf8: "Later playback text should translate after seeking." }],
    },
```

Keep the existing first two events unchanged.

- [ ] **Step 2: Add a seek assertion to the browser spec**

In `tests/browser/youtube-subtitle.spec.mjs`, after the first `assertOverlayContract(page);`, add:

```js
    await page.locator("video").evaluate((video) => {
      video.currentTime = 5.2;
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("seeked"));
    });
    await waitForTranslatedOverlay(
      page,
      "Later playback text should translate after seeking.",
      "[translated Later playback text should translate after seeking.]",
    );
```

- [ ] **Step 3: Verify the existing target-language change smoke assertion**

Confirm `tests/browser/youtube-subtitle.spec.mjs` still contains this target-language change block after SPA navigation:

```js
    const beforeLanguageChangeProviderCount = fixtureServer.getProviderRequestCount();
    await updateSubtitleTargetLanguage(serviceWorker, "ja");
    await waitForCondition(
      () => fixtureServer.getProviderRequestCount() > beforeLanguageChangeProviderCount,
      "Subtitle runtime did not restart after target language changed.",
    );
    assert(
      fixtureServer.getLastProviderRequest()?.prompt.includes("Target language: ja"),
      "Subtitle provider request did not use the updated target language.",
    );

    await waitForTranslatedOverlay(
      page,
      "Hello from the fixture.",
      "[translated Hello from the fixture.]",
    );
```

If this exact coverage already exists, do not add a duplicate block.

- [ ] **Step 4: Run YouTube browser smoke**

Run:

```bash
pnpm build
node tests/browser/youtube-subtitle.spec.mjs
```

Expected before implementation: PASS if seek and config change behavior are already stable; otherwise FAIL by not showing the later cue or by leaving stale overlay/config state.

- [ ] **Step 5: Apply minimal runtime or fixture fixes if needed**

If the seek assertion fails because the video element cannot seek in the fixture, set the video duration in the fixture page script:

```js
Object.defineProperty(document.querySelector("video"), "duration", {
  configurable: true,
  value: 10,
});
```

If the runtime does not schedule translations after `seeked`, ensure `bindPipelineVideo` registers both listeners:

```ts
    active.video?.addEventListener("timeupdate", active.onTimeChange);
    active.video?.addEventListener("seeked", active.onTimeChange);
```

- [ ] **Step 6: Re-run YouTube browser smoke**

Run:

```bash
pnpm build
node tests/browser/youtube-subtitle.spec.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit browser smoke coverage**

Run:

```bash
git add tests/browser/youtube-subtitle-fixture.mjs tests/browser/youtube-subtitle.spec.mjs src/content/youtubeSubtitle/runtime.ts
git commit -m "Cover YouTube subtitle seek smoke"
```

If `src/content/youtubeSubtitle/runtime.ts` did not change, stage only the browser files.

## Task 5: Final P2 Verification

**Files:**
- Read: `docs/superpowers/specs/2026-05-30-kiss-like-hardening-milestone-design.md`
- Read: `docs/superpowers/plans/2026-05-30-p2-youtube-subtitle-hardening.md`

- [ ] **Step 1: Run targeted YouTube subtitle tests, including existing AI segmentation coverage**

Run:

```bash
pnpm vitest run tests/content/youtubeSubtitle tests/background/youtubeSubtitle tests/subtitle
```

Expected: PASS.

- [ ] **Step 2: Run YouTube browser smoke**

Run:

```bash
pnpm build
node tests/browser/youtube-subtitle.spec.mjs
```

Expected: PASS.

- [ ] **Step 3: Run standard checks**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Confirm P2 acceptance coverage**

Check that final tests cover:

```text
caption track available path
provider missing warning
caption missing warning
source language equals target language
seek rescheduling
stale response ignored
YouTube SPA or config change cancellation
AI segmentation fallback to built-in segmentation
subtitle service cache and cancellation
overlay notranslate contract
```

- [ ] **Step 5: Commit any final test-only adjustments**

If final verification required only fixture timing or assertion changes, commit them:

```bash
git add tests/content/youtubeSubtitle tests/background/youtubeSubtitle tests/browser/youtube-subtitle-fixture.mjs tests/browser/youtube-subtitle.spec.mjs
git commit -m "Stabilize YouTube subtitle hardening checks"
```

Skip this commit if all changes are already committed and `git status --short` is clean.

## Self-Review Notes

- Spec coverage: P2 goals map to Tasks 1-5. The plan covers warning states, stale responses, seek, SPA/config change behavior, AI fallback, background service boundaries, and browser smoke.
- Placeholders: the plan has no placeholder steps. Conditional fixes are concrete and tied to observed failures.
- Type consistency: snippets use existing helpers from `tests/content/youtubeSubtitle/runtime.test.ts`, `tests/content/youtubeSubtitle/scheduler.test.ts`, `tests/background/youtubeSubtitle/service.test.ts`, and `tests/browser/youtube-subtitle.spec.mjs`.
