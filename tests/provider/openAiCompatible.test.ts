import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "@/provider/openAiCompatible";
import type { ProviderProfile } from "@/provider/types";

const profile: ProviderProfile = {
  id: "provider-1",
  displayName: "Test Provider",
  type: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "secret",
  textModel: "model-a",
  requestParams: { temperature: 0.2, maxTokens: 1200, timeoutMs: 1000 },
};

describe("OpenAiCompatibleProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends a chat completions request and normalizes text", async () => {
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
    const response = await provider.generateText({ profile, prompt: "Translate me" });

    expect(response).toEqual({ text: "translated text", model: "model-a" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "model-a",
      messages: [{ role: "user", content: "Translate me" }],
      temperature: 0.2,
      max_tokens: 1200,
    });
  });

  it("traces non-streaming OpenAI-compatible LLM calls without logging the prompt", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "translated text" } }],
            model: "model-a",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile,
      prompt: "Private prompt",
      traceContext: {
        taskId: "task-1",
        batchId: "batch-1",
        stage: "page",
        providerType: "openai-compatible",
        segmentCount: 2,
        sourceCharCount: 19,
      },
    });

    const serializedCalls = JSON.stringify(infoSpy.mock.calls);
    expect(serializedCalls).toContain("llm.request.start");
    expect(serializedCalls).toContain("llm.fetch.response");
    expect(serializedCalls).toContain("llm.response.json.done");
    expect(serializedCalls).toContain("task-1");
    expect(serializedCalls).toContain("batch-1");
    expect(serializedCalls).not.toContain("Private prompt");
  });

  it("streams chat completion deltas from an OpenAI-compatible SSE response", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"{\\"id\\":\\"a\\","}}]}',
              "",
              'data: {"choices":[{"delta":{"content":"\\"text\\":\\"Alpha\\"}\\n"}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const chunks: string[] = [];
    for await (const chunk of provider.streamText({ profile, prompt: "Translate me" })) {
      chunks.push(chunk.text);
    }

    expect(chunks.join("")).toBe('{"id":"a","text":"Alpha"}\n');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "model-a",
      messages: [{ role: "user", content: "Translate me" }],
      temperature: 0.2,
      max_tokens: 1200,
      stream: true,
    });
  });

  it("traces streaming OpenAI-compatible LLM calls without logging the prompt", async () => {
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
    const chunks: string[] = [];
    for await (const chunk of provider.streamText({ profile, prompt: "Private prompt" })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hello", " world"]);
    const serializedCalls = JSON.stringify(infoSpy.mock.calls);
    expect(serializedCalls).toContain("llm.stream.firstChunk");
    expect(serializedCalls).toContain("llm.stream.done");
    expect(serializedCalls).toContain("chunkCount");
    expect(serializedCalls).not.toContain("Private prompt");
  });

  it("aggregates multi-line SSE data fields before parsing streamed JSON", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":',
              'data: [{"delta":{"content":"Hello"}}]}',
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
    const chunks: string[] = [];
    for await (const chunk of provider.streamText({ profile, prompt: "Translate me" })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hello"]);
  });

  it("rejects non-SSE streaming responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "buffered response" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new OpenAiCompatibleProvider();
    const stream = provider.streamText({ profile, prompt: "Translate me" });

    await expect(stream.next()).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });

  it("maps streaming HTTP errors to provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    );

    const provider = new OpenAiCompatibleProvider();
    const stream = provider.streamText({ profile, prompt: "Hello" });

    await expect(stream.next()).rejects.toMatchObject({
      code: "rateLimited",
      status: 429,
    });
  });

  it("tries a lower-case model candidate when the original model casing is rejected", async () => {
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
    const response = await provider.generateText({
      profile: { ...profile, textModel: "Model-A" },
      prompt: "Translate me",
    });

    expect(response).toEqual({ text: "translated text", model: "model-a" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("Model-A");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).model).toBe("model-a");
  });

  it("traces model candidate retries for retryable invalid requests", async () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 404 }))
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
      prompt: "Translate me",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] llm.request.error",
      expect.objectContaining({
        model: "Model-A",
        stream: false,
        candidateIndex: 0,
        status: 404,
        errorCode: "invalidRequest",
        durationMs: expect.any(Number),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] llm.retry.modelCandidate",
      expect.objectContaining({
        candidateIndex: 0,
        nextCandidateIndex: 1,
        status: 404,
        errorCode: "invalidRequest",
      }),
    );
  });

  it("traces streaming model candidate retries for retryable invalid requests", async () => {
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
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const chunks: string[] = [];
    for await (const chunk of provider.streamText({
      profile: { ...profile, textModel: "Model-A" },
      prompt: "Private prompt",
    })) {
      chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["Hello"]);
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] llm.request.error",
      expect.objectContaining({
        model: "Model-A",
        stream: true,
        candidateIndex: 0,
        status: 404,
        errorCode: "invalidRequest",
        durationMs: expect.any(Number),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] llm.retry.modelCandidate",
      expect.objectContaining({
        candidateIndex: 0,
        nextCandidateIndex: 1,
        status: 404,
        errorCode: "invalidRequest",
      }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("Private prompt");
  });

  it("uses the preset canonical model candidate after the original model during translation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 404 }))
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
    const response = await provider.generateText({
      profile: {
        ...profile,
        presetId: "openai",
        textModel: "GPT-5-MINI",
      },
      prompt: "Translate me",
    });

    expect(response).toEqual({ text: "translated text", model: "gpt-5-mini" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("GPT-5-MINI");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).model).toBe("gpt-5-mini");
  });

  it("uses a pasted chat completions endpoint with query params without appending the path twice", async () => {
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
      profile: {
        ...profile,
        baseURL: "https://api.example.com/v1/chat/completions?api-version=2026-05-01",
      },
      prompt: "Translate me",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions?api-version=2026-05-01",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("appends chat completions before query params on base URLs", async () => {
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
      profile: {
        ...profile,
        baseURL: "https://api.example.com/v1?api-version=2026-05-01",
      },
      prompt: "Translate me",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions?api-version=2026-05-01",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("tests a provider connection with the fixed prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "model-a",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const response = await provider.testConnection(profile);

    expect(response.text).toBe("ok");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[0].content).toBe(
      "Reply with exactly: ok",
    );
  });

  it("bounds provider connection tests to a short deterministic completion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "model-a",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.testConnection({
      ...profile,
      requestParams: {
        timeoutMs: 45000,
        temperature: 1.2,
        maxTokens: 4096,
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "model-a",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      max_tokens: 32,
    });
  });

  it("does not disable thinking for summary requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Summary done." } }],
          model: "model-a",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile,
      prompt: "Summarize",
      traceContext: {
        stage: "summary",
        providerType: "openai-compatible",
        taskId: "summary-task",
        batchId: "batch-summary",
      },
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody).toEqual(
      expect.objectContaining({
        model: "model-a",
        messages: [{ role: "user", content: "Summarize" }],
        temperature: 0.2,
        max_tokens: 1200,
      }),
    );
    expect(requestBody).not.toHaveProperty("thinking");
  });

  it("does not disable thinking for summary requests with Xiaomi MiMo model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Summary done." } }],
          model: "mimo-v2.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile: {
        ...profile,
        id: "xiaomi-mimo",
        presetId: "xiaomi-mimo",
        baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
        textModel: "MiMo-V2.5",
      },
      prompt: "Summarize",
      traceContext: {
        stage: "summary",
        providerType: "openai-compatible",
        taskId: "summary-task",
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(
      expect.objectContaining({
        model: "mimo-v2.5",
        messages: [{ role: "user", content: "Summarize" }],
        max_tokens: 1200,
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).not.toHaveProperty("thinking");
  });

  it("omits temperature and disables thinking for Kimi K2 requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "translated text" } }],
          model: "kimi-k2.6",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile: {
        ...profile,
        id: "kimi",
        presetId: "kimi",
        baseURL: "https://api.moonshot.ai/v1",
        textModel: "kimi-k2.6",
        requestParams: { temperature: 0.7, maxTokens: 2048, timeoutMs: 1000 },
      },
      prompt: "Translate me",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "Translate me" }],
      max_tokens: 2048,
      thinking: { type: "disabled" },
    });
  });

  it("disables thinking for Xiaomi MiMo requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "translated text" } }],
          model: "mimo-v2.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile: {
        ...profile,
        id: "xiaomi-mimo",
        presetId: "xiaomi-mimo",
        baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
        textModel: "MiMo-V2.5",
        requestParams: { temperature: 0.7, maxTokens: 2048, timeoutMs: 1000 },
      },
      prompt: "Translate me",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "mimo-v2.5",
      messages: [{ role: "user", content: "Translate me" }],
      max_tokens: 2048,
      thinking: { type: "disabled" },
    });
  });

  it("detects Kimi K2 request constraints from custom profile model names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "translated text" } }],
          model: "kimi-k2.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile: {
        ...profile,
        id: "custom-kimi-proxy",
        presetId: "custom",
        baseURL: "https://api.example.com/v1",
        textModel: "kimi-k2.5",
        requestParams: { temperature: 0.7, maxTokens: 2048, timeoutMs: 1000 },
      },
      prompt: "Translate me",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "user", content: "Translate me" }],
      max_tokens: 2048,
      thinking: { type: "disabled" },
    });
  });

  it("accepts punctuation-only Kimi K2 provider test variants", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok." } }],
          model: "kimi-k2.6",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const response = await provider.testConnection({
      ...profile,
      id: "kimi",
      presetId: "kimi",
      baseURL: "https://api.moonshot.ai/v1",
      textModel: "kimi-k2.6",
    });

    expect(response).toEqual({ text: "ok.", model: "kimi-k2.6" });
  });

  it("tests MiMo mixed-case input with the lower-case model candidate first", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const response = await provider.testConnection({
      ...profile,
      baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
      textModel: "MiMo-V2.5",
    });

    expect(response.model).toBe("mimo-v2.5");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("mimo-v2.5");
  });

  it("falls back to the original mixed-case model during connection tests when lower-case is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const response = await provider.testConnection({
      ...profile,
      textModel: "Custom-Model",
    });

    expect(response.model).toBe("Custom-Model");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("custom-model");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).model).toBe("Custom-Model");
  });

  it("uses a lower-case Xiaomi MiMo model candidate first without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "translated text" } }],
          model: "mimo-v2.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    await provider.generateText({
      profile: {
        ...profile,
        id: "xiaomi-mimo",
        presetId: "xiaomi-mimo",
        baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
        textModel: "MiMo-V2.5",
      },
      prompt: "Translate me",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("mimo-v2.5");
  });

  it("rejects provider connection tests that do not return ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" } }],
            model: "model-a",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.testConnection(profile)).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });

  it("accepts an empty string response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" } }],
            model: "model-a",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).resolves.toEqual({
      text: "",
      model: "model-a",
    });
  });

  it.each([
    [400, "invalidRequest"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "invalidRequest"],
    [429, "rateLimited"],
    [402, "quotaExceeded"],
    [422, "invalidRequest"],
  ] as const)("maps HTTP %s responses to %s", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Provider error", { status })),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("uses timeoutMs to abort slow requests", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider();
    const request = provider.generateText({
      profile: { ...profile, requestParams: { ...profile.requestParams, timeoutMs: 25 } },
      prompt: "Hello",
    });
    const expectation = expect(request).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps timeout classification when user aborts after timeout fires", async () => {
    vi.useFakeTimers();

    let rejectFetch: ((error: DOMException) => void) | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          rejectFetch = reject;
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();

    const provider = new OpenAiCompatibleProvider();
    const request = provider.generateText({
      profile: { ...profile, requestParams: { ...profile.requestParams, timeoutMs: 25 } },
      prompt: "Hello",
      abortSignal: abortController.signal,
    });
    const expectation = expect(request).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(25);
    abortController.abort();
    rejectFetch?.(new DOMException("The operation was aborted.", "AbortError"));

    await expectation;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not send a request when the abort signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();
    abortController.abort();

    const provider = new OpenAiCompatibleProvider();

    await expect(
      provider.generateText({ profile, prompt: "Hello", abortSignal: abortController.signal }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps in-flight aborts to aborted", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();

    const provider = new OpenAiCompatibleProvider();
    const request = provider.generateText({
      profile,
      prompt: "Hello",
      abortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(request).rejects.toMatchObject({ code: "aborted" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps network failures to networkError without leaking the cause message", async () => {
    const cause = new Error("socket failed for secret");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).rejects.toMatchObject({
      code: "networkError",
      message: "Provider request failed before receiving a response.",
      cause,
    });
  });

  it("maps invalid JSON responses to invalidResponse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).rejects.toMatchObject({
      code: "invalidResponse",
      cause: expect.any(SyntaxError),
    });
  });

  it("maps missing response text to invalidResponse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).rejects.toMatchObject({
      code: "invalidResponse",
    });
  });
});
