import { mapHttpStatusToProviderError, ProviderError } from "@/provider/errors";
import { createTextModelCandidates } from "@/provider/modelNames";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  StreamTextChunk,
  StreamTextRequest,
} from "@/provider/types";

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ChatCompletionStreamResponse = {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
};

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.trim().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function getChatCompletionsUrl(baseURL: string): string {
  const normalizedBaseURL = baseURL.trim().replace(/\/+$/, "");

  try {
    const url = new URL(normalizedBaseURL);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(normalizedPath)) {
      return normalizedBaseURL;
    }

    url.pathname = `${normalizedPath}/chat/completions`;
    return url.toString();
  } catch {
    if (/\/chat\/completions$/i.test(normalizedBaseURL)) {
      return normalizedBaseURL;
    }
  }

  if (/\/chat\/completions(?:[?#].*)?$/i.test(normalizedBaseURL)) {
    return normalizedBaseURL;
  }

  return joinUrl(normalizedBaseURL, "/chat/completions");
}

type AbortSource = "timeout" | "user";

function canRetryWithNextModelCandidate(error: ProviderError): boolean {
  return (
    error.code === "invalidRequest" &&
    (error.status === 400 || error.status === 404 || error.status === 422)
  );
}

export class OpenAiCompatibleProvider {
  async testConnection(profile: GenerateTextRequest["profile"]): Promise<GenerateTextResponse> {
    const testProfile = {
      ...profile,
      requestParams: {
        ...profile.requestParams,
        temperature: 0,
        maxTokens: 32,
      },
    };
    const response = await this.generateText(
      {
        profile: testProfile,
        prompt: "Reply with exactly: ok",
      },
      createTextModelCandidates(testProfile, { preferLowerCase: true }),
    );

    if (response.text.trim().toLowerCase() !== "ok") {
      throw new ProviderError(
        "invalidResponse",
        "Provider test response did not match the expected text.",
      );
    }

    return response;
  }

  async generateText(
    request: GenerateTextRequest,
    modelCandidates = createTextModelCandidates(request.profile),
  ): Promise<GenerateTextResponse> {
    if (request.abortSignal?.aborted) {
      throw new ProviderError("aborted", "Provider request was aborted.");
    }

    const timeoutMs = request.profile.requestParams?.timeoutMs ?? 30000;
    const timeoutController = new AbortController();
    let abortSource: AbortSource | undefined;
    const abortWithSource = (source: AbortSource) => {
      abortSource ??= source;
      timeoutController.abort();
    };
    const timeoutId = globalThis.setTimeout(() => abortWithSource("timeout"), timeoutMs);

    const abortForwarder = () => abortWithSource("user");
    request.abortSignal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      for (let index = 0; index < modelCandidates.length; index += 1) {
        const model = modelCandidates[index];
        if (model === undefined) {
          continue;
        }

        try {
          return await this.generateTextWithModel(request, model, timeoutController.signal);
        } catch (error) {
          if (
            error instanceof ProviderError &&
            canRetryWithNextModelCandidate(error) &&
            index + 1 < modelCandidates.length
          ) {
            continue;
          }

          throw error;
        }
      }

      throw new ProviderError("invalidRequest", "Provider rejected the request.");
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError(
          abortSource === "user" ? "aborted" : "timeout",
          abortSource === "user" ? "Provider request was aborted." : "Provider request timed out.",
          undefined,
          error,
        );
      }
      throw new ProviderError(
        "networkError",
        "Provider request failed before receiving a response.",
        undefined,
        error,
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
      request.abortSignal?.removeEventListener("abort", abortForwarder);
    }
  }

  async *streamText(
    request: StreamTextRequest,
    modelCandidates = createTextModelCandidates(request.profile),
  ): AsyncGenerator<StreamTextChunk> {
    if (request.abortSignal?.aborted) {
      throw new ProviderError("aborted", "Provider request was aborted.");
    }

    const timeoutMs = request.profile.requestParams?.timeoutMs ?? 30000;
    const timeoutController = new AbortController();
    let abortSource: AbortSource | undefined;
    const abortWithSource = (source: AbortSource) => {
      abortSource ??= source;
      timeoutController.abort();
    };
    const timeoutId = globalThis.setTimeout(() => abortWithSource("timeout"), timeoutMs);

    const abortForwarder = () => abortWithSource("user");
    request.abortSignal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      for (let index = 0; index < modelCandidates.length; index += 1) {
        const model = modelCandidates[index];
        if (model === undefined) {
          continue;
        }

        try {
          yield* this.streamTextWithModel(request, model, timeoutController.signal);
          return;
        } catch (error) {
          if (
            error instanceof ProviderError &&
            canRetryWithNextModelCandidate(error) &&
            index + 1 < modelCandidates.length
          ) {
            continue;
          }

          throw error;
        }
      }

      throw new ProviderError("invalidRequest", "Provider rejected the request.");
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError(
          abortSource === "user" ? "aborted" : "timeout",
          abortSource === "user" ? "Provider request was aborted." : "Provider request timed out.",
          undefined,
          error,
        );
      }
      throw new ProviderError(
        "networkError",
        "Provider request failed before receiving a response.",
        undefined,
        error,
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
      request.abortSignal?.removeEventListener("abort", abortForwarder);
    }
  }

  private async generateTextWithModel(
    request: GenerateTextRequest,
    model: string,
    signal: AbortSignal,
  ): Promise<GenerateTextResponse> {
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

    if (!response.ok) {
      throw mapHttpStatusToProviderError(response.status, await response.text());
    }

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

    return {
      text,
      model: payload.model ?? model,
    };
  }

  private async *streamTextWithModel(
    request: StreamTextRequest,
    model: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamTextChunk> {
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
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw mapHttpStatusToProviderError(response.status, await response.text());
    }

    if (!response.body) {
      throw new ProviderError("invalidResponse", "Provider response did not include a stream.");
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      throw new ProviderError("invalidResponse", "Provider streaming response was not SSE.");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const chunk = parseStreamEvent(event);
          if (chunk === "done") {
            return;
          }
          if (chunk) {
            yield chunk;
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const chunk = parseStreamEvent(buffer);
        if (chunk && chunk !== "done") {
          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseStreamEvent(event: string): StreamTextChunk | "done" | undefined {
  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return undefined;
  }

  const data = dataLines.join("\n").trimEnd();
  if (data === "[DONE]") {
    return "done";
  }

  let payload: ChatCompletionStreamResponse;
  try {
    payload = JSON.parse(data) as ChatCompletionStreamResponse;
  } catch (error) {
    throw new ProviderError(
      "invalidResponse",
      "Provider stream included invalid JSON.",
      undefined,
      error,
    );
  }

  const text = payload.choices?.[0]?.delta?.content;
  return typeof text === "string" && text.length > 0
    ? { text, model: payload.model }
    : undefined;
}
