# Kiss-like Page Translation Runtime Design

## Background

Yoyo Reading Assistant currently translates web pages through a background-owned task orchestration flow. The content script collects page segments, background batches them, calls the configured provider, then sends translated items back for injection. This works well for article-like pages, but it is too static for information-feed sites such as `x.com`.

The failure mode on `x.com` is structural. Tweet text is usually short, dynamic, and spread through nodes such as `article`, `[data-testid="tweetText"]`, `div[lang]`, `div[dir="auto"]`, and nested `span` elements. The existing extractor prefers a single article-style root and longer readable blocks, so it can return too few segments or no useful segments.

Kiss Translator solves this class of problem with a page-side runtime that continuously scans, observes, queues, and injects per DOM node. Yoyo should move closer to that behavior, but this design is a clean-room implementation. The GPL-3.0 reference code is used only to understand behavior and trade-offs; Yoyo will not copy its implementation.

## Goals

- Make manual page translation work on dynamic information-feed pages, with `x.com` as the primary acceptance sample.
- Keep the feature scope to the existing manual bilingual page translation flow.
- Improve perceived speed by prioritizing current viewport content and streaming each translated item into the page as soon as it arrives.
- Improve total throughput with adaptive batching, bounded concurrency, and session cache reuse.
- Continue translating newly loaded content while a manual translation task is active.
- Preserve current article-page behavior and existing hard skip rules.
- Keep provider calls and model configuration in the background layer for availability, isolation, and extension review friendliness.

## Non-goals

- No automatic translation on page load.
- No hover translation.
- No selection translation.
- No image translation or video subtitle translation.
- No direct copy of Kiss Translator GPL-3.0 source code.
- No guarantee for browser-restricted pages such as `chrome://`, extension pages, Chrome Web Store pages, inaccessible cross-origin iframes, or closed shadow roots.
- No promise that frontend scheduling can overcome a slow or rate-limited provider. The runtime can prioritize and stream results, but provider latency remains a hard bound.

## Architecture

The current split between content script and background should become more page-runtime oriented:

- Content script owns page scanning, node lifecycle, visibility observation, mutation handling, queueing, and DOM injection.
- Background owns provider resolution, request execution, cache, retry, rate-limit handling, cancellation, and task progress aggregation.
- Popup and context menu continue to start manual translation tasks through background.

The resulting data flow is:

```text
User starts page translation
  -> background creates task
  -> content starts PageTranslatorRuntime
  -> content discovers readable nodes
  -> content queues viewport nodes first
  -> content sends batches to background
  -> background translates with provider
  -> background streams or returns translated items
  -> content injects each item immediately
  -> content observes scroll and DOM mutation for more nodes
```

This keeps Yoyo's provider and task reliability boundaries while adopting Kiss-like page behavior where it matters: scanning, observing, queueing, and injection.

## Page Runtime

Introduce a `PageTranslatorRuntime` concept in `src/content/pageRuntime.ts`. It can initially live behind the existing message handlers so the extension entrypoint does not need a large rewrite.

The runtime maintains:

- the active task id;
- a registry from segment id to DOM anchor;
- a map from source node to node state;
- a map from normalized text hash to segment id for de-duplication;
- an `IntersectionObserver` for visible nodes;
- a `MutationObserver` for newly inserted or changed content;
- a translation queue for pending nodes.

Node states:

```ts
type RuntimeNodeState =
  | "pending"
  | "queued"
  | "translating"
  | "translated"
  | "failed"
  | "skipped";
```

The runtime is active only after the user manually starts page translation. It can continue discovering and queueing new nodes until the task is cancelled, removed, or the page unloads.

## DOM Discovery

The existing extractor should be split into three focused pieces:

- root discovery;
- readable node classification;
- text extraction and segment creation.

Root discovery should no longer pick only one root. It should collect multiple candidate roots and remove nested duplicates. Root candidates include:

- `article`;
- `main`;
- `[role="main"]`;
- `[role="article"]`;
- `[data-testid="tweet"]`;
- `[data-testid="tweetText"]`;
- `[lang]`;
- `[dir="auto"]`;
- `body` as a fallback.

Readable node classification should keep existing hard skip rules and add information-feed handling. High-confidence short text nodes are allowed, especially when they are:

- tweet-like text containers;
- visible `article` descendants with natural-language text;
- elements with `lang` or `dir="auto"`;
- block nodes that directly contain meaningful text;
- text containers without block children.

Low-value UI text should be skipped:

- navigation;
- buttons;
- menus;
- form controls;
- usernames, handles, timestamps, counters, and action labels where detectable;
- hidden nodes;
- extension-owned nodes;
- code, preformatted content, media, canvas, and complex table content.

For `x.com`, the extractor should recognize tweet text without becoming an `x.com`-only implementation. Site hints are acceptable when they improve confidence, but the classifier must still be general.

## Dynamic Page Handling

Use `MutationObserver` while the runtime is active. Mutations should not trigger immediate full-page rescans. Instead:

- collect changed containers into a dirty set;
- debounce or schedule work during idle time;
- rescan the smallest useful container;
- clean up stale translation nodes only for affected containers;
- avoid re-queuing already translated normalized text;
- preserve the current task if React reorders nodes.

This covers common information-feed behavior:

- infinite scroll inserts new articles;
- tweet text arrives after shell nodes render;
- React reorders or replaces portions of an article;
- nodes disappear while a request is in flight.

If an anchor disappears before injection, the runtime marks that segment failed or skipped and continues. One bad node must not fail the whole page.

## Translation Queue

Add a content-side queue module, for example `src/content/translationQueue.ts`.

The queue should not know provider details. It accepts candidate segments and emits batches for background translation.

Priority order:

1. viewport;
2. near viewport;
3. normal.

Default speed settings:

- first viewport flush delay: `0-50ms`;
- later flush delay: `100-200ms`;
- first viewport batch: `3-5` nodes or about `1200-1800` characters;
- regular batch: `8-12` nodes or about `3500-5000` characters;
- provider concurrency: default `2`, internally tunable to `3` after testing;
- rate limit fallback: reduce to `1`, back off, then restore after consecutive successful batches.

The queue should flush the first visible batch quickly instead of waiting to fill a large batch. After first paint, it should aggregate more aggressively to improve total throughput.

## Background Orchestration

`src/background/taskOrchestrator.ts` should evolve from "collect all segments, then translate" to "accept segment batches from the active content runtime."

Keep and reuse existing capabilities:

- active provider lookup;
- OpenAI-compatible generation and streaming;
- session translation cache;
- repeated normalized text fan-out;
- JSON result validation;
- retry for missing items;
- batch split and single-segment degradation;
- rate-limit backoff;
- progress emission.

The new path should support content-originated batch enqueue messages. Background translates the requested batch and returns translated items. Streaming providers should still parse each item as it arrives and immediately send it to content for injection.

The old `collectSegments` path can remain during the transition. `lazyViewport` can switch first to the runtime-driven queue, while `fullPage` can reuse the same runtime by enqueueing every discovered node instead of only visible nodes.

## Injection

The injected bilingual layout remains source text followed by translation. Improvements:

- insert a lightweight pending marker when a node enters translation;
- replace the marker as soon as the item translates;
- use a viewport anchor before insertion and restore scroll offset after insertion to reduce reading jumps;
- support per-node retry UI for local failures;
- avoid applying site classes to translation nodes;
- keep extension-owned nodes marked so future scans skip them.

During streaming, content should update each completed item immediately. If partial text streaming per segment becomes available later, content can use a text node and `requestAnimationFrame` buffering, but the first implementation only needs item-level immediate injection because the current provider parser emits completed JSONL records.

## Messaging

Extend `src/messaging/contracts.ts` with explicit runtime-driven messages.

Required message shapes:

```ts
type EnqueueTranslationBatchRequest = {
  type: "enqueueTranslationBatch";
  taskId: string;
  segments: PageSegment[];
};

type TranslationBatchResultMessage = {
  type: "translationBatchResult";
  taskId: string;
  items: TranslationResultItem[];
};
```

The implementation should use these message names unless an existing contract name would conflict. The important contract is that content can continuously submit batches for the active task, and background can return partial results without waiting for the whole page.

## Compatibility Strategy

Implementation should be staged to reduce regression risk:

1. Extract DOM discovery/classification helpers and add fixtures for article pages and X-like feeds.
2. Add content-side translation queue with unit tests.
3. Add runtime-driven batch enqueue messages while keeping existing task creation.
4. Add MutationObserver and IntersectionObserver integration.
5. Switch `lazyViewport` to runtime-driven behavior.
6. Reuse the same queue for `fullPage`.

Article-page tests must continue passing throughout the migration.

## Acceptance Criteria

Article pages:

- headings, paragraphs, and list items are translated;
- code blocks, forms, hidden nodes, extension nodes, and complex tables are skipped;
- translation remains below the original source text;
- existing smoke test behavior is preserved.

X-like feed fixture:

- multiple `article` nodes are discovered;
- tweet text under `[data-testid="tweetText"]`, `div[lang]`, `div[dir="auto"]`, and nested spans is translated;
- usernames, handles, timestamps, counters, navigation, and action button labels are not broadly translated;
- current viewport tweets translate first;
- new tweets inserted after startup are discovered and translated;
- React-like node replacement does not duplicate translations for the same text.

Dynamic site fixture:

- short card text and comment text can be translated;
- infinite-scroll inserts are queued;
- deleted nodes do not break the task;
- changed text causes only the affected container to be rescanned.

Performance behavior:

- first visible batch is sent almost immediately;
- streaming providers inject each completed item as soon as it parses;
- regular batches use larger budgets for throughput;
- rate limits reduce concurrency and recover after successful batches.

## Verification

Automated checks:

```bash
pnpm test tests/content/domExtraction.test.ts
pnpm test tests/content/pageRuntime.test.ts
pnpm test tests/background/taskOrchestrator.test.ts
pnpm test tests/translation/batch.test.ts tests/translation/jsonResult.test.ts
pnpm typecheck
pnpm lint
```

Smoke checks:

```bash
pnpm verify:extension
```

Manual checks:

- load the unpacked extension;
- open a normal article page and translate it;
- open `https://x.com` while logged in and trigger translation manually;
- verify visible tweets translate first;
- scroll and verify newly loaded tweets continue translating;
- verify buttons, nav text, usernames, handles, and counters are not broadly translated.

## Risks

- More aggressive DOM discovery can translate UI chrome if classification is too loose.
- MutationObserver can become expensive on highly dynamic pages if rescans are not debounced and scoped.
- `x.com` markup can change; site hints must be soft and covered by generic fallbacks.
- Some providers may produce incomplete JSONL under large batches. The existing missing-item retry path remains necessary.
- Faster first-batch flushing may reduce provider-side batching efficiency. The two-phase batch policy is intended to balance this.

## Implementation Defaults

- Provider concurrency starts at `2`. It can become `3` only after manual testing shows better real-world throughput without more 429s, timeouts, or missing JSONL records.
- The first implementation uses item-level streaming only. Partial-token streaming is deferred until item-level streaming and dynamic injection are stable.
- Site hints are built-in implementation details, not user-configurable settings in this scope.
