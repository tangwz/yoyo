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
  });

  it("maps unauthorized responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    const provider = new OpenAiCompatibleProvider();

    await expect(provider.generateText({ profile, prompt: "Hello" })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
