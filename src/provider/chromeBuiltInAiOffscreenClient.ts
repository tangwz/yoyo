import type {
  LanguageDetectorAvailability,
  TranslatorApi,
  TranslatorAvailability,
  TranslatorCreateOptions,
  TranslatorInstance,
  TranslatorLanguageOptions,
  TranslatorTranslateOptions,
} from "@/provider/chromeBuiltInAi";
import { elapsedMs, metadataForError, nowMs, tracePerf } from "@/utils/perfTrace";

export const CHROME_BUILT_IN_AI_OFFSCREEN_PORT = "yoyo.chrome-built-in-ai-offscreen";
export const CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT = "chrome-built-in-ai-offscreen.html";

type ChromeRuntimePort = {
  onMessage: {
    addListener(listener: (message: OffscreenResponse) => void): void;
    removeListener?(listener: (message: OffscreenResponse) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener?(listener: () => void): void;
  };
  postMessage(message: OffscreenRequest): void;
  disconnect(): void;
};

type ChromeRuntimeLike = {
  getURL(path: string): string;
  getContexts?(query: {
    contextTypes: string[];
    documentUrls: string[];
  }): Promise<unknown[]>;
  connect(connectInfo: { name: string }): ChromeRuntimePort;
  lastError?: { message?: string };
};

type ChromeOffscreenLike = {
  createDocument(options: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
};

type ChromeBuiltInAiOffscreenClientDependencies = {
  runtime?: ChromeRuntimeLike;
  offscreen?: ChromeOffscreenLike;
};

const providerType = "chrome-built-in-ai" as const;

type OffscreenRequest =
  | {
      requestId: string;
      type: "chromeBuiltInAi.availability";
      options: TranslatorLanguageOptions;
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.create";
      options: TranslatorLanguageOptions;
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.translate";
      translatorId: string;
      text: string;
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.destroy";
      translatorId: string;
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.cancel";
      cancelledRequestId: string;
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.detectLanguage";
      text: string;
    };

type OffscreenResponse =
  | {
      requestId: string;
      ok: true;
      availability?: TranslatorAvailability;
      detectorAvailability?: LanguageDetectorAvailability;
      detectedLanguage?: string;
      translatorId?: string;
      translatedText?: string;
    }
  | {
      requestId: string;
      ok: false;
      error: { name?: string; message?: string };
    };

function getDefaultRuntime(): ChromeRuntimeLike | undefined {
  return (globalThis as typeof globalThis & { chrome?: { runtime?: ChromeRuntimeLike } })
    .chrome?.runtime;
}

function getDefaultOffscreen(): ChromeOffscreenLike | undefined {
  return (globalThis as typeof globalThis & { chrome?: { offscreen?: ChromeOffscreenLike } })
    .chrome?.offscreen;
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random()}`;
}

function createRemoteError(error: { name?: string; message?: string }): Error {
  const remoteError = new Error(error.message ?? "Chrome Built-in AI offscreen request failed.");
  remoteError.name = error.name ?? "Error";
  return remoteError;
}

class OffscreenPortSession {
  private readonly port: ChromeRuntimePort;
  private disconnected = false;

  constructor(private readonly runtime: ChromeRuntimeLike) {
    this.port = runtime.connect({ name: CHROME_BUILT_IN_AI_OFFSCREEN_PORT });
  }

  async send(
    request: OffscreenRequest,
    signal?: AbortSignal,
    options: { disconnectOnSettle?: boolean } = {},
  ): Promise<Extract<OffscreenResponse, { ok: true }>> {
    if (signal?.aborted) {
      throw new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError");
    }
    if (this.disconnected) {
      throw new Error("Chrome Built-in AI offscreen document disconnected.");
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError"),
        );
        return;
      }

      let settled = false;

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", abortListener);
        this.port.onMessage.removeListener?.(messageListener);
        this.port.onDisconnect.removeListener?.(disconnectListener);
        callback();
        if (options.disconnectOnSettle) {
          this.disconnect();
        }
      };

      const abortListener = () => {
        settle(() => {
          try {
            this.port.postMessage({
              requestId: createRequestId(),
              type: "chromeBuiltInAi.cancel",
              cancelledRequestId: request.requestId,
            });
          } catch {
            // Best effort only; the port may already be disconnected.
          }
          this.disconnect();
          reject(
            new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError"),
          );
        });
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      const messageListener = (response: OffscreenResponse) => {
        if (response.requestId !== request.requestId || settled) {
          return;
        }

        settle(() => {
          if (response.ok) {
            resolve(response);
            return;
          }

          reject(createRemoteError(response.error));
        });
      };

      const disconnectListener = () => {
        this.disconnected = true;
        settle(() =>
          reject(
            new Error(
              this.runtime.lastError?.message ??
                "Chrome Built-in AI offscreen document disconnected.",
            ),
          ),
        );
      };

      this.port.onMessage.addListener(messageListener);
      this.port.onDisconnect.addListener(disconnectListener);
      try {
        this.port.postMessage(request);
      } catch (error) {
        settle(() => {
          this.disconnect();
          reject(
            error instanceof Error
              ? error
              : new Error("Chrome Built-in AI offscreen request could not be sent."),
          );
        });
      }
    });
  }

  disconnect(): void {
    if (this.disconnected) {
      return;
    }

    this.disconnected = true;
    this.port.disconnect();
  }
}

export class ChromeBuiltInAiOffscreenClient implements TranslatorApi {
  private readonly runtime: ChromeRuntimeLike | undefined;
  private readonly offscreen: ChromeOffscreenLike | undefined;
  private creatingDocument: Promise<void> | undefined;

  constructor(dependencies: ChromeBuiltInAiOffscreenClientDependencies = {}) {
    this.runtime = dependencies.runtime ?? getDefaultRuntime();
    this.offscreen = dependencies.offscreen ?? getDefaultOffscreen();
  }

  async availability(options: TranslatorLanguageOptions): Promise<TranslatorAvailability> {
    const response = await this.sendRequest({
      requestId: createRequestId(),
      type: "chromeBuiltInAi.availability",
      options,
    });

    if (!response.availability) {
      throw new Error("Chrome Built-in AI offscreen response omitted availability.");
    }

    return response.availability;
  }

  async create(options: TranslatorCreateOptions): Promise<TranslatorInstance> {
    if (options.signal?.aborted) {
      const error = new DOMException(
        "Chrome Built-in AI translation was cancelled.",
        "AbortError",
      );
      tracePerf("localAi.request.error", {
        providerType,
        requestType: "chromeBuiltInAi.create",
        durationMs: 0,
        success: false,
        ...metadataForError(error),
      });
      throw error;
    }

    const session = await this.createPortSession();
    let response: Extract<OffscreenResponse, { ok: true }>;
    try {
      response = await this.sendSessionRequest(
        session,
        {
          requestId: createRequestId(),
          type: "chromeBuiltInAi.create",
          options: {
            sourceLanguage: options.sourceLanguage,
            targetLanguage: options.targetLanguage,
          },
        },
        options.signal,
      );
    } catch (error) {
      session.disconnect();
      throw error;
    }

    if (!response.translatorId) {
      session.disconnect();
      throw new Error("Chrome Built-in AI offscreen response omitted translatorId.");
    }

    const translatorId = response.translatorId;
    return {
      translate: async (text: string, translateOptions?: TranslatorTranslateOptions) => {
        const startedAt = nowMs();
        if (translateOptions?.signal?.aborted) {
          const error = new DOMException(
            "Chrome Built-in AI translation was cancelled.",
            "AbortError",
          );
          tracePerf("localAi.request.error", {
            providerType,
            requestType: "chromeBuiltInAi.translate",
            durationMs: elapsedMs(startedAt),
            success: false,
            ...metadataForError(error),
          });
          throw error;
        }

        const translateResponse = await this.sendSessionRequest(
          session,
          {
            requestId: createRequestId(),
            type: "chromeBuiltInAi.translate",
            translatorId,
            text,
          },
          translateOptions?.signal,
        );

        if (translateResponse.translatedText === undefined) {
          throw new Error("Chrome Built-in AI offscreen response omitted translatedText.");
        }

        return translateResponse.translatedText;
      },
      destroy: async () => {
        try {
          await this.sendSessionRequest(
            session,
            {
              requestId: createRequestId(),
              type: "chromeBuiltInAi.destroy",
              translatorId,
            },
            undefined,
            { disconnectOnSettle: true },
          );
        } finally {
          session.disconnect();
        }
      },
    };
  }

  async detectLanguage(text: string, signal?: AbortSignal): Promise<string | undefined> {
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
      providerType,
      sourceCharCount: text.length,
      detectedLanguage: response.detectedLanguage,
      durationMs: elapsedMs(startedAt),
      success: true,
    });
    return response.detectedLanguage;
  }

  private async ensureDocument(): Promise<void> {
    const startedAt = nowMs();
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
          providerType,
          createdDocument: false,
          durationMs: elapsedMs(startedAt),
          success: true,
        });
        return;
      }

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
        providerType,
        createdDocument: true,
        durationMs: elapsedMs(startedAt),
        success: true,
      });
    } catch (error) {
      tracePerf("localAi.request.error", {
        providerType,
        requestType: "ensureDocument",
        durationMs: elapsedMs(startedAt),
        success: false,
        ...metadataForError(error),
      });
      throw error;
    }
  }

  private async createPortSession(): Promise<OffscreenPortSession> {
    await this.ensureDocument();

    if (!this.runtime) {
      const error = new Error("Chrome offscreen APIs are not available.");
      error.name = "ApiUnavailableError";
      throw error;
    }

    return new OffscreenPortSession(this.runtime);
  }

  private async sendRequest(
    request: OffscreenRequest,
    signal?: AbortSignal,
  ): Promise<Extract<OffscreenResponse, { ok: true }>> {
    const startedAt = nowMs();
    if (signal?.aborted) {
      const error = new DOMException(
        "Chrome Built-in AI translation was cancelled.",
        "AbortError",
      );
      tracePerf("localAi.request.error", {
        providerType,
        requestType: request.type,
        durationMs: elapsedMs(startedAt),
        success: false,
        ...metadataForError(error),
      });
      throw error;
    }

    const session = await this.createPortSession();
    try {
      return await this.sendSessionRequest(session, request, signal, {
        disconnectOnSettle: true,
      });
    } catch (error) {
      session.disconnect();
      throw error;
    }
  }

  private async sendSessionRequest(
    session: OffscreenPortSession,
    request: OffscreenRequest,
    signal?: AbortSignal,
    options: { disconnectOnSettle?: boolean } = {},
  ): Promise<Extract<OffscreenResponse, { ok: true }>> {
    const startedAt = nowMs();
    try {
      const response = await session.send(request, signal, options);
      tracePerf("localAi.offscreen.request.done", {
        providerType,
        requestType: request.type,
        durationMs: elapsedMs(startedAt),
        success: true,
      });
      return response;
    } catch (error) {
      tracePerf("localAi.request.error", {
        providerType,
        requestType: request.type,
        durationMs: elapsedMs(startedAt),
        success: false,
        ...metadataForError(error),
      });
      throw error;
    }
  }
}
