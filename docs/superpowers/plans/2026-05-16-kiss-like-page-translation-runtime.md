# Kiss-like Page Translation Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clean-room Kiss-like page translation runtime so dynamic information-feed pages such as `x.com` translate quickly while preserving existing article-page behavior.

**Architecture:** Content script becomes responsible for DOM discovery, visible-node queueing, mutation-driven rescans, and immediate injection. Background remains responsible for provider calls, streaming parsing, session cache, retry, rate-limit backoff, and progress aggregation. The migration is staged: first make extraction and queueing testable, then add runtime-driven batch enqueueing, then switch lazy/full-page flows onto the new runtime.

**Tech Stack:** WXT, Vue 3, TypeScript, Vitest, happy-dom, Chrome MV3 messaging.

---

## File Structure

- Modify `src/content/domExtraction.ts`: split root discovery, readable classification, and collection helpers; add X-like information-feed support without hard-coding the whole site.
- Modify `tests/content/domExtraction.test.ts`: add article regression, X-like feed, low-value UI skip, and multi-root de-duplication tests.
- Create `src/content/translationQueue.ts`: focused queue for segment priority, first-batch speed budget, regular-batch throughput budget, and state transitions.
- Create `tests/content/translationQueue.test.ts`: unit tests for priority, flush delay, batch size, char budget, duplicate suppression, and state transitions.
- Modify `src/messaging/contracts.ts`: add runtime-driven batch enqueue request/response shapes.
- Modify `src/background/taskOrchestrator.ts`: add `enqueueTranslationBatch` path that merges newly discovered segments and reuses existing provider/cache/retry logic.
- Modify `entrypoints/background.ts`: route `enqueueTranslationBatch` background messages to the orchestrator.
- Modify `src/content/pageRuntime.ts`: introduce runtime-owned scanning, visibility queueing, mutation debounce, dynamic segment enqueueing, and cleanup.
- Modify `entrypoints/content.ts`: route any new content messages while preserving existing message names until the migration is complete.
- Modify `tests/content/pageRuntime.test.ts`: cover runtime-driven queueing, dynamic inserted nodes, anchor loss, de-duplication, and remove/cancel cleanup.
- Modify `tests/background/taskOrchestrator.test.ts`: cover content-originated batches, total/progress updates, cache fan-out, streaming partial apply, and rate-limit recovery.
- Modify `scripts/verify-extension-smoke.mjs`: add a local X-like feed fixture after unit coverage is stable.

## Task 1: DOM Discovery For Information Feeds

**Files:**
- Modify: `src/content/domExtraction.ts`
- Test: `tests/content/domExtraction.test.ts`

- [ ] **Step 1: Add failing X-like feed extraction tests**

Append these tests inside `describe("collectPageSegments", () => { ... })` in `tests/content/domExtraction.test.ts`.

```ts
  it("extracts X-like tweet text from information-feed roots", async () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="tweet">
          <div>
            <a href="/author">Terence</a>
            <span>@terence</span>
            <time>1h</time>
          </div>
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Shipping reliable software is mostly about</span>
            <span> reducing accidental complexity.</span>
          </div>
          <div role="group" aria-label="Post actions">
            <button>Reply</button>
            <button>Repost</button>
            <button>Like</button>
          </div>
        </article>
        <article data-testid="tweet">
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Short tweet text should still translate.</span>
          </div>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Shipping reliable software is mostly about reducing accidental complexity.",
      "Short tweet text should still translate.",
    ]);
    expect(result.segments.map((segment) => segment.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("skips common feed chrome while keeping body text", async () => {
    document.body.innerHTML = `
      <main>
        <nav>Home Search Notifications Messages</nav>
        <article>
          <div lang="en" dir="auto">Actual comment text.</div>
          <div aria-label="Timeline controls">Show more</div>
          <button>Like</button>
          <a href="/user">@handle</a>
          <span>42</span>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual comment text.",
    ]);
  });

  it("deduplicates nested multi-root discoveries", async () => {
    document.body.innerHTML = `
      <main>
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Nested root text should appear once.</span>
          </div>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Nested root text should appear once.",
    ]);
  });
```

- [ ] **Step 2: Run the new extraction tests and verify failure**

Run:

```bash
pnpm test tests/content/domExtraction.test.ts
```

Expected: FAIL because short X-like `div[lang]`, `div[dir="auto"]`, and `[data-testid="tweetText"]` content is not reliably extracted or low-value feed chrome is not filtered.

- [ ] **Step 3: Add root discovery and feed classification helpers**

In `src/content/domExtraction.ts`, replace the current `chooseRoot()` helper with these helpers. Keep existing imports.

```ts
const rootSelector = [
  "article",
  "main",
  '[role="main"]',
  '[role="article"]',
  '[data-testid="tweet"]',
  '[data-testid="tweetText"]',
  "[lang]",
  '[dir="auto"]',
].join(",");

const lowValueSelector = [
  "nav",
  "header",
  "footer",
  "[role='navigation']",
  "[role='button']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
  "[aria-label*='action' i]",
  "[aria-label*='control' i]",
  "[data-testid='reply']",
  "[data-testid='retweet']",
  "[data-testid='like']",
].join(",");

function discoverRoots(): Element[] {
  const roots = [...document.querySelectorAll(rootSelector)];
  roots.push(document.body);

  return roots.filter((root, index, allRoots) => {
    if (isElementSkippable(root)) return false;
    return !allRoots.some(
      (other, otherIndex) =>
        otherIndex !== index && other !== root && other.contains(root),
    );
  });
}

function isLowValueFeedElement(element: Element): boolean {
  if (element.matches(lowValueSelector)) return true;

  const text = normalizeSourceText(element.textContent ?? "");
  if (!text) return true;
  if (/^@\w{1,30}$/.test(text)) return true;
  if (/^\d+([.,]\d+)?[KMB]?$/.test(text)) return true;
  if (/^\d+[smhdw]$/.test(text)) return true;

  return false;
}

function isHighConfidenceShortTextElement(element: Element): boolean {
  if (element.matches('[data-testid="tweetText"]')) return true;
  if (element.closest('[data-testid="tweetText"]')) return true;
  if (element.closest("article, [role='article'], [data-testid='tweet']")) {
    return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
  }
  return element.hasAttribute("lang") || element.getAttribute("dir") === "auto";
}

function hasHighConfidenceReadableChild(element: Element): boolean {
  return [...element.children].some((child) => {
    if (isElementSkippable(child) || isLowValueFeedElement(child)) {
      return false;
    }
    return isHighConfidenceShortTextElement(child) || hasHighConfidenceReadableChild(child);
  });
}
```

- [ ] **Step 4: Update extraction decisions**

In `src/content/domExtraction.ts`, update `shouldExtractElement` and `collectPageSegments` to use the new helpers. Preserve existing list handling and path generation.

```ts
function shouldExtractElement(element: Element): boolean {
  if (isElementSkippable(element)) return false;
  if (isLowValueFeedElement(element)) return false;
  if (isDirectReadableCandidate(element)) return true;
  if (!isHighConfidenceShortTextElement(element) && hasHighConfidenceReadableChild(element)) {
    return false;
  }
  if (hasReadableChildCandidate(element)) return false;

  const text = collectExtractableText(element);
  if (text.length === 0) return false;
  if (isHighConfidenceShortTextElement(element)) return true;

  return text.length >= genericMinimumTextLength;
}

export async function collectPageSegments(
  taskId: string,
  options: SegmentCollectionOptions = {},
): Promise<SegmentCollection> {
  const anchors = new AnchorRegistry();
  const segments: PageSegment[] = [];
  const seenNodes = new WeakSet<Element>();
  const seenTextHashes = new Set<string>();
  let order = 1;

  async function addSegment(
    element: Element,
    sourceText: string,
  ): Promise<void> {
    const normalizedText = normalizeSourceText(sourceText);
    if (!normalizedText || seenTextHashes.has(normalizedText)) {
      return;
    }

    const priority = priorityForElement(element);
    if (options.visibleRangeOnly && priority === "normal") {
      return;
    }

    const segmentId = `seg_${order}`;
    seenTextHashes.add(normalizedText);
    segments.push({
      id: segmentId,
      order,
      sourceText: normalizedText,
      kind: segmentKindFor(element),
      priority,
      pathHint: pathHintFor(element),
      textHash: await hashNormalizedText(normalizedText),
    });
    anchors.set({ segmentId, sourceNode: element, taskId });
    order += 1;
  }

  async function walk(element: Element): Promise<void> {
    if (seenNodes.has(element)) return;
    seenNodes.add(element);
    if (isElementSkippable(element)) return;
    if (isLowValueFeedElement(element)) return;
    if (options.visibleRangeOnly && element !== document.body && isOutsideVisibleCollectionRange(element)) {
      return;
    }

    if (element.tagName === "LI" && hasNestedList(element)) {
      const sourceText = collectNestedListItemOwnText(element);
      if (sourceText.length > 0) {
        await addSegment(element, sourceText);
      }

      for (const child of [...element.children].filter((child) =>
        listTags.has(child.tagName),
      )) {
        await walk(child);
      }
      return;
    }

    if (shouldExtractElement(element)) {
      const sourceText = collectExtractableText(element);
      if (sourceText.length === 0) return;

      await addSegment(element, sourceText);
      return;
    }

    for (const child of [...element.children]) {
      await walk(child);
    }
  }

  for (const root of discoverRoots()) {
    await walk(root);
  }

  return { segments, anchors };
}
```

- [ ] **Step 5: Run extraction tests**

Run:

```bash
pnpm test tests/content/domExtraction.test.ts
```

Expected: PASS. Confirm the existing generic readable-block tests still pass and the new de-duplication test reports one segment for nested tweet text.

- [ ] **Step 6: Commit**

```bash
git add src/content/domExtraction.ts tests/content/domExtraction.test.ts
git commit -m "feat: improve dynamic page text extraction"
```

## Task 2: Content-side Translation Queue

**Files:**
- Create: `src/content/translationQueue.ts`
- Test: `tests/content/translationQueue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create `tests/content/translationQueue.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import {
  TranslationQueue,
  defaultTranslationQueueOptions,
} from "@/content/translationQueue";
import type { PageSegment } from "@/translation/types";

function segment(
  id: string,
  order: number,
  sourceText: string,
  priority: PageSegment["priority"] = "normal",
): PageSegment {
  return {
    id,
    order,
    sourceText,
    kind: "paragraph",
    priority,
    pathHint: `body.${id}`,
    textHash: `hash-${id}`,
  };
}

describe("TranslationQueue", () => {
  it("flushes viewport segments first with first-batch limits", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 2,
      firstBatchMaxChars: 100,
    });

    queue.enqueue(segment("normal", 1, "Normal.", "normal"));
    queue.enqueue(segment("near", 2, "Near.", "nearViewport"));
    queue.enqueue(segment("viewport", 3, "Viewport.", "viewport"));

    expect(queue.nextDelayMs()).toBe(defaultTranslationQueueOptions.firstFlushDelayMs);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual([
      "viewport",
      "near",
    ]);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["normal"]);
  });

  it("uses regular limits after the first batch", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 1,
      regularBatchMaxSegments: 3,
      firstBatchMaxChars: 100,
      regularBatchMaxChars: 100,
    });

    queue.enqueue([
      segment("one", 1, "One.", "viewport"),
      segment("two", 2, "Two.", "viewport"),
      segment("three", 3, "Three.", "viewport"),
      segment("four", 4, "Four.", "viewport"),
    ]);

    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["one"]);
    expect(queue.nextDelayMs()).toBe(defaultTranslationQueueOptions.regularFlushDelayMs);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("respects character budgets without dropping an oversized first segment", () => {
    const queue = new TranslationQueue({
      ...defaultTranslationQueueOptions,
      firstBatchMaxSegments: 5,
      regularBatchMaxSegments: 5,
      firstBatchMaxChars: 10,
      regularBatchMaxChars: 10,
    });

    queue.enqueue([
      segment("large", 1, "123456789012345", "viewport"),
      segment("small", 2, "12", "viewport"),
    ]);

    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["large"]);
    expect(queue.takeNextBatch().map((item) => item.id)).toEqual(["small"]);
  });

  it("suppresses duplicate pending, translating, and translated segment ids", () => {
    const queue = new TranslationQueue(defaultTranslationQueueOptions);
    const item = segment("one", 1, "One.", "viewport");

    queue.enqueue(item);
    queue.enqueue(item);
    expect(queue.size()).toBe(1);

    const batch = queue.takeNextBatch();
    queue.markTranslating(batch.map((segment) => segment.id));
    queue.enqueue(item);
    expect(queue.size()).toBe(0);

    queue.markTranslated(["one"]);
    queue.enqueue(item);
    expect(queue.size()).toBe(0);
  });

  it("allows failed segments to be retried explicitly", () => {
    const queue = new TranslationQueue(defaultTranslationQueueOptions);
    const item = segment("one", 1, "One.", "viewport");

    queue.enqueue(item);
    const batch = queue.takeNextBatch();
    queue.markTranslating(batch.map((segment) => segment.id));
    queue.markFailed(["one"]);
    queue.retryFailed(["one"], [item]);

    expect(queue.takeNextBatch().map((segment) => segment.id)).toEqual(["one"]);
  });
});
```

- [ ] **Step 2: Run queue tests and verify failure**

Run:

```bash
pnpm test tests/content/translationQueue.test.ts
```

Expected: FAIL with module resolution error for `@/content/translationQueue`.

- [ ] **Step 3: Implement the queue**

Create `src/content/translationQueue.ts`.

```ts
import type { PageSegment } from "@/translation/types";

export type TranslationQueueOptions = {
  firstFlushDelayMs: number;
  regularFlushDelayMs: number;
  firstBatchMaxSegments: number;
  regularBatchMaxSegments: number;
  firstBatchMaxChars: number;
  regularBatchMaxChars: number;
};

type QueueState = "pending" | "translating" | "translated" | "failed";

type QueueEntry = {
  segment: PageSegment;
  state: QueueState;
};

export const defaultTranslationQueueOptions: TranslationQueueOptions = {
  firstFlushDelayMs: 0,
  regularFlushDelayMs: 150,
  firstBatchMaxSegments: 4,
  regularBatchMaxSegments: 10,
  firstBatchMaxChars: 1600,
  regularBatchMaxChars: 4200,
};

const priorityRank: Record<PageSegment["priority"], number> = {
  viewport: 0,
  nearViewport: 1,
  normal: 2,
};

export class TranslationQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private firstBatchDispatched = false;

  constructor(private readonly options: TranslationQueueOptions) {}

  enqueue(input: PageSegment | readonly PageSegment[]): void {
    const segments = Array.isArray(input) ? input : [input];
    for (const segment of segments) {
      const existing = this.entries.get(segment.id);
      if (existing && existing.state !== "failed") {
        continue;
      }
      this.entries.set(segment.id, { segment, state: "pending" });
    }
  }

  retryFailed(segmentIds: readonly string[], segments: readonly PageSegment[]): void {
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    for (const segmentId of segmentIds) {
      const segment = byId.get(segmentId);
      if (segment) {
        this.entries.set(segmentId, { segment, state: "pending" });
      }
    }
  }

  takeNextBatch(): PageSegment[] {
    const pending = [...this.entries.values()]
      .filter((entry) => entry.state === "pending")
      .map((entry) => entry.segment)
      .sort(
        (left, right) =>
          priorityRank[left.priority] - priorityRank[right.priority] ||
          left.order - right.order,
      );

    const maxSegments = this.firstBatchDispatched
      ? this.options.regularBatchMaxSegments
      : this.options.firstBatchMaxSegments;
    const maxChars = this.firstBatchDispatched
      ? this.options.regularBatchMaxChars
      : this.options.firstBatchMaxChars;

    const batch: PageSegment[] = [];
    let chars = 0;
    for (const segment of pending) {
      const wouldExceedSegments = batch.length >= maxSegments;
      const wouldExceedChars =
        batch.length > 0 && chars + segment.sourceText.length > maxChars;
      if (wouldExceedSegments || wouldExceedChars) {
        break;
      }
      batch.push(segment);
      chars += segment.sourceText.length;
    }

    if (batch.length > 0) {
      this.firstBatchDispatched = true;
      this.markTranslating(batch.map((segment) => segment.id));
    }

    return batch;
  }

  nextDelayMs(): number {
    return this.firstBatchDispatched
      ? this.options.regularFlushDelayMs
      : this.options.firstFlushDelayMs;
  }

  markTranslating(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry && entry.state === "pending") {
        entry.state = "translating";
      }
    }
  }

  markTranslated(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry) {
        entry.state = "translated";
      }
    }
  }

  markFailed(segmentIds: readonly string[]): void {
    for (const segmentId of segmentIds) {
      const entry = this.entries.get(segmentId);
      if (entry) {
        entry.state = "failed";
      }
    }
  }

  size(): number {
    return [...this.entries.values()].filter((entry) => entry.state === "pending").length;
  }

  hasPending(): boolean {
    return this.size() > 0;
  }

  clear(): void {
    this.entries.clear();
    this.firstBatchDispatched = false;
  }
}
```

- [ ] **Step 4: Run queue tests**

Run:

```bash
pnpm test tests/content/translationQueue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/translationQueue.ts tests/content/translationQueue.test.ts
git commit -m "feat: add page translation queue"
```

## Task 3: Runtime-driven Batch Messaging

**Files:**
- Modify: `src/messaging/contracts.ts`
- Modify: `src/background/taskOrchestrator.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/background/taskOrchestrator.test.ts`
- Test: `tests/messaging/contracts.test.ts`

- [ ] **Step 1: Add failing contract tests**

Append this test to `tests/messaging/contracts.test.ts`.

```ts
  it("supports runtime-driven translation batch enqueue requests", () => {
    const request: BackgroundRequest = {
      type: "enqueueTranslationBatch",
      taskId: "task-1",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        {
          id: "seg_1",
          order: 1,
          sourceText: "Visible tweet text.",
          kind: "paragraph",
          priority: "viewport",
          pathHint: "article:nth-child(1)",
          textHash: "hash-1",
        },
      ],
    };

    expect(request.type).toBe("enqueueTranslationBatch");
    expect(request.segments[0]?.priority).toBe("viewport");
  });
```

Make sure `BackgroundRequest` is already imported in the file. If the import is missing, extend the existing import from `@/messaging/contracts`.

- [ ] **Step 2: Add failing orchestrator tests**

Append this test to `tests/background/taskOrchestrator.test.ts`.

```ts
  it("accepts runtime-enqueued segments and updates task progress", async () => {
    const { orchestrator, generateText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }

      return { type: "contentActionResult", success: true };
    });
    generateText.mockImplementation(async (request) => {
      const input = JSON.parse(request.prompt.split("Input:\n")[1] ?? "{}") as {
        items?: Array<{ id: string }>;
      };
      return {
        text: JSON.stringify({
          items: (input.items ?? []).map((item) => ({
            id: item.id,
            text: `Translated ${item.id}`,
          })),
        }),
        model: "gpt-4.1-mini",
      };
    });

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    const progress = await orchestrator.enqueueTranslationBatch({
      taskId: "task-1",
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
      collectionComplete: false,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "Visible dynamic text.",
          priority: "viewport",
        }),
      ],
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(sendToContent).toHaveBeenLastCalledWith(7, {
      type: "applyTranslations",
      taskId: "task-1",
      items: [{ segmentId: "dynamic-1", translatedText: "Translated dynamic-1" }],
    });
    expect(progress).toMatchObject({
      taskId: "task-1",
      state: "waitingForViewport",
      total: 1,
      translated: 1,
      failed: 0,
    });
  });
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
pnpm test tests/messaging/contracts.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: FAIL because the request type and `enqueueTranslationBatch` method do not exist.

- [ ] **Step 4: Extend message contracts**

Modify `src/messaging/contracts.ts`.

```ts
export type BackgroundRequest =
  | {
      type: "translatePage";
      tabId: number;
      sourceLanguage: string;
      targetLanguage: string;
    }
  | { type: "cancelTask"; taskId: string; reason: CancelReason }
  | { type: "getTaskForTab"; tabId: number }
  | { type: "getProviderStatus" }
  | {
      type: "openOptions";
      section?: OptionsSection;
      source?: OptionsOpenSource;
    }
  | {
      type: "enqueueLazySegments";
      taskId: string;
      segmentIds: string[];
      failedSegmentIds?: string[];
      recovery?: LazySegmentRecoverySnapshot;
    }
  | {
      type: "enqueueTranslationBatch";
      taskId: string;
      sourceLanguage: string;
      targetLanguage: string;
      translationMode: TranslationMode;
      segments: PageSegment[];
      collectionComplete?: boolean;
      failedSegmentIds?: string[];
    };
```

- [ ] **Step 5: Add orchestrator input type and method**

In `src/background/taskOrchestrator.ts`, add this exported type near `TranslatePageInput`.

```ts
export type EnqueueTranslationBatchInput = {
  taskId: string;
  tabId: number;
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
  segments: PageSegment[];
  collectionComplete?: boolean;
  failedSegmentIds?: readonly string[];
};
```

Add this method inside `TranslationTaskOrchestrator`.

```ts
  async enqueueTranslationBatch(
    input: EnqueueTranslationBatchInput,
  ): Promise<TranslationProgress> {
    let task = this.tasks.get(input.taskId);
    if (!task) {
      const profile = await this.dependencies.getActiveProfile();
      if (!profile) {
        return this.missingTaskProgress(input.taskId);
      }

      task = this.createTask(input.taskId, input.tabId);
      task.context = {
        profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translationMode: input.translationMode,
      };
      task.collectionComplete = input.collectionComplete ?? false;
    }

    if (!task.context) {
      const profile = await this.dependencies.getActiveProfile();
      if (!profile) {
        return this.failTask(task, "No active provider profile.");
      }
      task.context = {
        profile,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        translationMode: input.translationMode,
      };
    }

    for (const segment of input.segments) {
      if (!task.segmentsById.has(segment.id)) {
        task.segmentsById.set(segment.id, segment);
      }
    }

    if (input.collectionComplete === true) {
      task.collectionComplete = true;
    }

    if (input.failedSegmentIds && input.failedSegmentIds.length > 0) {
      this.markSegmentsFailed(task, input.failedSegmentIds);
    }

    this.updateProgress(task, {
      state: "translating",
      total: task.segmentsById.size,
    });

    await this.processSegmentsForTask(task, input.segments);
    this.finishOrWaitForLazySegments(task);
    return this.cloneProgress(task.progress);
  }
```

- [ ] **Step 6: Wire background entrypoint**

In `entrypoints/background.ts`, add a new switch case before `cancelTask`.

```ts
        case "enqueueTranslationBatch": {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            return {
              type: "backgroundError",
              message: "Translation batch sender tab is unavailable.",
            };
          }

          return {
            type: "taskProgress",
            progress: await orchestrator.enqueueTranslationBatch({
              taskId: request.taskId,
              tabId,
              sourceLanguage: request.sourceLanguage,
              targetLanguage: request.targetLanguage,
              translationMode: request.translationMode,
              segments: request.segments,
              collectionComplete: request.collectionComplete,
              failedSegmentIds: request.failedSegmentIds,
            }),
          };
        }
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm test tests/messaging/contracts.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/messaging/contracts.ts src/background/taskOrchestrator.ts entrypoints/background.ts tests/messaging/contracts.test.ts tests/background/taskOrchestrator.test.ts
git commit -m "feat: accept runtime translation batches"
```

## Task 4: Runtime Queue Integration Without MutationObserver

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Modify: `entrypoints/content.ts`
- Test: `tests/content/pageRuntime.test.ts`

- [ ] **Step 1: Add failing runtime queue test**

Append this test to `tests/content/pageRuntime.test.ts`.

```ts
  it("enqueues visible runtime batches through background messaging", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <article>
          <div id="tweet" data-testid="tweetText" lang="en" dir="auto">
            Visible tweet text.
          </div>
        </article>
      </main>
    `;

    const tweet = document.querySelector("#tweet") as HTMLElement;
    tweet.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 10,
        top: 10,
        bottom: 30,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    await collectSegments(
      "task-1",
      "lazyViewport",
      "en",
      "zh-CN",
      "profile-1",
      "gpt-4.1-mini",
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        taskId: "task-1",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        translationMode: "lazyViewport",
        segments: [
          expect.objectContaining({
            id: "seg_1",
            sourceText: "Visible tweet text.",
            priority: "viewport",
          }),
        ],
      }),
    );
  });
```

- [ ] **Step 2: Run runtime test and verify failure**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: FAIL because `collectSegments` does not send `enqueueTranslationBatch`.

- [ ] **Step 3: Import queue and add runtime queue state**

In `src/content/pageRuntime.ts`, add imports.

```ts
import {
  TranslationQueue,
  defaultTranslationQueueOptions,
} from "@/content/translationQueue";
```

Add module-level state near the existing lazy state.

```ts
let translationQueue = new TranslationQueue(defaultTranslationQueueOptions);
let queueFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let queueContext:
  | {
      taskId: string;
      sourceLanguage: string;
      targetLanguage: string;
      translationMode: TranslationMode;
    }
  | undefined;
```

- [ ] **Step 4: Add queue scheduling helpers**

Add these helpers to `src/content/pageRuntime.ts`.

```ts
function stopQueueFlush(): void {
  if (queueFlushTimer !== undefined) {
    globalThis.clearTimeout(queueFlushTimer);
    queueFlushTimer = undefined;
  }
}

function resetTranslationQueue(): void {
  stopQueueFlush();
  translationQueue.clear();
  queueContext = undefined;
}

function scheduleQueueFlush(): void {
  if (!queueContext || !translationQueue.hasPending()) {
    return;
  }

  if (queueFlushTimer !== undefined) {
    return;
  }

  queueFlushTimer = globalThis.setTimeout(() => {
    queueFlushTimer = undefined;
    void flushTranslationQueue();
  }, translationQueue.nextDelayMs());
}

async function flushTranslationQueue(): Promise<void> {
  const context = queueContext;
  if (!context) {
    return;
  }

  const segments = translationQueue.takeNextBatch();
  if (segments.length === 0) {
    return;
  }

  const response = await Promise.resolve(
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
      type: "enqueueTranslationBatch",
      taskId: context.taskId,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      translationMode: context.translationMode,
      segments,
      collectionComplete: context.translationMode !== "lazyViewport",
    }),
  ).catch(() => undefined);

  if (!response || response.type !== "taskProgress") {
    translationQueue.markFailed(segments.map((segment) => segment.id));
    return;
  }

  if (isTerminalTaskState(response.progress.state)) {
    resetTranslationQueue();
    return;
  }

  scheduleQueueFlush();
}
```

- [ ] **Step 5: Seed queue from collected segments**

Modify `collectSegments` in `src/content/pageRuntime.ts` after `insertPendingTranslations(...)`.

```ts
  queueContext = {
    taskId,
    sourceLanguage,
    targetLanguage,
    translationMode,
  };
  translationQueue = new TranslationQueue(defaultTranslationQueueOptions);
  translationQueue.enqueue(
    translationMode === "lazyViewport"
      ? segments.filter((segment) => segment.priority !== "normal")
      : segments,
  );
  scheduleQueueFlush();
```

Also call `resetTranslationQueue()` in `stopLazySegmentReporting()` and in the branch of `removePageTranslations()` that clears the active task.

```ts
  resetTranslationQueue();
```

- [ ] **Step 6: Run runtime tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts tests/content/translationQueue.test.ts
```

Expected: PASS. For tests that inspect `runtimeMock.sendRuntimeMessage`, assert the requested message type explicitly:

```ts
expect(runtimeMock.sendRuntimeMessage.mock.calls).toEqual(
  expect.arrayContaining([
    [
      expect.objectContaining({
        type: "enqueueTranslationBatch",
      }),
    ],
  ]),
);
```

- [ ] **Step 7: Commit**

```bash
git add src/content/pageRuntime.ts entrypoints/content.ts tests/content/pageRuntime.test.ts
git commit -m "feat: queue visible page segments from content"
```

## Task 5: IntersectionObserver And Dynamic Visibility

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Test: `tests/content/pageRuntime.test.ts`

- [ ] **Step 1: Add an IntersectionObserver mock and failing test**

Add this mock inside `describe("page runtime", () => { ... })` in `tests/content/pageRuntime.test.ts`.

```ts
  class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];
    readonly observed = new Set<Element>();

    constructor(
      private readonly callback: IntersectionObserverCallback,
    ) {
      MockIntersectionObserver.instances.push(this);
    }

    observe(element: Element): void {
      this.observed.add(element);
    }

    unobserve(element: Element): void {
      this.observed.delete(element);
    }

    disconnect(): void {
      this.observed.clear();
    }

    emitIntersecting(element: Element): void {
      this.callback(
        [
          {
            target: element,
            isIntersecting: true,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: element.getBoundingClientRect(),
            intersectionRect: element.getBoundingClientRect(),
            rootBounds: null,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
  }
```

In `beforeEach`, install it:

```ts
    MockIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
```

In `afterEach`, restore it:

```ts
    vi.unstubAllGlobals();
```

Append this failing test.

```ts
  it("queues a normal segment when IntersectionObserver reports it visible", async () => {
    vi.useFakeTimers();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });

    document.body.innerHTML = `
      <main>
        <article>
          <p id="visible">Visible paragraph.</p>
          <p id="later">Later paragraph.</p>
        </article>
      </main>
    `;

    const visible = document.querySelector("#visible") as HTMLElement;
    const later = document.querySelector("#later") as HTMLElement;
    visible.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20, x: 0, y: 10, toJSON: () => ({}) }) as DOMRect;
    later.getBoundingClientRect = () =>
      ({ top: 500, bottom: 530, left: 0, right: 100, width: 100, height: 30, x: 0, y: 500, toJSON: () => ({}) }) as DOMRect;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    runtimeMock.sendRuntimeMessage.mockClear();

    later.getBoundingClientRect = () =>
      ({ top: 20, bottom: 50, left: 0, right: 100, width: 100, height: 30, x: 0, y: 20, toJSON: () => ({}) }) as DOMRect;
    MockIntersectionObserver.instances[0]?.emitIntersecting(later);
    await vi.advanceTimersByTimeAsync(1);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [
          expect.objectContaining({
            sourceText: "Later paragraph.",
          }),
        ],
      }),
    );

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });
```

- [ ] **Step 2: Run runtime tests and verify failure**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: FAIL because no `IntersectionObserver` is observing normal segments.

- [ ] **Step 3: Add observer state and helpers**

In `src/content/pageRuntime.ts`, add module state.

```ts
let visibilityObserver: IntersectionObserver | undefined;
let observedSegmentIdsByElement = new WeakMap<Element, string>();
```

Add helpers.

```ts
function stopVisibilityObserver(): void {
  visibilityObserver?.disconnect();
  visibilityObserver = undefined;
  observedSegmentIdsByElement = new WeakMap();
}

function startVisibilityObserver(taskId: string): void {
  stopVisibilityObserver();

  visibilityObserver = new IntersectionObserver(
    (entries) => {
      const newlyVisible: PageSegment[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        const segmentId = observedSegmentIdsByElement.get(entry.target);
        const segment = segmentId ? currentSegmentsById.get(segmentId) : undefined;
        if (segment) {
          newlyVisible.push({
            ...segment,
            priority: priorityForElement(entry.target as Element),
          });
        }
      }

      if (newlyVisible.length > 0) {
        translationQueue.enqueue(newlyVisible);
        scheduleQueueFlush();
      }
    },
    { threshold: 0.01, rootMargin: "500px 0px 500px 0px" },
  );

  for (const anchor of currentAnchors.listByTask(taskId)) {
    observedSegmentIdsByElement.set(anchor.sourceNode, anchor.segmentId);
    visibilityObserver.observe(anchor.sourceNode);
  }
}
```

- [ ] **Step 4: Start and stop observer**

In `collectSegments`, after queue seeding:

```ts
  if (translationMode === "lazyViewport") {
    startVisibilityObserver(taskId);
  } else {
    stopVisibilityObserver();
  }
```

In `stopLazySegmentReporting()` and active-task cleanup in `removePageTranslations()`, add:

```ts
  stopVisibilityObserver();
```

- [ ] **Step 5: Run runtime tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/content/pageRuntime.ts tests/content/pageRuntime.test.ts
git commit -m "feat: observe visible translation segments"
```

## Task 6: MutationObserver Incremental Rescan

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Test: `tests/content/pageRuntime.test.ts`

- [ ] **Step 1: Add failing dynamic insertion test**

Append this test to `tests/content/pageRuntime.test.ts`.

```ts
  it("discovers and enqueues newly inserted feed text while translation is active", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main id="feed">
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">Initial tweet text.</div>
        </article>
      </main>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    runtimeMock.sendRuntimeMessage.mockClear();

    document.querySelector("#feed")?.insertAdjacentHTML(
      "beforeend",
      `
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">New tweet text.</div>
        </article>
      `,
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [
          expect.objectContaining({
            sourceText: "New tweet text.",
          }),
        ],
      }),
    );
  });
```

- [ ] **Step 2: Run runtime tests and verify failure**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: FAIL because inserted nodes are not observed and rescanned.

- [ ] **Step 3: Add mutation observer state**

In `src/content/pageRuntime.ts`, add state.

```ts
let mutationObserver: MutationObserver | undefined;
let mutationRescanTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let dirtyMutationRoots = new Set<Element>();
```

Add helpers.

```ts
function stopMutationObserver(): void {
  mutationObserver?.disconnect();
  mutationObserver = undefined;
  if (mutationRescanTimer !== undefined) {
    globalThis.clearTimeout(mutationRescanTimer);
    mutationRescanTimer = undefined;
  }
  dirtyMutationRoots = new Set();
}

function scheduleMutationRescan(root: Element): void {
  if (!queueContext) {
    return;
  }

  dirtyMutationRoots.add(root);
  if (mutationRescanTimer !== undefined) {
    return;
  }

  mutationRescanTimer = globalThis.setTimeout(() => {
    mutationRescanTimer = undefined;
    void rescanDirtyMutationRoots();
  }, 200);
}

async function rescanDirtyMutationRoots(): Promise<void> {
  const context = queueContext;
  if (!context) {
    dirtyMutationRoots.clear();
    return;
  }

  const roots = [...dirtyMutationRoots];
  dirtyMutationRoots.clear();

  for (const root of roots) {
    if (!root.isConnected) {
      continue;
    }

    const beforeIds = new Set(currentSegmentsById.keys());
    const collection = await collectPageSegments(context.taskId, {
      visibleRangeOnly: context.translationMode === "lazyViewport",
      root,
    });

    mergeLazySegmentCollection(context.taskId, collection);
    const newSegments = [...currentSegmentsById.values()].filter(
      (segment) => !beforeIds.has(segment.id),
    );
    translationQueue.enqueue(newSegments);
  }

  scheduleQueueFlush();
}

function startMutationObserver(): void {
  stopMutationObserver();
  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target.parentElement) {
        scheduleMutationRescan(mutation.target.parentElement);
        continue;
      }

      if (mutation.type !== "childList") {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleMutationRescan(node as Element);
        } else if (node.nodeType === Node.TEXT_NODE && mutation.target instanceof Element) {
          scheduleMutationRescan(mutation.target);
        }
      }
    }
  });
  mutationObserver.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}
```

Update `SegmentCollectionOptions` in `src/content/domExtraction.ts` to support a root override:

```ts
export type SegmentCollectionOptions = {
  visibleRangeOnly?: boolean;
  root?: Element;
};
```

At the end of `collectPageSegments`, use the root override:

```ts
  const roots = options.root ? [options.root] : discoverRoots();
  for (const root of roots) {
    await walk(root);
  }
```

- [ ] **Step 4: Start and stop mutation observer**

In `collectSegments`, after visibility observer setup:

```ts
  startMutationObserver();
```

In `stopLazySegmentReporting()` and active-task cleanup:

```ts
  stopMutationObserver();
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test tests/content/domExtraction.test.ts tests/content/pageRuntime.test.ts
```

Expected: PASS. The dynamic insertion test should enqueue only the newly inserted tweet text.

- [ ] **Step 6: Commit**

```bash
git add src/content/domExtraction.ts src/content/pageRuntime.ts tests/content/pageRuntime.test.ts
git commit -m "feat: discover dynamic page translation nodes"
```

## Task 7: Progress, Failure, And Queue State Reconciliation

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Modify: `src/background/taskOrchestrator.ts`
- Test: `tests/content/pageRuntime.test.ts`
- Test: `tests/background/taskOrchestrator.test.ts`

- [ ] **Step 1: Add failing tests for failed and applied segment reconciliation**

Append this test to `tests/content/pageRuntime.test.ts`.

```ts
  it("marks queued segments translated when page results are applied", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p>Visible paragraph.</p>
      </article>
    `;

    await collectSegments("task-1", "lazyViewport", "en", "zh-CN");
    applyTranslationResults("task-1", [
      { segmentId: "seg_1", translatedText: "Translated paragraph." },
    ]);
    runtimeMock.sendRuntimeMessage.mockClear();

    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(200);

    expect(runtimeMock.sendRuntimeMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: [expect.objectContaining({ id: "seg_1" })],
      }),
    );
  });
```

Append this test to `tests/background/taskOrchestrator.test.ts`.

```ts
  it("does not reprocess a runtime segment already translated through streaming", async () => {
    const { orchestrator, streamText, sendToContent } = createOrchestrator();

    sendToContent.mockImplementation(async (_tabId, message) => {
      if (message.type === "collectSegments") {
        return {
          type: "collectSegmentsResult",
          taskId: message.taskId,
          collectionComplete: false,
          segments: [],
        };
      }
      return { type: "contentActionResult", success: true };
    });
    streamText.mockReturnValue(streamChunks(['{"id":"dynamic-1","text":"一。"}\n']));

    await orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport",
    });

    const input = {
      taskId: "task-1",
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translationMode: "lazyViewport" as const,
      segments: [
        segment({
          id: "dynamic-1",
          sourceText: "One.",
          priority: "viewport",
        }),
      ],
    };

    await orchestrator.enqueueTranslationBatch(input);
    await orchestrator.enqueueTranslationBatch(input);

    expect(streamText).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: FAIL because content queue does not mark translated ids or background reprocesses already processed runtime ids.

- [ ] **Step 3: Mark queue state from apply results**

In `src/content/pageRuntime.ts`, update `applyTranslationResults`.

```ts
export function applyTranslationResults(
  taskId: string,
  items: TranslationResultItem[],
): ReturnType<typeof applyTranslations> {
  const result = applyTranslations(currentAnchors, taskId, items);
  translationQueue.markTranslated(result.appliedSegmentIds);
  translationQueue.markFailed(result.failedSegmentIds);
  return result;
}
```

- [ ] **Step 4: Ensure background skips processed runtime ids**

In `src/background/taskOrchestrator.ts`, inside `enqueueTranslationBatch`, filter the requested segments before processing.

```ts
    const processableSegments = input.segments.filter(
      (segment) =>
        !task.processedSegmentIds.has(segment.id) &&
        !task.inFlightSegmentIds.has(segment.id),
    );

    await this.processSegmentsForTask(task, processableSegments);
```

Replace the previous call that passed `input.segments` directly.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/content/pageRuntime.ts src/background/taskOrchestrator.ts tests/content/pageRuntime.test.ts tests/background/taskOrchestrator.test.ts
git commit -m "fix: reconcile runtime translation queue state"
```

## Task 8: Full-page Mode Uses The Runtime Queue

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Test: `tests/content/pageRuntime.test.ts`
- Test: `tests/background/taskOrchestrator.test.ts`

- [ ] **Step 1: Add failing full-page queue test**

Append this test to `tests/content/pageRuntime.test.ts`.

```ts
  it("queues all discovered segments in full-page mode", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <article>
        <p id="visible">Visible paragraph.</p>
        <p id="far">Far paragraph.</p>
      </article>
    `;

    const visible = document.querySelector("#visible") as HTMLElement;
    const far = document.querySelector("#far") as HTMLElement;
    visible.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20, x: 0, y: 10, toJSON: () => ({}) }) as DOMRect;
    far.getBoundingClientRect = () =>
      ({ top: 1000, bottom: 1030, left: 0, right: 100, width: 100, height: 30, x: 0, y: 1000, toJSON: () => ({}) }) as DOMRect;

    await collectSegments("task-1", "fullPage", "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1);

    expect(runtimeMock.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "enqueueTranslationBatch",
        segments: expect.arrayContaining([
          expect.objectContaining({ sourceText: "Visible paragraph." }),
          expect.objectContaining({ sourceText: "Far paragraph." }),
        ]),
      }),
    );
  });
```

- [ ] **Step 2: Run runtime test and verify failure**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: FAIL because full-page mode does not enqueue all segments through the runtime queue.

- [ ] **Step 3: Normalize full-page queue seeding**

In `src/content/pageRuntime.ts`, ensure this queue seed branch is present in `collectSegments`.

```ts
  const queuedSegments =
    translationMode === "lazyViewport"
      ? segments.filter((segment) => segment.priority !== "normal")
      : segments;
  translationQueue.enqueue(queuedSegments);
  scheduleQueueFlush();
```

Do not start the visibility observer for full-page mode. Keep mutation observer active for both modes while the task is active.

- [ ] **Step 4: Ensure task completion for full-page runtime batches**

In `src/background/taskOrchestrator.ts`, when `enqueueTranslationBatch` receives `collectionComplete: true`, it already sets `task.collectionComplete = true`. Verify the final `finishOrWaitForLazySegments` call can complete full-page tasks after all segments are processed.

Add this exact assertion to the existing orchestrator runtime batch test:

```ts
    expect(progress).toMatchObject({
      state: "completed",
      total: 1,
      translated: 1,
      failed: 0,
    });
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/content/pageRuntime.ts tests/content/pageRuntime.test.ts tests/background/taskOrchestrator.test.ts
git commit -m "feat: use runtime queue for full-page translation"
```

## Task 9: X-like Smoke Fixture

**Files:**
- Modify: `scripts/verify-extension-smoke.mjs`
- Test: `scripts/verify-extension-smoke.mjs`

- [ ] **Step 1: Add local X-like fixture HTML to the smoke server**

In `scripts/verify-extension-smoke.mjs`, add a route or fixture string for `/x-like-feed`. Use English fixture text so assertions do not depend on provider language detection.

```js
const xLikeFeedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X-like feed fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 0 auto; }
      article { border-bottom: 1px solid #ddd; padding: 16px 0; }
      [data-testid="tweetText"] { font-size: 18px; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main>
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
    </main>
  </body>
</html>`;
```

Serve it from the local HTTP server in the same pattern as the existing article fixture.

- [ ] **Step 2: Add smoke assertions for feed translation**

In `scripts/verify-extension-smoke.mjs`, after the current article smoke path, navigate to the feed fixture and trigger translation through the same popup/context menu path already used by the script.

```js
await page.goto(`${serverOrigin}/x-like-feed`);
await triggerPageTranslation(page);
await page.waitForFunction(() =>
  [...document.querySelectorAll("[data-yoyo-translation]")]
    .some((node) => node.textContent?.includes("动态") || node.textContent?.includes("翻译")),
);
const translatedChromeText = await page.evaluate(() =>
  [...document.querySelectorAll("[data-yoyo-translation]")]
    .map((node) => node.textContent || "")
    .join("\n"),
);
assert(
  !translatedChromeText.includes("Reply") &&
    !translatedChromeText.includes("Repost") &&
    !translatedChromeText.includes("Like"),
  "X-like feed smoke must not translate action button labels.",
);
```

When the smoke script uses its deterministic mock provider, assert the exact mock output for the two tweet texts instead of Chinese substrings.

- [ ] **Step 3: Run smoke script**

Run:

```bash
pnpm verify:extension
```

Expected: PASS. The local X-like fixture shows translation nodes for tweet text and no translation nodes for action button labels.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-extension-smoke.mjs
git commit -m "test: add x-like feed translation smoke coverage"
```

## Task 10: Final Verification And Manual Acceptance

**Files:**
- No source files required unless verification finds a bug.

- [ ] **Step 1: Run unit and integration checks**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:extension
```

Expected: all commands PASS.

- [ ] **Step 2: Build extension**

Run:

```bash
pnpm build
```

Expected: PASS and `build/chrome-mv3` exists.

- [ ] **Step 3: Manual article regression**

Load `build/chrome-mv3` as an unpacked extension and translate a normal article page.

Expected:

- headings, paragraphs, and list items translate;
- code blocks and form controls remain untranslated;
- translated text appears below original text;
- hide/show/remove controls still work from the popup.

- [ ] **Step 4: Manual `x.com` acceptance**

Open `https://x.com` while logged in, manually start translation, and observe the current feed.

Expected:

- visible tweets translate first;
- new tweets translate after scrolling;
- usernames, handles, timestamps, counters, navigation, and action labels are not broadly translated;
- page remains usable during translation;
- rate-limit or provider failures affect individual nodes rather than stopping the whole page.

- [ ] **Step 5: Commit verification fixes**

When verification produces source or test changes, commit the fix with a focused message.

```bash
git add src tests scripts
git commit -m "fix: stabilize dynamic page translation runtime"
```

When verification produces no file changes, leave the repository without an extra commit.

## Self-review Notes

- Spec coverage: Tasks 1, 5, and 6 cover dynamic DOM and `x.com`; Task 2 covers speed queueing; Task 3 covers runtime-driven background batches; Task 7 covers progress/failure reconciliation; Task 8 covers full-page reuse; Task 9 covers smoke coverage; Task 10 covers final verification.
- Type consistency: `enqueueTranslationBatch`, `PageSegment`, `TranslationMode`, `TranslationResultItem`, and `TranslationQueue` names are used consistently across tasks.
- Scope control: automatic page-load translation, hover translation, selection translation, image translation, and partial-token streaming remain outside this plan.
