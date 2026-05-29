# P0 Dynamic Page Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden manual translation for `x.com` and other mainstream dynamic pages by adding acceptance-level coverage for feed extraction, runtime mutation handling, and browser smoke behavior.

**Architecture:** Keep the existing content-side runtime architecture. `domExtraction` owns readable node classification, `pageRuntime` owns task lifecycle and mutation-driven enqueueing, and `taskOrchestrator` owns provider execution for runtime-originated batches. This plan adds targeted tests first and only applies small extractor/runtime fixes if those tests expose gaps.

**Tech Stack:** WXT, Chrome MV3, Vue 3, TypeScript, Vitest, happy-dom, Playwright Core, Node HTTP fixtures.

---

## Scope Check

The milestone spec covers P0/P1/P2, but these are separate subsystems. This plan covers only P0:

- Dynamic page DOM extraction.
- Dynamic page runtime mutation handling.
- Browser smoke coverage for an X-like feed.

P1 provider pipeline hardening and P2 YouTube subtitle hardening should get separate implementation plans after P0 lands, because P0 may expose provider/runtime interaction details that should shape P1.

## File Structure

- Modify: `tests/content/domExtraction.test.ts`  
  Adds mainstream dynamic page extraction regressions. These tests protect `x.com`-like posts, Reddit-like post bodies, GitHub-like discussion comments, side rails, action controls, usernames, counters, and duplicate nested roots.

- Modify: `tests/content/pageRuntime.test.ts`  
  Adds runtime mutation tests for dynamically inserted feed posts and dynamic side rail updates during an active manual translation task.

- Modify: `scripts/verify-extension-smoke.mjs`  
  Extends the existing X-like browser smoke fixture so it verifies dynamic post insertion after translation has started. This keeps P0 acceptance inside the existing extension smoke path.

- Potentially modify: `src/content/domExtraction.ts`  
  Only if new extraction tests fail. Likely changes are constrained to feed chrome selectors, post-body heuristics, or direct-readable feed text handling.

- Potentially modify: `src/content/pageRuntime.ts`  
  Only if new mutation tests fail. Likely changes are constrained to mutation dirty-root selection, disconnected anchor cleanup, or runtime batch failed-id reporting.

## Task 1: Add Mainstream Dynamic Page Extraction Regressions

**Files:**
- Modify: `tests/content/domExtraction.test.ts`
- Potentially modify: `src/content/domExtraction.ts`

- [ ] **Step 1: Add failing extraction tests**

Insert these tests inside `describe("collectPageSegments", () => { ... })`, near the existing X-like feed tests:

```ts
  it("extracts mainstream feed post bodies while skipping side rails and actions", async () => {
    document.body.innerHTML = `
      <main>
        <section role="feed" aria-label="Timeline: Home">
          <div role="listitem">
            <article role="article">
              <header>
                <div dir="auto">Terence</div>
                <div dir="auto">@terence</div>
                <time>2h</time>
              </header>
              <div lang="en" dir="auto">
                The main post body should translate on a dynamic social feed.
              </div>
              <div aria-label="Post actions">
                <span>Reply</span>
                <span>Repost</span>
                <span>Like</span>
                <span>42</span>
              </div>
            </article>
          </div>
        </section>
        <aside aria-label="Who to follow">
          <div dir="auto">Suggested Person</div>
          <div dir="auto">@suggested</div>
          <button>Follow</button>
        </aside>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "The main post body should translate on a dynamic social feed.",
    ]);
  });

  it("extracts Reddit-like post bodies without voting or toolbar text", async () => {
    document.body.innerHTML = `
      <main>
        <article aria-label="Post">
          <header>
            <a href="/r/programming">r/programming</a>
            <span>123 upvotes</span>
          </header>
          <div slot="text-body">
            <p>Reddit-like dynamic post text should be translated as content.</p>
            <p>Second paragraph in the post body should also be translated.</p>
          </div>
          <footer role="toolbar">
            <button>Vote</button>
            <button>Comment</button>
            <button>Share</button>
          </footer>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Reddit-like dynamic post text should be translated as content.",
      "Second paragraph in the post body should also be translated.",
    ]);
  });

  it("extracts GitHub-like discussion comments without repository chrome", async () => {
    document.body.innerHTML = `
      <main>
        <nav>Code Issues Pull requests Actions Projects Security Insights</nav>
        <div role="article" aria-label="Comment">
          <header>
            <a href="/octocat">octocat</a>
            <relative-time>now</relative-time>
          </header>
          <div class="comment-body">
            <p>GitHub-like discussion comments should remain readable.</p>
          </div>
          <div role="toolbar">
            <button>React</button>
            <button>Quote reply</button>
          </div>
        </div>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "GitHub-like discussion comments should remain readable.",
    ]);
  });
```

- [ ] **Step 2: Run the targeted extraction tests**

Run:

```bash
pnpm vitest run tests/content/domExtraction.test.ts
```

Expected before implementation: at least the first new test may fail if feed side rail or unmarked action text enters extraction. Existing tests should continue to pass.

- [ ] **Step 3: Apply the minimal extractor fix if the new tests fail**

If the failure shows side rail or suggestion rail text is extracted, extend `feedPageChromeSelector` in `src/content/domExtraction.ts`:

```ts
const feedPageChromeSelector = [
  '[aria-label*="trend" i]',
  '[aria-label*="trending" i]',
  '[aria-label*="趋势"]',
  '[aria-label*="who to follow" i]',
  '[aria-label*="suggested" i]',
  '[aria-label*="recommend" i]',
].join(",");
```

If the failure shows unmarked feed action labels are extracted from a feed post, add this helper near the existing feed low-value helpers:

```ts
function isFeedActionLabelText(text: string): boolean {
  return /^(reply|repost|retweet|like|share|comment|vote|follow|\d+([.,]\d+)?[KMB]?)$/i.test(
    text.trim(),
  );
}
```

Then update the tail of `isFeedLowValueElement`:

```ts
  const text = normalizedElementText(element, textCache);
  if (/^@\w{1,30}$/.test(text)) return true;
  if (/^\d+([.,]\d+)?[KMB]?$/.test(text)) return true;
  if (/^\d+[smhdw]$/.test(text)) return true;
  if (!isInsideBodySafeTextContainer(element) && isFeedActionLabelText(text)) {
    return true;
  }

  return false;
```

- [ ] **Step 4: Re-run extraction tests**

Run:

```bash
pnpm vitest run tests/content/domExtraction.test.ts
```

Expected: PASS. The new tests should extract only body text and skip side rails, action labels, usernames, timestamps, and counters.

- [ ] **Step 5: Commit extraction coverage and fixes**

Run:

```bash
git add tests/content/domExtraction.test.ts src/content/domExtraction.ts
git commit -m "Harden dynamic feed extraction"
```

If `src/content/domExtraction.ts` was not changed because the new tests already passed, stage only `tests/content/domExtraction.test.ts`.

## Task 2: Add Runtime Mutation Coverage For Dynamic Feeds

**Files:**
- Modify: `tests/content/pageRuntime.test.ts`
- Potentially modify: `src/content/pageRuntime.ts`

- [ ] **Step 1: Add failing runtime mutation tests**

Insert these tests in `tests/content/pageRuntime.test.ts` near the existing mutation tests:

```ts
  it("translates dynamically inserted X-like feed posts during an active manual task", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <section id="timeline" role="feed" aria-label="Timeline: Home">
          <article data-testid="tweet">
            <div data-testid="tweetText" lang="en" dir="auto">Initial dynamic post text.</div>
            <div role="group" aria-label="Post actions">
              <button>Reply</button>
              <button>Repost</button>
              <button>Like</button>
            </div>
          </article>
        </section>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const timeline = document.querySelector("#timeline") as HTMLElement;
    const nextPost = document.createElement("article");
    nextPost.dataset.testid = "tweet";
    nextPost.innerHTML = `
      <header>
        <span dir="auto">Display Name</span>
        <span dir="auto">@display</span>
        <time>1m</time>
      </header>
      <div data-testid="tweetText" lang="en" dir="auto">Inserted post body should be queued.</div>
      <div role="group" aria-label="Post actions">
        <button>Reply</button>
        <button>Repost</button>
        <button>Like</button>
      </div>
    `;
    timeline.append(nextPost);
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: timeline,
        addedNodes: [nextPost] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "enqueueTranslationBatch",
          segments: [
            expect.objectContaining({
              sourceText: "Inserted post body should be queued.",
            }),
          ],
        }),
      );
    });
    const batches = runtimeMessages<{
      type: "enqueueTranslationBatch";
      segments: Array<{ sourceText: string }>;
    }>("enqueueTranslationBatch");
    expect(batches.flatMap((batch) => batch.segments.map((segment) => segment.sourceText))).not.toEqual(
      expect.arrayContaining(["Reply", "Repost", "Like", "Display Name", "@display"]),
    );
  });

  it("ignores dynamic side rail updates while a feed translation task is active", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <section role="feed">
          <article data-testid="tweet">
            <div data-testid="tweetText" lang="en" dir="auto">Initial post body.</div>
          </article>
        </section>
        <aside id="rail" aria-label="Who to follow">
          <div dir="auto">Existing suggestion</div>
        </aside>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    await flushDeferredLazyCollection();
    runtimeMock.sendRuntimeMessage.mockClear();

    const rail = document.querySelector("#rail") as HTMLElement;
    const suggestion = document.createElement("div");
    suggestion.setAttribute("dir", "auto");
    suggestion.textContent = "New suggested account";
    rail.append(suggestion);
    MockMutationObserver.instances[0]?.emit([
      {
        type: "childList",
        target: rail,
        addedNodes: [suggestion] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(runtimeMessages("enqueueTranslationBatch")).toEqual([]);
  });
```

- [ ] **Step 2: Run the targeted runtime tests**

Run:

```bash
pnpm vitest run tests/content/pageRuntime.test.ts
```

Expected before implementation: the side rail test may fail if mutation dirty-root rescans can enqueue suggestion rail text. Existing runtime tests should continue to pass.

- [ ] **Step 3: Apply the minimal source fix if the new tests fail**

If the inserted feed post is not queued because the added node is too narrow for root discovery, update the added-node branch in `startMutationObserver` in `src/content/pageRuntime.ts` so feed container mutations also rescan the mutation target:

```ts
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          scheduleMutationRescanForElement(element);
          if (
            mutation.target instanceof Element &&
            element.matches(
              [
                "article",
                '[role="article"]',
                '[role="listitem"]',
                '[data-testid="tweet"]',
                '[data-testid="cellInnerDiv"]',
              ].join(","),
            )
          ) {
            scheduleMutationRescanForElement(mutation.target);
          }
        } else if (
          node.nodeType === Node.TEXT_NODE &&
          mutation.target instanceof Element
        ) {
          scheduleMutationRescanForElement(mutation.target);
        }
      }
```

If the failure is caused by extracted side rail text rather than runtime scheduling, apply the `domExtraction.ts` fix from Task 1 instead of changing runtime code.

- [ ] **Step 4: Re-run runtime tests**

Run:

```bash
pnpm vitest run tests/content/pageRuntime.test.ts
```

Expected: PASS. New feed posts should enqueue exactly their body text, and side rail updates should not enqueue translation batches.

- [ ] **Step 5: Commit runtime coverage and fixes**

Run:

```bash
git add tests/content/pageRuntime.test.ts src/content/pageRuntime.ts src/content/domExtraction.ts
git commit -m "Harden dynamic feed runtime updates"
```

If no source file changed, stage only `tests/content/pageRuntime.test.ts`.

## Task 3: Extend Browser Smoke Coverage For Dynamic X-like Feeds

**Files:**
- Modify: `scripts/verify-extension-smoke.mjs`

- [ ] **Step 1: Extend the X-like fixture with dynamic insertion controls**

In `scripts/verify-extension-smoke.mjs`, replace `xLikeFeedHtml` with this version:

```js
const xLikeFeedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X-like feed fixture</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0 auto;
        max-width: 860px;
      }
      main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 240px;
        gap: 24px;
      }
      article {
        border-bottom: 1px solid #ddd;
        padding: 16px 0;
      }
      [data-testid="tweetText"] {
        font-size: 18px;
        line-height: 1.45;
      }
      aside {
        border-left: 1px solid #eee;
        padding-left: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <section id="timeline" role="feed" aria-label="Timeline: Home">
        <article data-testid="tweet">
          <div><a href="/author">Terence</a><span>@terence</span><time>1h</time></div>
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Dynamic feed text should translate quickly.</span>
          </div>
          <div role="group" aria-label="Post actions">
            <button>Reply</button><button>Repost</button><button>Like</button>
          </div>
        </article>
        <article data-testid="tweet">
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Newly visible short text should translate too.</span>
          </div>
        </article>
      </section>
      <aside aria-label="Who to follow">
        <div dir="auto">Suggested Account</div>
        <div dir="auto">@suggested</div>
        <button>Follow</button>
      </aside>
    </main>
    <button id="append-post" type="button">Append post</button>
    <script>
      document.querySelector("#append-post").addEventListener("click", () => {
        const article = document.createElement("article");
        article.dataset.testid = "tweet";
        article.innerHTML = [
          '<div><span dir="auto">Another Author</span><span dir="auto">@another</span><time>1m</time></div>',
          '<div data-testid="tweetText" lang="en" dir="auto"><span>Inserted smoke post should translate after mutation.</span></div>',
          '<div role="group" aria-label="Post actions"><button>Reply</button><button>Repost</button><button>Like</button></div>'
        ].join("");
        document.querySelector("#timeline").append(article);
      });
    </script>
  </body>
</html>`;
```

- [ ] **Step 2: Add smoke assertions for inserted posts**

In `scripts/verify-extension-smoke.mjs`, after the existing X-like feed prompt assertions and before `xLikeProgressResponse`, add:

```js
    const beforeInsertedFeedRequestCount = countProviderRequests();
    await xLikePage.locator("#append-post").click();
    const insertedFeedResult = await waitForCondition(
      async () => {
        const insertedPromptItems = promptProbe.requests
          .slice(beforeInsertedFeedRequestCount)
          .flatMap((request) => extractPromptItems(request.prompt));
        const insertedItem = insertedPromptItems.find(
          (item) => item.text === "Inserted smoke post should translate after mutation.",
        );
        if (!insertedItem) {
          return undefined;
        }

        const snapshot = await translationSnapshot(xLikePage);
        const translatedText = snapshot
          .filter((item) => !item.pending)
          .map((item) => item.text)
          .join("\\n");
        return translatedText.includes(`[translated ${insertedItem.id}]`)
          ? { snapshot, insertedItem }
          : undefined;
      },
      "X-like feed did not translate an inserted post after mutation.",
      10000,
    );
    assertUniqueInjectedSegments(
      insertedFeedResult.snapshot,
      "X-like feed duplicated injected translations after mutation.",
    );
    const insertedFeedPromptText = promptProbe.requests
      .slice(beforeInsertedFeedRequestCount)
      .map((request) => request.prompt)
      .join("\\n");
    assert(
      !insertedFeedPromptText.includes("Suggested Account") &&
        !insertedFeedPromptText.includes("@suggested") &&
        !insertedFeedPromptText.includes("Follow"),
      "X-like side rail text reached the provider prompt after dynamic mutation.",
    );
```

- [ ] **Step 3: Run the extension smoke test**

Run:

```bash
pnpm verify:extension
```

Expected before implementation: FAIL if inserted X-like posts are not observed, queued, translated, and injected after the manual translation task has started.

- [ ] **Step 4: Apply the minimal source fix if smoke fails**

If the inserted post never reaches the provider, inspect whether `MutationObserver` fired and whether `enqueueTranslationBatch` was sent from content. Use these focused commands:

```bash
pnpm vitest run tests/content/pageRuntime.test.ts
pnpm vitest run tests/content/domExtraction.test.ts
```

If unit tests pass but smoke fails only in the built extension, adjust `scripts/verify-extension-smoke.mjs` timing first by increasing the inserted-post wait timeout from `10000` to `15000`. If the prompt includes side rail text, apply the extractor fix from Task 1.

- [ ] **Step 5: Re-run smoke**

Run:

```bash
pnpm verify:extension
```

Expected: PASS. The smoke test must prove that loading the feed does not send provider requests, manual translation sends only post body text, and a post inserted after translation start is translated without side rail or action text.

- [ ] **Step 6: Commit smoke coverage**

Run:

```bash
git add scripts/verify-extension-smoke.mjs
git commit -m "Cover dynamic feed mutation in smoke test"
```

## Task 4: Final P0 Verification

**Files:**
- Read: `docs/superpowers/specs/2026-05-30-kiss-like-hardening-milestone-design.md`
- Read: `docs/superpowers/plans/2026-05-30-p0-dynamic-page-runtime-hardening.md`

- [ ] **Step 1: Run targeted content tests**

Run:

```bash
pnpm vitest run tests/content/domExtraction.test.ts tests/content/pageRuntime.test.ts
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

- [ ] **Step 3: Run extension smoke**

Run:

```bash
pnpm verify:extension
```

Expected: PASS.

- [ ] **Step 4: Confirm P0 acceptance coverage**

Check that the final diff includes coverage for:

```text
x.com-like post body extraction
mainstream dynamic feed body extraction
side rail skipping
action label skipping
dynamic inserted post translation
no provider request before explicit translation
no duplicate injected translations
ordinary long-form page behavior unchanged
```

- [ ] **Step 5: Commit any final test-only adjustments**

If Task 4 required only assertion timing or fixture text changes, commit them:

```bash
git add tests/content/domExtraction.test.ts tests/content/pageRuntime.test.ts scripts/verify-extension-smoke.mjs
git commit -m "Stabilize dynamic page hardening checks"
```

Skip this commit if Task 1, Task 2, and Task 3 already committed all final changes and `git status --short` is clean.

## Self-Review Notes

- Spec coverage: P0 acceptance criteria map to Tasks 1-4. `x.com` support is covered by extraction tests and extension smoke. Dynamic insertion is covered by runtime tests and browser smoke. Low-value UI skipping is covered in extraction, runtime, and smoke layers.
- Placeholders: the plan uses no placeholder steps. Conditional source changes are concrete and tied to specific failure modes.
- Type consistency: code snippets use existing exported functions and existing helper names from `tests/content/pageRuntime.test.ts`, `tests/content/domExtraction.test.ts`, and `scripts/verify-extension-smoke.mjs`.
