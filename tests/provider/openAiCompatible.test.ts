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

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rateLimited"],
    [402, "quotaExceeded"],
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
