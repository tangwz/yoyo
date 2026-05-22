# Performance Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为页面首屏翻译、lazy 滚动翻译、划词翻译增加开发期性能日志，重点拆解 LLM/provider 调用耗时。

**Architecture:** 新增一个集中式 `perfTrace` helper，默认只在开发构建输出 `[yoyo:perf]` 结构化日志。provider 请求通过可选 `traceContext` 串起 `taskId`、`batchId`、`stage`、segment 计数和字符数；OpenAI-compatible、Chrome Built-in AI、background orchestrator、content runtime 和 selection flow 在边界处记录耗时，不记录原文、prompt、译文、密钥或完整 URL。

**Tech Stack:** TypeScript, WXT, Vue, Vitest, browser extension content/background/offscreen contexts.

---

## File Structure

- Create: `src/utils/perfTrace.ts`
  - 负责性能日志的启用判断、metadata allowlist/redaction、duration helper。
- Test: `tests/utils/perfTrace.test.ts`
  - 验证默认关闭、开发构建开启、敏感字段不输出、错误 metadata 被归一化。
- Modify: `src/provider/types.ts`
  - 增加 provider trace context 类型，并允许 `GenerateTextRequest` / `StreamTextRequest` 携带 trace context。
- Modify: `src/provider/translationProvider.ts`
  - 允许 `TranslateTextRequest` / `TranslateBatchRequest` 携带 trace context。
- Modify: `src/provider/openAiCompatible.ts`
  - 记录 fetch 首响应、非流式 JSON、流式首 chunk、流式完成、candidate retry 和错误。
- Modify: `src/provider/openAiTranslationAdapter.ts`
  - 将 batch/selection 的 trace context 传入 text provider，并记录翻译 JSON 解析结果。
- Modify: `src/provider/chromeBuiltInAi.ts`
  - 记录 availability、create translator、单段 translate、batch 总耗时。
- Modify: `src/provider/chromeBuiltInAiOffscreenClient.ts`
  - 记录 ensure document、offscreen request、detect language 的耗时。
- Modify: `src/background/taskOrchestrator.ts`
  - 生成 batchId，记录 task/collect/detect/batch/apply/retry/concurrency 聚合事件，并传递 trace context 给 provider。
- Modify: `src/background/selectionTranslation.ts`
  - 记录划词翻译各 stage 耗时，并传递 selection trace context 给 provider。
- Modify: `src/content/pageRuntime.ts`
  - 记录 collect、lazy queue flush、applyTranslations 边界耗时。
- Modify: `src/content/selectionPanel.ts`
  - 记录 selection panel 渲染边界耗时。
- Test existing suites:
  - `tests/provider/openAiCompatible.test.ts`
  - `tests/provider/openAiTranslationAdapter.test.ts`
  - `tests/provider/chromeBuiltInAi.test.ts`
  - `tests/provider/chromeBuiltInAiOffscreenClient.test.ts`
  - `tests/background/taskOrchestrator.test.ts`
  - `tests/background/selectionTranslation.test.ts`
  - `tests/content/pageRuntime.test.ts`
  - `tests/content/selectionPanel.test.ts`

---

### Task 1: Add Perf Trace Helper

**Files:**
- Create: `src/utils/perfTrace.ts`
- Create: `tests/utils/perfTrace.test.ts`

- [ ] **Step 1: Write failing tests for the helper**

Create `tests/utils/perfTrace.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measurePerf,
  tracePerf,
  type PerfTraceMetadata,
} from "@/utils/perfTrace";

function renderedConsoleArgs(call: unknown[]): string {
  return call
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

describe("perfTrace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not log outside development builds", () => {
    vi.stubEnv("DEV", false);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      taskId: "task-1",
      sourceText: "private text",
    } as PerfTraceMetadata & { sourceText: string });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs allowlisted metadata in development builds", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      taskId: "task-1",
      batchId: "batch-1",
      providerType: "openai-compatible",
      model: "gpt-4.1-mini",
      segmentCount: 2,
      sourceCharCount: 25,
      durationMs: 12.345,
    });

    expect(infoSpy).toHaveBeenCalledWith("[yoyo:perf] llm.request.start", {
      taskId: "task-1",
      batchId: "batch-1",
      providerType: "openai-compatible",
      model: "gpt-4.1-mini",
      segmentCount: 2,
      sourceCharCount: 25,
      durationMs: 12.35,
    });
  });

  it("redacts non-allowlisted and sensitive fields", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      prompt: "private prompt",
      sourceText: "private source",
      translatedText: "private translation",
      apiKey: "sk-secret",
      authorization: "Bearer secret",
      safe: "not allowlisted",
      outputCharCount: 100,
    } as PerfTraceMetadata & Record<string, unknown>);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("outputCharCount");
    expect(output).toContain("100");
    expect(output).not.toContain("private prompt");
    expect(output).not.toContain("private source");
    expect(output).not.toContain("private translation");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("not allowlisted");
  });

  it("records success and duration for measured operations", async () => {
    vi.stubEnv("DEV", true);
    const nowSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125.678);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      measurePerf("content.applyTranslations.done", { itemCount: 3 }, async () => "ok"),
    ).resolves.toBe("ok");

    expect(nowSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenCalledWith("[yoyo:perf] content.applyTranslations.done", {
      itemCount: 3,
      durationMs: 25.68,
      success: true,
    });
  });

  it("records normalized error metadata and rethrows measured failures", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(performance, "now").mockReturnValueOnce(200).mockReturnValueOnce(250);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = new Error("failed") as Error & { code?: string; status?: number };
    error.name = "ProviderError";
    error.code = "rateLimited";
    error.status = 429;

    await expect(
      measurePerf("llm.request.error", { model: "gpt-4.1-mini" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(infoSpy).toHaveBeenCalledWith("[yoyo:perf] llm.request.error", {
      model: "gpt-4.1-mini",
      durationMs: 50,
      success: false,
      errorName: "ProviderError",
      errorCode: "rateLimited",
      status: 429,
    });
  });
});
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm vitest run tests/utils/perfTrace.test.ts
```

Expected: FAIL because `src/utils/perfTrace.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/utils/perfTrace.ts`:

```ts
export type PerfTraceMetadata = {
  taskId?: string;
  batchId?: string;
  stage?: string;
  attempt?: number;
  candidateIndex?: number;
  nextCandidateIndex?: number;
  providerType?: "openai-compatible" | "chrome-built-in-ai";
  model?: string;
  stream?: boolean;
  status?: number;
  success?: boolean;
  errorName?: string;
  errorCode?: string;
  requestType?: string;
  availability?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  detectedLanguage?: string;
  translationMode?: string;
  currentConcurrency?: number;
  previousConcurrency?: number;
  nextConcurrency?: number;
  reason?: string;
  createdDocument?: boolean;
  durationMs?: number;
  timeoutMs?: number;
  promptCharCount?: number;
  segmentId?: string;
  segmentOrder?: number;
  segmentCount?: number;
  sourceCharCount?: number;
  outputCharCount?: number;
  chunkCount?: number;
  itemCount?: number;
  pendingCount?: number;
  retryCount?: number;
  failedReportCount?: number;
  appliedCount?: number;
  failedCount?: number;
  returnedCount?: number;
  missingCount?: number;
};

const allowedMetadataKeys = new Set<keyof PerfTraceMetadata>([
  "taskId",
  "batchId",
  "stage",
  "attempt",
  "candidateIndex",
  "nextCandidateIndex",
  "providerType",
  "model",
  "stream",
  "status",
  "success",
  "errorName",
  "errorCode",
  "requestType",
  "availability",
  "sourceLanguage",
  "targetLanguage",
  "detectedLanguage",
  "translationMode",
  "currentConcurrency",
  "previousConcurrency",
  "nextConcurrency",
  "reason",
  "createdDocument",
  "durationMs",
  "timeoutMs",
  "promptCharCount",
  "segmentId",
  "segmentOrder",
  "segmentCount",
  "sourceCharCount",
  "outputCharCount",
  "chunkCount",
  "itemCount",
  "pendingCount",
  "retryCount",
  "failedReportCount",
  "appliedCount",
  "failedCount",
  "returnedCount",
  "missingCount",
]);

export function isPerfTraceEnabled(): boolean {
  return import.meta.env.DEV === true;
}

export function tracePerf(eventName: string, metadata: PerfTraceMetadata = {}): void {
  if (!isPerfTraceEnabled()) {
    return;
  }

  console.info(`[yoyo:perf] ${eventName}`, sanitizePerfMetadata(metadata));
}

export async function measurePerf<T>(
  eventName: string,
  metadata: PerfTraceMetadata,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = nowMs();
  try {
    const result = await operation();
    tracePerf(eventName, {
      ...metadata,
      durationMs: elapsedMs(startedAt),
      success: true,
    });
    return result;
  } catch (error) {
    tracePerf(eventName, {
      ...metadata,
      durationMs: elapsedMs(startedAt),
      success: false,
      ...metadataForError(error),
    });
    throw error;
  }
}

export function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function elapsedMs(startedAt: number): number {
  return roundDuration(nowMs() - startedAt);
}

export function metadataForError(error: unknown): PerfTraceMetadata {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };

  return {
    errorName: typeof candidate.name === "string" ? candidate.name : undefined,
    errorCode: typeof candidate.code === "string" ? candidate.code : undefined,
    status: typeof candidate.status === "number" ? candidate.status : undefined,
  };
}

function sanitizePerfMetadata(metadata: PerfTraceMetadata): PerfTraceMetadata {
  const sanitized: PerfTraceMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedMetadataKeys.has(key as keyof PerfTraceMetadata)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }

    sanitized[key as keyof PerfTraceMetadata] =
      typeof value === "number" && key === "durationMs"
        ? roundDuration(value)
        : (value as never);
  }

  return sanitized;
}

function roundDuration(value: number): number {
  return Math.round(value * 100) / 100;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
pnpm vitest run tests/utils/perfTrace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit helper**

```bash
git add src/utils/perfTrace.ts tests/utils/perfTrace.test.ts
git commit -m "feat: add performance trace helper"
```

---

### Task 2: Add Provider Trace Context Types

**Files:**
- Modify: `src/provider/types.ts`
- Modify: `src/provider/translationProvider.ts`
- Test: `tests/provider/openAiTranslationAdapter.test.ts`

- [ ] **Step 1: Write failing adapter test for trace context forwarding**

Add this test to `tests/provider/openAiTranslationAdapter.test.ts`:

```ts
it("forwards batch trace context to the text provider", async () => {
  const generateText = vi.fn().mockResolvedValue({
    text: JSON.stringify({
      translations: [{ id: "seg_1", text: "你好" }],
    }),
    model: "gpt-4.1-mini",
  });
  const adapter = new OpenAiTranslationAdapter({ generateText });

  await adapter.translateBatch({
    profile,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    traceContext: {
      taskId: "task-1",
      batchId: "batch-1",
      stage: "page",
      providerType: "openai-compatible",
    },
    segments: [
      {
        id: "seg_1",
        order: 1,
        sourceText: "Hello",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(1)",
        textHash: "hash-1",
      },
    ],
  });

  expect(generateText).toHaveBeenCalledWith(
    expect.objectContaining({
      traceContext: expect.objectContaining({
        taskId: "task-1",
        batchId: "batch-1",
        stage: "page",
        providerType: "openai-compatible",
        segmentCount: 1,
        sourceCharCount: 5,
      }),
    }),
  );
});
```

- [ ] **Step 2: Run the failing adapter test**

Run:

```bash
pnpm vitest run tests/provider/openAiTranslationAdapter.test.ts
```

Expected: FAIL because request types do not include `traceContext` and the adapter does not forward it.

- [ ] **Step 3: Add provider trace context types**

Modify `src/provider/types.ts`:

```ts
export type ProviderTraceContext = {
  taskId?: string;
  batchId?: string;
  stage?: "page" | "lazy" | "selection";
  providerType: ProviderType;
  segmentCount?: number;
  sourceCharCount?: number;
};

export type GenerateTextRequest = {
  profile: OpenAiCompatibleProviderProfile;
  prompt: string;
  abortSignal?: AbortSignal;
  traceContext?: ProviderTraceContext;
};

export type StreamTextRequest = GenerateTextRequest;
```

Modify `src/provider/translationProvider.ts`:

```ts
import type { ProviderProfile, ProviderTraceContext } from "@/provider/types";
import type { PageSegment, TranslationResultItem } from "@/translation/types";

export type TranslateTextRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  abortSignal?: AbortSignal;
  traceContext?: ProviderTraceContext;
};

export type TranslateBatchRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  segments: PageSegment[];
  abortSignal?: AbortSignal;
  traceContext?: ProviderTraceContext;
};
```

- [ ] **Step 4: Forward trace context in OpenAI adapter**

Modify `src/provider/openAiTranslationAdapter.ts` in `translateBatch`:

```ts
const sourceCharCount = request.segments.reduce(
  (total, segment) => total + segment.sourceText.length,
  0,
);
const response = await this.provider.generateText({
  profile: request.profile,
  prompt: buildTranslationPrompt({
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    segments: request.segments,
  }),
  abortSignal: request.abortSignal,
  traceContext: {
    ...request.traceContext,
    providerType: "openai-compatible",
    segmentCount: request.segments.length,
    sourceCharCount,
  },
});
```

Modify `streamBatch` similarly:

```ts
const sourceCharCount = request.segments.reduce(
  (total, segment) => total + segment.sourceText.length,
  0,
);

for await (const chunk of this.provider.streamText({
  profile: request.profile,
  prompt: buildStreamingTranslationPrompt({
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    segments: request.segments,
  }),
  abortSignal: request.abortSignal,
  traceContext: {
    ...request.traceContext,
    providerType: "openai-compatible",
    segmentCount: request.segments.length,
    sourceCharCount,
  },
})) {
  const items = parser.push(chunk.text);
  if (items.length > 0) {
    yield { items };
  }
}
```

Modify `translateText` to pass selection trace context into its synthetic batch:

```ts
const response = await this.translateBatch({
  profile: request.profile,
  sourceLanguage: request.sourceLanguage,
  targetLanguage: request.targetLanguage,
  abortSignal: request.abortSignal,
  traceContext: {
    ...request.traceContext,
    providerType: "openai-compatible",
    segmentCount: 1,
    sourceCharCount: request.text.length,
  },
  segments: [
    {
      id: "selection",
      order: 1,
      sourceText: request.text,
      kind: "paragraph",
      pathHint: "selection",
      textHash: "selection",
      priority: "viewport",
    },
  ],
});
```

- [ ] **Step 5: Run adapter and typecheck tests**

Run:

```bash
pnpm vitest run tests/provider/openAiTranslationAdapter.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 6: Commit trace context types**

```bash
git add src/provider/types.ts src/provider/translationProvider.ts src/provider/openAiTranslationAdapter.ts tests/provider/openAiTranslationAdapter.test.ts
git commit -m "feat: pass provider trace context"
```

---

### Task 3: Trace OpenAI-Compatible LLM Calls

**Files:**
- Modify: `src/provider/openAiCompatible.ts`
- Modify: `src/provider/openAiTranslationAdapter.ts`
- Test: `tests/provider/openAiCompatible.test.ts`
- Test: `tests/provider/openAiTranslationAdapter.test.ts`

- [ ] **Step 1: Write failing OpenAI tracing tests**

Add to `tests/provider/openAiCompatible.test.ts`:

```ts
it("traces non-streaming request timings without logging prompt text", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "translated text" } }],
        model: "model-a",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const provider = new OpenAiCompatibleProvider();
  await provider.generateText({
    profile,
    prompt: "Private prompt",
    traceContext: {
      taskId: "task-1",
      batchId: "batch-1",
      stage: "page",
      providerType: "openai-compatible",
      segmentCount: 1,
      sourceCharCount: 12,
    },
  });

  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("llm.request.start");
  expect(rendered).toContain("llm.fetch.response");
  expect(rendered).toContain("llm.response.json.done");
  expect(rendered).toContain("task-1");
  expect(rendered).toContain("batch-1");
  expect(rendered).not.toContain("Private prompt");
});

it("traces streaming first chunk and completion", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
      );
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ),
  );

  const provider = new OpenAiCompatibleProvider();
  for await (const _chunk of provider.streamText({
    profile,
    prompt: "Private prompt",
    traceContext: {
      taskId: "task-1",
      batchId: "batch-1",
      stage: "page",
      providerType: "openai-compatible",
      segmentCount: 1,
      sourceCharCount: 12,
    },
  })) {
    // Consume all chunks.
  }

  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("llm.stream.firstChunk");
  expect(rendered).toContain("llm.stream.done");
  expect(rendered).toContain("chunkCount");
  expect(rendered).not.toContain("Private prompt");
});

it("traces model candidate retries", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("model not found", { status: 400 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "translated text" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  const provider = new OpenAiCompatibleProvider();
  await provider.generateText({
    profile: { ...profile, textModel: "Model-A" },
    prompt: "Private prompt",
  });

  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("llm.retry.modelCandidate");
  expect(rendered).toContain("candidateIndex");
  expect(rendered).toContain("nextCandidateIndex");
});
```

Add to `tests/provider/openAiTranslationAdapter.test.ts`:

```ts
it("traces parsed batch responses with missing segment counts", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const adapter = new OpenAiTranslationAdapter({
    generateText: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        translations: [{ id: "seg_1", text: "你好" }],
      }),
      model: "gpt-4.1-mini",
    }),
  });

  await adapter.translateBatch({
    profile,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    traceContext: {
      taskId: "task-1",
      batchId: "batch-1",
      stage: "page",
      providerType: "openai-compatible",
    },
    segments: [
      {
        id: "seg_1",
        order: 1,
        sourceText: "Hello",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(1)",
        textHash: "hash-1",
      },
      {
        id: "seg_2",
        order: 2,
        sourceText: "World",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(2)",
        textHash: "hash-2",
      },
    ],
  });

  expect(infoSpy).toHaveBeenCalledWith(
    "[yoyo:perf] llm.response.parsed",
    expect.objectContaining({
      taskId: "task-1",
      batchId: "batch-1",
      returnedCount: 1,
      missingCount: 1,
    }),
  );
});
```

- [ ] **Step 2: Run failing OpenAI tests**

Run:

```bash
pnpm vitest run tests/provider/openAiCompatible.test.ts tests/provider/openAiTranslationAdapter.test.ts
```

Expected: FAIL because tracing events are not emitted.

- [ ] **Step 3: Add imports and shared metadata helpers**

Modify `src/provider/openAiCompatible.ts`:

```ts
import {
  elapsedMs,
  metadataForError,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

Add helper inside the file:

```ts
function promptTraceMetadata(
  request: GenerateTextRequest,
  model: string,
  candidateIndex: number,
  stream: boolean,
): Record<string, unknown> {
  return {
    ...request.traceContext,
    providerType: "openai-compatible",
    model,
    candidateIndex,
    stream,
    timeoutMs: request.profile.requestParams?.timeoutMs ?? 30000,
    promptCharCount: request.prompt.length,
  };
}
```

Modify `src/provider/openAiTranslationAdapter.ts`:

```ts
import {
  elapsedMs,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

- [ ] **Step 4: Trace generateText candidate attempts**

Inside the `generateText` loop before calling `generateTextWithModel`:

```ts
tracePerf("llm.request.start", promptTraceMetadata(request, model, index, false));
```

When a retryable candidate error occurs:

```ts
tracePerf("llm.retry.modelCandidate", {
  ...request.traceContext,
  providerType: "openai-compatible",
  model,
  candidateIndex: index,
  nextCandidateIndex: index + 1,
  ...metadataForError(error),
});
```

Do the same in `streamText`, with `stream: true`.

- [ ] **Step 5: Trace non-streaming fetch and JSON response**

Modify `generateTextWithModel`:

```ts
const startedAt = nowMs();
try {
  const response = await fetch(getChatCompletionsUrl(request.profile.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.profile.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: request.prompt }],
      temperature: request.profile.requestParams?.temperature ?? 0.2,
      max_tokens: request.profile.requestParams?.maxTokens ?? 1200,
    }),
    signal,
  });

  tracePerf("llm.fetch.response", {
    ...request.traceContext,
    providerType: "openai-compatible",
    model,
    stream: false,
    status: response.status,
    durationMs: elapsedMs(startedAt),
  });

  if (!response.ok) {
    throw mapHttpStatusToProviderError(response.status, await response.text());
  }

  const jsonStartedAt = nowMs();
  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    throw new ProviderError(
      "invalidResponse",
      "Provider response was not valid JSON.",
      undefined,
      error,
    );
  }

  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError("invalidResponse", "Provider response did not include text.");
  }

  tracePerf("llm.response.json.done", {
    ...request.traceContext,
    providerType: "openai-compatible",
    model: payload.model ?? model,
    outputCharCount: text.length,
    durationMs: elapsedMs(jsonStartedAt),
  });

  return {
    text,
    model: payload.model ?? model,
  };
} catch (error) {
  tracePerf("llm.request.error", {
    ...request.traceContext,
    providerType: "openai-compatible",
    model,
    stream: false,
    durationMs: elapsedMs(startedAt),
    ...metadataForError(error),
  });
  throw error;
}
```

- [ ] **Step 6: Trace streaming fetch, first chunk, and completion**

Modify `streamTextWithModel` with the same fetch response event, plus:

```ts
let firstChunkSeen = false;
let chunkCount = 0;
let outputCharCount = 0;
const streamStartedAt = nowMs();

for (const event of events) {
  const chunk = parseStreamEvent(event);
  if (chunk === "done") {
    tracePerf("llm.stream.done", {
      ...request.traceContext,
      providerType: "openai-compatible",
      model,
      chunkCount,
      outputCharCount,
      durationMs: elapsedMs(streamStartedAt),
    });
    return;
  }
  if (chunk) {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      tracePerf("llm.stream.firstChunk", {
        ...request.traceContext,
        providerType: "openai-compatible",
        model: chunk.model ?? model,
        durationMs: elapsedMs(streamStartedAt),
      });
    }
    chunkCount += 1;
    outputCharCount += chunk.text.length;
    yield chunk;
  }
}
```

Also emit `llm.stream.done` after the final buffer path if the stream ends without `[DONE]`.

- [ ] **Step 7: Trace parsed translation output**

In `OpenAiTranslationAdapter.translateBatch`, wrap parse:

```ts
const parseStartedAt = nowMs();
const parsedResult = parseTranslationBatchResult(
  response.text,
  request.segments.map((segment) => segment.id),
);
tracePerf("llm.response.parsed", {
  ...request.traceContext,
  providerType: "openai-compatible",
  segmentCount: request.segments.length,
  returnedCount: parsedResult.items.length,
  missingCount: request.segments.length - parsedResult.items.length,
  durationMs: elapsedMs(parseStartedAt),
});

return {
  items: parsedResult.items,
};
```

- [ ] **Step 8: Run OpenAI tests**

Run:

```bash
pnpm vitest run tests/provider/openAiCompatible.test.ts tests/provider/openAiTranslationAdapter.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 9: Commit OpenAI tracing**

```bash
git add src/provider/openAiCompatible.ts src/provider/openAiTranslationAdapter.ts tests/provider/openAiCompatible.test.ts tests/provider/openAiTranslationAdapter.test.ts
git commit -m "feat: trace openai provider latency"
```

---

### Task 4: Trace Chrome Built-in AI Provider and Offscreen Calls

**Files:**
- Modify: `src/provider/chromeBuiltInAi.ts`
- Modify: `src/provider/chromeBuiltInAiOffscreenClient.ts`
- Test: `tests/provider/chromeBuiltInAi.test.ts`
- Test: `tests/provider/chromeBuiltInAiOffscreenClient.test.ts`

- [ ] **Step 1: Write failing Chrome Built-in AI provider tests**

Add to `tests/provider/chromeBuiltInAi.test.ts`:

```ts
it("traces local AI batch translation by segment and batch", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const translate = vi.fn(async (text: string) => `translated:${text}`);
  const create = vi.fn(async () => ({ translate }));
  const availability = vi.fn(async () => "available" as const);
  const provider = new ChromeBuiltInTranslatorProvider({
    getTranslatorApi: () => ({ availability, create }),
  });

  await provider.translateBatch({
    profile: profile(),
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    traceContext: {
      taskId: "task-1",
      batchId: "batch-1",
      stage: "page",
      providerType: "chrome-built-in-ai",
    },
    segments: [
      {
        id: "seg_1",
        order: 1,
        sourceText: "Hello",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(1)",
        textHash: "hash-1",
      },
      {
        id: "seg_2",
        order: 2,
        sourceText: "World",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(2)",
        textHash: "hash-2",
      },
    ],
  });

  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("localAi.availability.done");
  expect(rendered).toContain("localAi.createTranslator.done");
  expect(rendered).toContain("localAi.translate.segment.done");
  expect(rendered).toContain("localAi.translate.batch.done");
  expect(rendered).not.toContain("translated:Hello");
});
```

Add to `tests/provider/chromeBuiltInAiOffscreenClient.test.ts`:

```ts
it("traces offscreen document setup and request round trips", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const port = createPort((message) => ({
    requestId: message.requestId,
    ok: true,
    availability: "available",
  }));
  const runtime = {
    getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    getContexts: vi.fn(async () => []),
    connect: vi.fn(() => port),
  };
  const offscreen = {
    createDocument: vi.fn(async () => undefined),
  };
  const client = new ChromeBuiltInAiOffscreenClient({ runtime, offscreen });

  await client.availability({ sourceLanguage: "en", targetLanguage: "zh-CN" });

  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("localAi.offscreen.ensureDocument.done");
  expect(rendered).toContain("localAi.offscreen.request.done");
  expect(rendered).toContain("chromeBuiltInAi.availability");
});
```

- [ ] **Step 2: Run failing Chrome tests**

Run:

```bash
pnpm vitest run tests/provider/chromeBuiltInAi.test.ts tests/provider/chromeBuiltInAiOffscreenClient.test.ts
```

Expected: FAIL because local AI trace events are not emitted.

- [ ] **Step 3: Add provider tracing imports**

Modify `src/provider/chromeBuiltInAi.ts`:

```ts
import {
  elapsedMs,
  metadataForError,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

Modify `src/provider/chromeBuiltInAiOffscreenClient.ts`:

```ts
import {
  elapsedMs,
  metadataForError,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

- [ ] **Step 4: Trace availability and create translator**

In `createTranslator`, around `availability`:

```ts
const availabilityStartedAt = nowMs();
try {
  availability = await translatorApi.availability(languageOptions);
  tracePerf("localAi.availability.done", {
    providerType: "chrome-built-in-ai",
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    availability,
    durationMs: elapsedMs(availabilityStartedAt),
    success: true,
  });
} catch (error) {
  tracePerf("localAi.request.error", {
    providerType: "chrome-built-in-ai",
    requestType: "availability",
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    durationMs: elapsedMs(availabilityStartedAt),
    success: false,
    ...metadataForError(error),
  });
  throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
}
```

Around `translatorApi.create`:

```ts
const createStartedAt = nowMs();
try {
  const translator = await translatorApi.create({
    ...languageOptions,
    signal: options.abortSignal,
  });
  tracePerf("localAi.createTranslator.done", {
    providerType: "chrome-built-in-ai",
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    durationMs: elapsedMs(createStartedAt),
    success: true,
  });
  return translator;
} catch (error) {
  tracePerf("localAi.request.error", {
    providerType: "chrome-built-in-ai",
    requestType: "createTranslator",
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    durationMs: elapsedMs(createStartedAt),
    success: false,
    ...metadataForError(error),
  });
  throw mapTranslatorError(error, options.abortSignal?.aborted ?? false);
}
```

- [ ] **Step 5: Trace text and batch translation**

In `translateText`, around `translator.translate`:

```ts
const translateStartedAt = nowMs();
const translatedText = await translator.translate(request.text, {
  signal: request.abortSignal,
});
tracePerf("localAi.translate.segment.done", {
  ...request.traceContext,
  providerType: "chrome-built-in-ai",
  segmentId: "selection",
  segmentOrder: 1,
  sourceCharCount: request.text.length,
  durationMs: elapsedMs(translateStartedAt),
  success: true,
});
return { translatedText };
```

In `translateBatch`, record a batch timer and per segment timer:

```ts
const batchStartedAt = nowMs();
const items = [];
for (const segment of request.segments) {
  const segmentStartedAt = nowMs();
  const translatedText = await translator.translate(segment.sourceText, {
    signal: request.abortSignal,
  });
  tracePerf("localAi.translate.segment.done", {
    ...request.traceContext,
    providerType: "chrome-built-in-ai",
    segmentId: segment.id,
    segmentOrder: segment.order,
    sourceCharCount: segment.sourceText.length,
    durationMs: elapsedMs(segmentStartedAt),
    success: true,
  });
  items.push({
    segmentId: segment.id,
    translatedText,
  });
}

tracePerf("localAi.translate.batch.done", {
  ...request.traceContext,
  providerType: "chrome-built-in-ai",
  segmentCount: request.segments.length,
  sourceCharCount: request.segments.reduce(
    (total, segment) => total + segment.sourceText.length,
    0,
  ),
  durationMs: elapsedMs(batchStartedAt),
  success: true,
});

return { items };
```

- [ ] **Step 6: Trace offscreen ensureDocument and requests**

In `ensureDocument`, record whether a document was created:

```ts
const startedAt = nowMs();
let createdDocument = false;
try {
  if (!this.runtime || !this.offscreen) {
    const error = new Error("Chrome offscreen APIs are not available.");
    error.name = "ApiUnavailableError";
    throw error;
  }

  const documentUrl = this.runtime.getURL(CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT);
  const contexts = await this.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });

  if (contexts && contexts.length > 0) {
    tracePerf("localAi.offscreen.ensureDocument.done", {
      providerType: "chrome-built-in-ai",
      createdDocument,
      durationMs: elapsedMs(startedAt),
      success: true,
    });
    return;
  }

  createdDocument = true;
  this.creatingDocument ??= this.offscreen
    .createDocument({
      url: CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT,
      reasons: ["DOM_PARSER"],
      justification:
        "Run Chrome Built-in AI Translator API from an extension document context.",
    })
    .finally(() => {
      this.creatingDocument = undefined;
    });

  await this.creatingDocument;
  tracePerf("localAi.offscreen.ensureDocument.done", {
    providerType: "chrome-built-in-ai",
    createdDocument,
    durationMs: elapsedMs(startedAt),
    success: true,
  });
} catch (error) {
  tracePerf("localAi.request.error", {
    providerType: "chrome-built-in-ai",
    requestType: "ensureDocument",
    durationMs: elapsedMs(startedAt),
    success: false,
    ...metadataForError(error),
  });
  throw error;
}
```

In `sendRequest`, around `session.send`:

```ts
const startedAt = nowMs();
try {
  const response = await session.send(request, signal, { disconnectOnSettle: true });
  tracePerf("localAi.offscreen.request.done", {
    providerType: "chrome-built-in-ai",
    requestType: request.type,
    durationMs: elapsedMs(startedAt),
    success: true,
  });
  return response;
} catch (error) {
  tracePerf("localAi.request.error", {
    providerType: "chrome-built-in-ai",
    requestType: request.type,
    durationMs: elapsedMs(startedAt),
    success: false,
    ...metadataForError(error),
  });
  session.disconnect();
  throw error;
}
```

In `detectLanguage`, wrap the request and emit:

```ts
const startedAt = nowMs();
const response = await this.sendRequest(
  {
    requestId: createRequestId(),
    type: "chromeBuiltInAi.detectLanguage",
    text,
  },
  signal,
);
tracePerf("localAi.detectLanguage.done", {
  providerType: "chrome-built-in-ai",
  sourceCharCount: text.length,
  detectedLanguage: response.detectedLanguage,
  durationMs: elapsedMs(startedAt),
  success: true,
});
return response.detectedLanguage;
```

- [ ] **Step 7: Run Chrome provider tests**

Run:

```bash
pnpm vitest run tests/provider/chromeBuiltInAi.test.ts tests/provider/chromeBuiltInAiOffscreenClient.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 8: Commit Chrome Built-in AI tracing**

```bash
git add src/provider/chromeBuiltInAi.ts src/provider/chromeBuiltInAiOffscreenClient.ts tests/provider/chromeBuiltInAi.test.ts tests/provider/chromeBuiltInAiOffscreenClient.test.ts
git commit -m "feat: trace chrome built-in ai latency"
```

---

### Task 5: Trace Background Orchestrator Batches

**Files:**
- Modify: `src/background/taskOrchestrator.ts`
- Test: `tests/background/taskOrchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator trace test**

Add to `tests/background/taskOrchestrator.test.ts` near existing basic translate page tests:

```ts
it("traces provider batches and forwards trace context", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const { orchestrator, translateBatch, sendToContent } = createOrchestrator();
  sendToContent.mockResolvedValueOnce({
    type: "collectSegmentsResult",
    taskId: "task-1",
    collectionComplete: true,
    segments: [
      {
        id: "seg_1",
        order: 1,
        sourceText: "Hello",
        kind: "paragraph",
        priority: "viewport",
        pathHint: "p:nth-child(1)",
        textHash: "hash-1",
      },
    ],
  });
  translateBatch.mockResolvedValue({
    items: [{ segmentId: "seg_1", translatedText: "你好" }],
  });
  sendToContent.mockResolvedValueOnce({
    type: "contentActionResult",
    success: true,
    appliedSegmentIds: ["seg_1"],
    failedSegmentIds: [],
  });

  await orchestrator.translatePage({
    tabId: 7,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    translationMode: "fullPage",
  });

  expect(translateBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      traceContext: expect.objectContaining({
        taskId: "task-1",
        batchId: expect.stringMatching(/^batch-/),
        stage: "page",
      }),
    }),
  );
  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("translation.task.start");
  expect(rendered).toContain("translation.collect.done");
  expect(rendered).toContain("translation.batch.start");
  expect(rendered).toContain("translation.batch.done");
  expect(rendered).toContain("translation.batch.apply.done");
});
```

- [ ] **Step 2: Run failing orchestrator test**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts --testNamePattern "traces provider batches"
```

Expected: FAIL because batch trace context and events are not implemented.

- [ ] **Step 3: Add imports and batch id state**

Modify `src/background/taskOrchestrator.ts`:

```ts
import {
  elapsedMs,
  metadataForError,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

Add class field:

```ts
private nextBatchSequence = 0;
```

Add helper methods:

```ts
private createBatchId(): string {
  this.nextBatchSequence += 1;
  return `batch-${this.nextBatchSequence}`;
}

private sourceCharCount(segments: readonly PageSegment[]): number {
  return segments.reduce((total, segment) => total + segment.sourceText.length, 0);
}

private traceStageForTask(task: RunningTask): "page" | "lazy" {
  return task.context?.translationMode === "lazyViewport" ? "lazy" : "page";
}
```

- [ ] **Step 4: Trace task, collect, and language detection**

In `createTranslatePageTask` after task creation:

```ts
tracePerf("translation.task.start", {
  taskId: task.progress.taskId,
  translationMode: task.pendingContext?.translationMode,
});
```

In `executeTranslatePage`, around `sendToContent(... collectSegments ...)`:

```ts
const collectStartedAt = nowMs();
const collectResponse = await this.dependencies.sendToContent(input.tabId, {
  type: "collectSegments",
  taskId: task.progress.taskId,
  translationMode: context.translationMode,
  sourceLanguage: context.sourceLanguage,
  deferLazyCollection:
    profile.type === "chrome-built-in-ai" &&
    context.sourceLanguage === "auto" &&
    context.translationMode === "lazyViewport",
  targetLanguage: context.targetLanguage,
  providerId: profile.id,
  textModel: isOpenAiCompatibleProviderProfile(profile) ? profile.textModel : undefined,
});
```

After validating `collectResponse`:

```ts
tracePerf("translation.collect.done", {
  taskId: task.progress.taskId,
  translationMode: context.translationMode,
  segmentCount: collectResponse.segments.length,
  sourceCharCount: this.sourceCharCount(collectResponse.segments),
  durationMs: elapsedMs(collectStartedAt),
  success: true,
});
```

Around `resolveSourceLanguageForProfile`:

```ts
const detectStartedAt = nowMs();
const sourceLanguage = await this.resolveSourceLanguageForProfile(
  profile,
  context.sourceLanguage,
  collectedSegments,
  task.controller.signal,
  context.translationMode === "lazyViewport",
);
tracePerf("translation.detectLanguage.done", {
  taskId: task.progress.taskId,
  providerType: profile.type,
  sourceLanguage,
  durationMs: elapsedMs(detectStartedAt),
  success: true,
});
```

- [ ] **Step 5: Trace provider batches and pass trace context**

In `translateBatchWithFallback`, create batch metadata:

```ts
const batchId = this.createBatchId();
const batchStartedAt = nowMs();
const providerType = input.profile.type;
tracePerf("translation.batch.start", {
  taskId: input.task.progress.taskId,
  batchId,
  attempt,
  providerType,
  stage: this.traceStageForTask(input.task),
  segmentCount: input.segments.length,
  sourceCharCount: this.sourceCharCount(input.segments),
  currentConcurrency: input.task.currentConcurrency,
});
```

Pass `batchId` into request functions by extending `TranslationBatchInput`:

```ts
type TranslationBatchInput = TaskTranslationContext & {
  task: RunningTask;
  segments: PageSegment[];
  fanOutGroups: Map<string, PageSegment[]>;
  batchId?: string;
};
```

Call request with batch id:

```ts
const result = await this.requestAndApplyBatch({ ...input, batchId });
```

On success:

```ts
tracePerf("translation.batch.done", {
  taskId: input.task.progress.taskId,
  batchId,
  attempt,
  providerType,
  returnedCount: input.segments.length - result.missingSegments.length,
  missingCount: result.missingSegments.length,
  durationMs: elapsedMs(batchStartedAt),
  success: !result.error,
});
```

If missing:

```ts
if (result.missingSegments.length > 0) {
  tracePerf("translation.batch.missing", {
    taskId: input.task.progress.taskId,
    batchId,
    attempt,
    providerType,
    segmentCount: input.segments.length,
    missingCount: result.missingSegments.length,
  });
}
```

In catch:

```ts
tracePerf("translation.batch.done", {
  taskId: input.task.progress.taskId,
  batchId,
  attempt,
  providerType,
  segmentCount: input.segments.length,
  durationMs: elapsedMs(batchStartedAt),
  success: false,
  ...metadataForError(error),
});
```

- [ ] **Step 6: Forward trace context to streaming and buffered providers**

In `requestAndApplyStreamingBatch`:

```ts
for await (const response of provider.streamBatch({
  profile: input.profile,
  sourceLanguage: input.sourceLanguage,
  targetLanguage: input.targetLanguage,
  segments: input.segments,
  abortSignal: input.task.controller.signal,
  traceContext: {
    taskId: input.task.progress.taskId,
    batchId: input.batchId,
    stage: this.traceStageForTask(input.task),
    providerType: input.profile.type,
    segmentCount: input.segments.length,
    sourceCharCount: this.sourceCharCount(input.segments),
  },
})) {
```

In `requestAndApplyBufferedBatch`:

```ts
response = await provider.translateBatch({
  profile: input.profile,
  sourceLanguage: input.sourceLanguage,
  targetLanguage: input.targetLanguage,
  segments: input.segments,
  abortSignal: input.task.controller.signal,
  traceContext: {
    taskId: input.task.progress.taskId,
    batchId: input.batchId,
    stage: this.traceStageForTask(input.task),
    providerType: input.profile.type,
    segmentCount: input.segments.length,
    sourceCharCount: this.sourceCharCount(input.segments),
  },
});
```

- [ ] **Step 7: Trace retries, apply, and concurrency changes**

In `retryOrDegradeBatch`, before retry:

```ts
tracePerf("translation.batch.retry", {
  taskId: input.task.progress.taskId,
  batchId: input.batchId,
  attempt,
  providerType: input.profile.type,
  reason: attempt + 1 < maxBatchAttempts ? "retry" : "degrade",
  segmentCount: input.segments.length,
});
```

In `applyTranslations`, around `sendToContent`:

```ts
const startedAt = nowMs();
const response = await this.dependencies.sendToContent(task.tabId, {
  type: "applyTranslations",
  taskId: task.progress.taskId,
  items,
});
```

After content result:

```ts
tracePerf("translation.batch.apply.done", {
  taskId: task.progress.taskId,
  itemCount: items.length,
  appliedCount: appliedItems.length,
  failedCount: explicitFailures.length + implicitFailures.length,
  durationMs: elapsedMs(startedAt),
  success: response.success,
});
```

In `handleBatchError`, before lowering concurrency:

```ts
const previousConcurrency = task.currentConcurrency;
task.currentConcurrency = minConcurrency;
tracePerf("translation.concurrency.changed", {
  taskId: task.progress.taskId,
  previousConcurrency,
  nextConcurrency: task.currentConcurrency,
  reason: "rateLimited",
});
```

In `recordSuccessfulBatch`, before restoring concurrency:

```ts
const previousConcurrency = task.currentConcurrency;
task.currentConcurrency = defaultConcurrency;
tracePerf("translation.concurrency.changed", {
  taskId: task.progress.taskId,
  previousConcurrency,
  nextConcurrency: task.currentConcurrency,
  reason: "successfulBatches",
});
```

- [ ] **Step 8: Run orchestrator tests**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 9: Commit orchestrator tracing**

```bash
git add src/background/taskOrchestrator.ts tests/background/taskOrchestrator.test.ts
git commit -m "feat: trace translation batches"
```

---

### Task 6: Trace Content Runtime and Selection Flow Boundaries

**Files:**
- Modify: `src/content/pageRuntime.ts`
- Modify: `src/content/selectionPanel.ts`
- Modify: `src/background/selectionTranslation.ts`
- Test: `tests/content/pageRuntime.test.ts`
- Test: `tests/content/selectionPanel.test.ts`
- Test: `tests/background/selectionTranslation.test.ts`

- [ ] **Step 1: Write failing selection flow test**

Add to `tests/background/selectionTranslation.test.ts`:

```ts
it("traces selection translation stages and forwards provider trace context", async () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

  await translateSelection(
    {
      tabId: 42,
      text: "  Hello  ",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    },
    dependencies(),
  );

  expect(translateText).toHaveBeenCalledWith(
    expect.objectContaining({
      traceContext: expect.objectContaining({
        stage: "selection",
        providerType: "openai-compatible",
        segmentCount: 1,
        sourceCharCount: 5,
      }),
    }),
  );
  const rendered = infoSpy.mock.calls
    .map((call) => JSON.stringify(call))
    .join("\n");
  expect(rendered).toContain("selection.translate.start");
  expect(rendered).toContain("selection.profile.done");
  expect(rendered).toContain("selection.provider.done");
  expect(rendered).toContain("selection.showResult.done");
});
```

Add to `tests/content/selectionPanel.test.ts`:

```ts
it("traces selection panel rendering", () => {
  vi.stubEnv("DEV", true);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

  showSelectionTranslation({
    sourceText: "Hello",
    translatedText: "你好",
  });

  expect(infoSpy).toHaveBeenCalledWith(
    "[yoyo:perf] content.selectionPanel.done",
    expect.objectContaining({
      sourceCharCount: 5,
      success: true,
    }),
  );
});
```

- [ ] **Step 2: Run failing content/selection tests**

Run:

```bash
pnpm vitest run tests/background/selectionTranslation.test.ts tests/content/selectionPanel.test.ts
```

Expected: FAIL because content/selection trace events are not emitted.

- [ ] **Step 3: Trace selection translation stages**

Modify `src/background/selectionTranslation.ts` imports:

```ts
import {
  elapsedMs,
  metadataForError,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

Inside `translateSelection`:

```ts
const startedAt = nowMs();
tracePerf("selection.translate.start", {
  stage: "selection",
  sourceLanguage: input.sourceLanguage,
  targetLanguage: input.targetLanguage,
  sourceCharCount: sourceText.length,
});
```

Around active profile:

```ts
const profileStartedAt = nowMs();
const profile = await dependencies.getActiveProfile();
tracePerf("selection.profile.done", {
  stage: "selection",
  providerType: profile?.type,
  durationMs: elapsedMs(profileStartedAt),
  success: Boolean(profile),
});
```

Around source language detection:

```ts
const detectStartedAt = nowMs();
const sourceLanguage = await resolveSelectionSourceLanguage(
  sourceText,
  input.sourceLanguage,
  profile,
  dependencies,
);
tracePerf("selection.detectLanguage.done", {
  stage: "selection",
  providerType: profile.type,
  sourceLanguage,
  durationMs: elapsedMs(detectStartedAt),
  success: true,
});
```

Around Chrome Built-in AI prepare:

```ts
const prepareStartedAt = nowMs();
await dependencies.prepareChromeBuiltInAi?.(
  sourceLanguage,
  input.targetLanguage,
);
tracePerf("selection.prepareLocalAi.done", {
  stage: "selection",
  providerType: "chrome-built-in-ai",
  sourceLanguage,
  targetLanguage: input.targetLanguage,
  durationMs: elapsedMs(prepareStartedAt),
  success: true,
});
```

Pass trace context into provider:

```ts
const providerStartedAt = nowMs();
const response = await dependencies.getTranslationProvider(profile).translateText({
  profile,
  sourceLanguage,
  targetLanguage: input.targetLanguage,
  text: sourceText,
  traceContext: {
    stage: "selection",
    providerType: profile.type,
    segmentCount: 1,
    sourceCharCount: sourceText.length,
  },
});
tracePerf("selection.provider.done", {
  stage: "selection",
  providerType: profile.type,
  sourceCharCount: sourceText.length,
  outputCharCount: response.translatedText.length,
  durationMs: elapsedMs(providerStartedAt),
  success: true,
});
```

Around `sendToContent`:

```ts
const showStartedAt = nowMs();
await dependencies.sendToContent(input.tabId, {
  type: "showSelectionTranslation",
  sourceText,
  translatedText: response.translatedText,
});
tracePerf("selection.showResult.done", {
  stage: "selection",
  providerType: profile.type,
  durationMs: elapsedMs(showStartedAt),
  success: true,
});
```

In catch:

```ts
tracePerf("selection.translate.error", {
  stage: "selection",
  durationMs: elapsedMs(startedAt),
  success: false,
  ...metadataForError(error),
});
```

- [ ] **Step 4: Trace selection panel rendering**

Modify `src/content/selectionPanel.ts`:

```ts
import {
  elapsedMs,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

At the top of `showSelectionTranslation`:

```ts
const startedAt = nowMs();
```

After `document.body.append(panel);`:

```ts
tracePerf("content.selectionPanel.done", {
  stage: "selection",
  sourceCharCount: input.sourceText.length,
  outputCharCount:
    input.errorMessage !== undefined
      ? input.errorMessage.length
      : (input.translatedText ?? "").length,
  durationMs: elapsedMs(startedAt),
  success: input.errorMessage === undefined,
});
```

- [ ] **Step 5: Trace content page runtime boundaries**

Modify `src/content/pageRuntime.ts` imports:

```ts
import {
  elapsedMs,
  nowMs,
  tracePerf,
} from "@/utils/perfTrace";
```

In `collectSegments`, before `collectPageSegments`:

```ts
const collectStartedAt = nowMs();
```

Before `return segments;`:

```ts
tracePerf("content.collectSegments.done", {
  taskId,
  translationMode,
  segmentCount: segments.length,
  sourceCharCount: segments.reduce(
    (total, segment) => total + segment.sourceText.length,
    0,
  ),
  durationMs: elapsedMs(collectStartedAt),
  success: true,
});
```

In `flushTranslationQueue`, before `sendRuntimeMessage`:

```ts
const flushStartedAt = nowMs();
tracePerf("content.queue.flush.start", {
  taskId: context.taskId,
  translationMode: context.translationMode,
  segmentCount: segments.length,
  retryCount: retrySegments.length,
  failedReportCount: failedSegments.length,
});
```

After response handling starts:

```ts
tracePerf("content.queue.flush.done", {
  taskId: context.taskId,
  translationMode: context.translationMode,
  segmentCount: segments.length,
  retryCount: retrySegments.length,
  failedReportCount: failedSegments.length,
  durationMs: elapsedMs(flushStartedAt),
  success: response?.type === "taskProgress",
});
```

In `applyTranslationResults`, wrap `applyTranslations`:

```ts
const startedAt = nowMs();
const result = applyTranslations(currentAnchors, taskId, items);
tracePerf("content.applyTranslations.done", {
  taskId,
  itemCount: items.length,
  appliedCount: result.appliedSegmentIds.length,
  failedCount: result.failedSegmentIds.length,
  durationMs: elapsedMs(startedAt),
  success: result.failedSegmentIds.length === 0,
});
```

- [ ] **Step 6: Run content and selection tests**

Run:

```bash
pnpm vitest run tests/background/selectionTranslation.test.ts tests/content/selectionPanel.test.ts tests/content/pageRuntime.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 7: Commit content and selection tracing**

```bash
git add src/background/selectionTranslation.ts src/content/pageRuntime.ts src/content/selectionPanel.ts tests/background/selectionTranslation.test.ts tests/content/selectionPanel.test.ts tests/content/pageRuntime.test.ts
git commit -m "feat: trace content and selection latency"
```

---

### Task 7: Full Verification and Privacy Check

**Files:**
- No new source files expected.
- May modify tests if verification reveals broken assertions from trace metadata shape.

- [ ] **Step 1: Run targeted performance tracing test suites**

Run:

```bash
pnpm vitest run \
  tests/utils/perfTrace.test.ts \
  tests/provider/openAiCompatible.test.ts \
  tests/provider/openAiTranslationAdapter.test.ts \
  tests/provider/chromeBuiltInAi.test.ts \
  tests/provider/chromeBuiltInAiOffscreenClient.test.ts \
  tests/background/taskOrchestrator.test.ts \
  tests/background/selectionTranslation.test.ts \
  tests/content/pageRuntime.test.ts \
  tests/content/selectionPanel.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full automated checks**

Run:

```bash
pnpm test
pnpm lint
pnpm compile
```

Expected: PASS.

- [ ] **Step 3: Build the extension**

Run:

```bash
pnpm build
```

Expected: PASS and WXT build output generated under `.output`.

- [ ] **Step 4: Manual privacy inspection**

Run:

```bash
rg -n "sourceText|translatedText|prompt|apiKey|authorization|Bearer|baseURL" src/utils/perfTrace.ts src/provider src/background src/content
```

Expected:

- Matches in normal provider request construction are allowed.
- No `tracePerf(...)` call passes `sourceText`, `translatedText`, `prompt`, `apiKey`, `authorization`, `Bearer`, or `baseURL`.
- `tracePerf(...)` calls only pass counts, IDs, provider type, model, status, error code/name, and durations.

- [ ] **Step 5: Manual browser smoke check**

Run:

```bash
pnpm dev
```

Expected:

- WXT starts a development browser session.
- For page translation first screen, DevTools console contains:
  - `[yoyo:perf] translation.task.start`
  - `[yoyo:perf] translation.collect.done`
  - `[yoyo:perf] translation.batch.start`
  - `[yoyo:perf] llm.request.start` or `[yoyo:perf] localAi.createTranslator.done`
  - `[yoyo:perf] translation.batch.apply.done`
- For lazy scroll translation, DevTools console contains:
  - `[yoyo:perf] content.queue.flush.start`
  - `[yoyo:perf] content.queue.flush.done`
  - batch and provider events sharing the same taskId.
- For selection translation, DevTools console contains:
  - `[yoyo:perf] selection.translate.start`
  - `[yoyo:perf] selection.provider.done`
  - `[yoyo:perf] content.selectionPanel.done`
- Console output does not include selected text, page text, prompt, translated text, API key, Authorization header, or full provider URL.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 1-5 required test or source fixes, commit them:

```bash
git add src tests
git commit -m "test: verify performance tracing"
```

If no fixes were needed, do not create an empty commit.
