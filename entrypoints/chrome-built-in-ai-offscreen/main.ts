import {
  CHROME_BUILT_IN_AI_OFFSCREEN_PORT,
} from "@/provider/chromeBuiltInAiOffscreenClient";
import type {
  TranslatorApi,
  TranslatorInstance,
  TranslatorLanguageOptions,
} from "@/provider/chromeBuiltInAi";

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
      availability?: Awaited<ReturnType<TranslatorApi["availability"]>>;
      translatorId?: string;
      translatedText?: string;
    }
  | {
      requestId: string;
      ok: false;
      error: { name?: string; message?: string };
    };

type ChromeRuntimePort = {
  name: string;
  onMessage: { addListener(listener: (request: OffscreenRequest) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(response: OffscreenResponse): void;
};

type ChromeRuntimeLike = {
  onConnect: { addListener(listener: (port: ChromeRuntimePort) => void): void };
};

type ChromeBuiltInAiOffscreenHandlerDependencies = {
  getTranslatorApi: () => TranslatorApi;
  createTranslatorId?: () => string;
};

type ChromeBuiltInAiOffscreenSession = {
  handleRequest: (request: OffscreenRequest) => Promise<OffscreenResponse>;
  disconnect: () => void;
  hasTranslator: (translatorId: string) => boolean;
};

function getTranslatorApi(): TranslatorApi {
  const translator = (globalThis as typeof globalThis & { Translator?: TranslatorApi })
    .Translator;
  if (!translator) {
    throw new Error("Chrome Built-in AI Translator API is not available.");
  }

  return translator;
}

function createTranslatorId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `translator-${Date.now()}-${Math.random()}`;
}

function serializeError(error: unknown): { name?: string; message?: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }

  return { message: "Chrome Built-in AI offscreen request failed." };
}

export function createChromeBuiltInAiOffscreenRequestHandler(
  dependencies: ChromeBuiltInAiOffscreenHandlerDependencies,
): (request: OffscreenRequest) => Promise<OffscreenResponse> {
  return createChromeBuiltInAiOffscreenSession(dependencies).handleRequest;
}

export function createChromeBuiltInAiOffscreenSession(
  dependencies: ChromeBuiltInAiOffscreenHandlerDependencies,
): ChromeBuiltInAiOffscreenSession {
  const translators = new Map<string, TranslatorInstance>();
  const activeRequests = new Map<string, AbortController>();
  let disconnected = false;

  function abortActiveRequests(): void {
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
  }

  function destroyOwnedTranslators(): void {
    for (const translator of translators.values()) {
      void translator.destroy?.();
    }
    translators.clear();
  }

  function disconnect(): void {
    disconnected = true;
    abortActiveRequests();
    destroyOwnedTranslators();
  }

  async function handleRequest(request: OffscreenRequest): Promise<OffscreenResponse> {
    try {
      if (disconnected) {
        throw new DOMException(
          "Chrome Built-in AI offscreen session was disconnected.",
          "AbortError",
        );
      }

      switch (request.type) {
        case "chromeBuiltInAi.availability":
          return {
            requestId: request.requestId,
            ok: true,
            availability: await dependencies.getTranslatorApi().availability(request.options),
          };
        case "chromeBuiltInAi.create": {
          const controller = new AbortController();
          activeRequests.set(request.requestId, controller);

          let translator: TranslatorInstance | undefined;
          try {
            translator = await dependencies.getTranslatorApi().create({
              ...request.options,
              signal: controller.signal,
            });

            if (controller.signal.aborted || disconnected) {
              await translator.destroy?.();
              translator = undefined;
              throw new DOMException(
                "Chrome Built-in AI translation was cancelled.",
                "AbortError",
              );
            }

            const translatorId =
              dependencies.createTranslatorId?.() ?? createTranslatorId();
            translators.set(translatorId, translator);
            return { requestId: request.requestId, ok: true, translatorId };
          } catch (error) {
            if (translator && controller.signal.aborted) {
              try {
                await translator.destroy?.();
              } catch {
                // Best effort cleanup after cancellation.
              }
            }
            throw error;
          } finally {
            activeRequests.delete(request.requestId);
          }
        }
        case "chromeBuiltInAi.translate": {
          const translator = translators.get(request.translatorId);
          if (!translator) {
            throw new Error("Chrome Built-in AI translator session was not found.");
          }

          const controller = new AbortController();
          activeRequests.set(request.requestId, controller);
          try {
            return {
              requestId: request.requestId,
              ok: true,
              translatedText: await translator.translate(request.text, {
                signal: controller.signal,
              }),
            };
          } finally {
            activeRequests.delete(request.requestId);
          }
        }
        case "chromeBuiltInAi.destroy":
          await translators.get(request.translatorId)?.destroy?.();
          translators.delete(request.translatorId);
          return { requestId: request.requestId, ok: true };
        case "chromeBuiltInAi.cancel":
          activeRequests.get(request.cancelledRequestId)?.abort();
          return { requestId: request.requestId, ok: true };
      }
    } catch (error) {
      return {
        requestId: request.requestId,
        ok: false,
        error: serializeError(error),
      };
    }
  }

  return {
    handleRequest,
    disconnect,
    hasTranslator: (translatorId) => translators.has(translatorId),
  };
}

export function setupChromeBuiltInAiOffscreenPort(
  chromeRuntime: ChromeRuntimeLike,
): void {
  const handleRequest = createChromeBuiltInAiOffscreenRequestHandler({
    getTranslatorApi,
  });

  chromeRuntime.onConnect.addListener((port) => {
    if (port.name !== CHROME_BUILT_IN_AI_OFFSCREEN_PORT) {
      return;
    }

    const session = createChromeBuiltInAiOffscreenSession({
      getTranslatorApi,
    });
    let disconnected = false;

    port.onDisconnect.addListener(() => {
      disconnected = true;
      session.disconnect();
    });

    port.onMessage.addListener((request: OffscreenRequest) => {
      void session.handleRequest(request).then((response) => {
        if (disconnected) {
          return;
        }
        try {
          port.postMessage(response);
        } catch {
          // The background port may disconnect after sending a cancellation request.
        }
      });
    });
  });
}

const chromeRuntime = (globalThis as typeof globalThis & {
  chrome?: { runtime?: ChromeRuntimeLike };
}).chrome?.runtime;

if (chromeRuntime) {
  setupChromeBuiltInAiOffscreenPort(chromeRuntime);
}
