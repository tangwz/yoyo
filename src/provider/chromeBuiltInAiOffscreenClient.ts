import type {
  TranslatorApi,
  TranslatorAvailability,
  TranslatorCreateOptions,
  TranslatorInstance,
  TranslatorLanguageOptions,
  TranslatorTranslateOptions,
} from "@/provider/chromeBuiltInAi";

export const CHROME_BUILT_IN_AI_OFFSCREEN_PORT = "yoyo.chrome-built-in-ai-offscreen";
export const CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT =
  "chrome-built-in-ai-offscreen/index.html";

type ChromeRuntimePort = {
  onMessage: { addListener(listener: (message: OffscreenResponse) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
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
    };

type OffscreenResponse =
  | {
      requestId: string;
      ok: true;
      availability?: TranslatorAvailability;
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
      throw new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError");
    }

    const response = await this.sendRequest({
      requestId: createRequestId(),
      type: "chromeBuiltInAi.create",
      options: {
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
      },
    }, options.signal);

    if (!response.translatorId) {
      throw new Error("Chrome Built-in AI offscreen response omitted translatorId.");
    }

    const translatorId = response.translatorId;
    return {
      translate: async (text: string, translateOptions?: TranslatorTranslateOptions) => {
        if (translateOptions?.signal?.aborted) {
          throw new DOMException(
            "Chrome Built-in AI translation was cancelled.",
            "AbortError",
          );
        }

        const translateResponse = await this.sendRequest({
          requestId: createRequestId(),
          type: "chromeBuiltInAi.translate",
          translatorId,
          text,
        }, translateOptions?.signal);

        if (translateResponse.translatedText === undefined) {
          throw new Error("Chrome Built-in AI offscreen response omitted translatedText.");
        }

        return translateResponse.translatedText;
      },
      destroy: async () => {
        await this.sendRequest({
          requestId: createRequestId(),
          type: "chromeBuiltInAi.destroy",
          translatorId,
        });
      },
    };
  }

  private async ensureDocument(): Promise<void> {
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
  }

  private async sendRequest(
    request: OffscreenRequest,
    signal?: AbortSignal,
  ): Promise<Extract<OffscreenResponse, { ok: true }>> {
    if (signal?.aborted) {
      throw new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError");
    }

    await this.ensureDocument();

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError"),
        );
        return;
      }

      const runtime = this.runtime;
      if (!runtime) {
        const error = new Error("Chrome offscreen APIs are not available.");
        error.name = "ApiUnavailableError";
        reject(error);
        return;
      }

      const port = runtime.connect({ name: CHROME_BUILT_IN_AI_OFFSCREEN_PORT });
      let settled = false;
      let abortListener: (() => void) | undefined;

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (abortListener) {
          signal?.removeEventListener("abort", abortListener);
        }
        callback();
      };

      abortListener = () => {
        settle(() =>
          {
            const cancelRequestId = createRequestId();
            try {
              port.postMessage({
                requestId: cancelRequestId,
                type: "chromeBuiltInAi.cancel",
                cancelledRequestId: request.requestId,
              });
            } catch {
              // Best effort only; the port may already be disconnected.
            }
            port.disconnect();
            reject(
              new DOMException("Chrome Built-in AI translation was cancelled.", "AbortError"),
            );
          },
        );
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      port.onMessage.addListener((response) => {
        if (response.requestId !== request.requestId || settled) {
          return;
        }

        settle(() => {
          port.disconnect();
          if (response.ok) {
            resolve(response);
            return;
          }

          reject(createRemoteError(response.error));
        });
      });

      port.onDisconnect.addListener(() => {
        settle(() =>
          reject(
            new Error(
              runtime.lastError?.message ??
                "Chrome Built-in AI offscreen document disconnected.",
            ),
          ),
        );
      });

      port.postMessage(request);
    });
  }
}
