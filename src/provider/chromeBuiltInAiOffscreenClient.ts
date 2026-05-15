import type {
  TranslatorApi,
  TranslatorAvailability,
  TranslatorCreateOptions,
  TranslatorInstance,
  TranslatorLanguageOptions,
  TranslatorTranslateOptions,
} from "@/provider/chromeBuiltInAi";

export const CHROME_BUILT_IN_AI_OFFSCREEN_PORT = "yoyo.chrome-built-in-ai-offscreen";
export const CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT = "chrome-built-in-ai-offscreen.html";

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
  private readonly runtime: ChromeRuntimeLike;
  private readonly offscreen: ChromeOffscreenLike;
  private creatingDocument: Promise<void> | undefined;

  constructor(dependencies: ChromeBuiltInAiOffscreenClientDependencies = {}) {
    const runtime = dependencies.runtime ?? getDefaultRuntime();
    const offscreen = dependencies.offscreen ?? getDefaultOffscreen();

    if (!runtime || !offscreen) {
      throw new Error("Chrome offscreen APIs are not available.");
    }

    this.runtime = runtime;
    this.offscreen = offscreen;
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
    });

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
        });

        return translateResponse.translatedText ?? "";
      },
      destroy: () => {
        void this.sendRequest({
          requestId: createRequestId(),
          type: "chromeBuiltInAi.destroy",
          translatorId,
        }).catch(() => undefined);
      },
    };
  }

  private async ensureDocument(): Promise<void> {
    const url = this.runtime.getURL(CHROME_BUILT_IN_AI_OFFSCREEN_DOCUMENT);
    const contexts = await this.runtime.getContexts?.({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });

    if (contexts && contexts.length > 0) {
      return;
    }

    this.creatingDocument ??= this.offscreen
      .createDocument({
        url,
        reasons: ["DOM_PARSER"],
        justification:
          "Run Chrome Built-in AI Translator API from an extension document context.",
      })
      .finally(() => {
        this.creatingDocument = undefined;
      });

    await this.creatingDocument;
  }

  private async sendRequest(request: OffscreenRequest): Promise<Extract<OffscreenResponse, { ok: true }>> {
    await this.ensureDocument();

    return new Promise((resolve, reject) => {
      const port = this.runtime.connect({ name: CHROME_BUILT_IN_AI_OFFSCREEN_PORT });
      let settled = false;

      port.onMessage.addListener((response) => {
        if (response.requestId !== request.requestId || settled) {
          return;
        }

        settled = true;
        port.disconnect();

        if (response.ok) {
          resolve(response);
          return;
        }

        reject(createRemoteError(response.error));
      });

      port.onDisconnect.addListener(() => {
        if (settled) {
          return;
        }

        settled = true;
        reject(
          new Error(
            this.runtime.lastError?.message ??
              "Chrome Built-in AI offscreen document disconnected.",
          ),
        );
      });

      port.postMessage(request);
    });
  }
}
