import { mapHttpStatusToProviderError, ProviderError } from "@/provider/errors";
import { createTextModelCandidates } from "@/provider/modelNames";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderTraceContext,
  StreamTextChunk,
  StreamTextRequest,
} from "@/provider/types";
import { elapsedMs, metadataForError, nowMs, tracePerf } from "@/utils/perfTrace";

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

type ChatCompletionRequestBody = {
  model: string;
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature?: number;
  stream?: true;
  thinking?: { type: "disabled" };
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

function isKimiK2Model(model: string): boolean {
  return /^kimi-k2\./i.test(model);
}

function isExpectedProviderTestResponse(text: string): boolean {
  return /^ok[.!?]*$/i.test(text.trim());
}

function buildChatCompletionRequestBody(
  request: GenerateTextRequest,
  model: string,
  stream = false,
): ChatCompletionRequestBody {
  const body: ChatCompletionRequestBody = {
    model,
    messages: [{ role: "user", content: request.prompt }],
    max_tokens: request.profile.requestParams?.maxTokens ?? 1200,
  };

  if (stream) {
    body.stream = true;
  }

  if (isKimiK2Model(model)) {
    body.thinking = { type: "disabled" };
  } else {
    body.temperature = request.profile.requestParams?.temperature ?? 0.2;
  }

  return body;
}

function promptTraceMetadata(
  request: GenerateTextRequest | StreamTextRequest,
  model: string,
  candidateIndex: number,
  stream: boolean,
) {
  return {
    ...request.traceContext,
    providerType: "openai-compatible" as const,
    model,
    candidateIndex,
    stream,
    timeoutMs: request.profile.requestParams?.timeoutMs ?? 30000,
    promptCharCount: request.prompt.length,
  };
}

function responseTraceMetadata(
  traceContext: Partial<ProviderTraceContext> | undefined,
  model: string,
  stream: boolean,
) {
  return {
    ...traceContext,
    providerType: "openai-compatible" as const,
    model,
    stream,
  };
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

    if (!isExpectedProviderTestResponse(response.text)) {
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

        tracePerf("llm.request.start", promptTraceMetadata(request, model, index, false));
        try {
          return await this.generateTextWithModel(
            request,
            model,
            index,
            timeoutController.signal,
          );
        } catch (error) {
          if (
            error instanceof ProviderError &&
            canRetryWithNextModelCandidate(error) &&
            index + 1 < modelCandidates.length
          ) {
            tracePerf("llm.retry.modelCandidate", {
              ...request.traceContext,
              providerType: "openai-compatible",
              model,
              candidateIndex: index,
              nextCandidateIndex: index + 1,
              ...metadataForError(error),
            });
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

        tracePerf("llm.request.start", promptTraceMetadata(request, model, index, true));
        try {
          yield* this.streamTextWithModel(
            request,
            model,
            index,
            timeoutController.signal,
          );
          return;
        } catch (error) {
          if (
            error instanceof ProviderError &&
            canRetryWithNextModelCandidate(error) &&
            index + 1 < modelCandidates.length
          ) {
            tracePerf("llm.retry.modelCandidate", {
              ...request.traceContext,
              providerType: "openai-compatible",
              model,
              candidateIndex: index,
              nextCandidateIndex: index + 1,
              ...metadataForError(error),
            });
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
    candidateIndex: number,
    signal: AbortSignal,
  ): Promise<GenerateTextResponse> {
    const startedAt = nowMs();
    const metadata = promptTraceMetadata(request, model, candidateIndex, false);

    try {
      const response = await fetch(getChatCompletionsUrl(request.profile.baseURL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.profile.apiKey}`,
        },
        body: JSON.stringify(buildChatCompletionRequestBody(request, model)),
        signal,
      });

      tracePerf("llm.fetch.response", {
        ...responseTraceMetadata(request.traceContext, model, false),
        status: response.status,
        durationMs: elapsedMs(startedAt),
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

      tracePerf("llm.response.json.done", {
        ...responseTraceMetadata(request.traceContext, payload.model ?? model, false),
        outputCharCount: text.length,
        durationMs: elapsedMs(startedAt),
      });

      return {
        text,
        model: payload.model ?? model,
      };
    } catch (error) {
      tracePerf("llm.request.error", {
        ...metadata,
        durationMs: elapsedMs(startedAt),
        ...metadataForError(error),
      });
      throw error;
    }
  }

  private async *streamTextWithModel(
    request: StreamTextRequest,
    model: string,
    candidateIndex: number,
    signal: AbortSignal,
  ): AsyncGenerator<StreamTextChunk> {
    const startedAt = nowMs();
    const metadata = promptTraceMetadata(request, model, candidateIndex, true);
    let chunkCount = 0;
    let outputCharCount = 0;
    let firstChunkTraced = false;

    try {
      const response = await fetch(getChatCompletionsUrl(request.profile.baseURL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.profile.apiKey}`,
        },
        body: JSON.stringify(buildChatCompletionRequestBody(request, model, true)),
        signal,
      });

      tracePerf("llm.fetch.response", {
        ...responseTraceMetadata(request.traceContext, model, true),
        status: response.status,
        durationMs: elapsedMs(startedAt),
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
              tracePerf("llm.stream.done", {
                ...responseTraceMetadata(request.traceContext, model, true),
                chunkCount,
                outputCharCount,
                durationMs: elapsedMs(startedAt),
              });
              return;
            }
            if (chunk) {
              chunkCount += 1;
              outputCharCount += chunk.text.length;
              if (!firstChunkTraced) {
                firstChunkTraced = true;
                tracePerf("llm.stream.firstChunk", {
                  ...responseTraceMetadata(request.traceContext, chunk.model ?? model, true),
                  durationMs: elapsedMs(startedAt),
                });
              }
              yield chunk;
            }
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          const chunk = parseStreamEvent(buffer);
          if (chunk === "done") {
            tracePerf("llm.stream.done", {
              ...responseTraceMetadata(request.traceContext, model, true),
              chunkCount,
              outputCharCount,
              durationMs: elapsedMs(startedAt),
            });
            return;
          }
          if (chunk) {
            chunkCount += 1;
            outputCharCount += chunk.text.length;
            if (!firstChunkTraced) {
              firstChunkTraced = true;
              tracePerf("llm.stream.firstChunk", {
                ...responseTraceMetadata(request.traceContext, chunk.model ?? model, true),
                durationMs: elapsedMs(startedAt),
              });
            }
            yield chunk;
          }
        }

        tracePerf("llm.stream.done", {
          ...responseTraceMetadata(request.traceContext, model, true),
          chunkCount,
          outputCharCount,
          durationMs: elapsedMs(startedAt),
        });
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      tracePerf("llm.request.error", {
        ...metadata,
        durationMs: elapsedMs(startedAt),
        ...metadataForError(error),
      });
      throw error;
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
