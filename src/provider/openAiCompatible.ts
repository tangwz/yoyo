import { mapHttpStatusToProviderError, ProviderError } from "@/provider/errors";
import type { GenerateTextRequest, GenerateTextResponse } from "@/provider/types";

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export class OpenAiCompatibleProvider {
  async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    const timeoutMs = request.profile.requestParams?.timeoutMs ?? 30000;
    const timeoutController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), timeoutMs);

    const abortForwarder = () => timeoutController.abort();
    request.abortSignal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const response = await fetch(joinUrl(request.profile.baseURL, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.profile.apiKey}`,
        },
        body: JSON.stringify({
          model: request.profile.textModel,
          messages: [{ role: "user", content: request.prompt }],
          temperature: request.profile.requestParams?.temperature ?? 0.2,
          max_tokens: request.profile.requestParams?.maxTokens ?? 1200,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        throw mapHttpStatusToProviderError(response.status, await response.text());
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const text = payload.choices?.[0]?.message?.content;
      if (!text) {
        throw new ProviderError("invalidResponse", "Provider response did not include text.");
      }

      return {
        text,
        model: payload.model ?? request.profile.textModel,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError(
          request.abortSignal?.aborted ? "aborted" : "timeout",
          request.abortSignal?.aborted
            ? "Provider request was aborted."
            : "Provider request timed out.",
        );
      }
      throw new ProviderError("networkError", "Provider request failed before receiving a response.");
    } finally {
      globalThis.clearTimeout(timeoutId);
      request.abortSignal?.removeEventListener("abort", abortForwarder);
    }
  }
}
