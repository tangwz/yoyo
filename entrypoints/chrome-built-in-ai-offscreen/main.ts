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
  postMessage(response: OffscreenResponse): void;
};

type ChromeRuntimeLike = {
  onConnect: { addListener(listener: (port: ChromeRuntimePort) => void): void };
};

const translators = new Map<string, TranslatorInstance>();

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

async function handleRequest(request: OffscreenRequest): Promise<OffscreenResponse> {
  try {
    switch (request.type) {
      case "chromeBuiltInAi.availability":
        return {
          requestId: request.requestId,
          ok: true,
          availability: await getTranslatorApi().availability(request.options),
        };
      case "chromeBuiltInAi.create": {
        const translator = await getTranslatorApi().create(request.options);
        const translatorId = createTranslatorId();
        translators.set(translatorId, translator);
        return { requestId: request.requestId, ok: true, translatorId };
      }
      case "chromeBuiltInAi.translate": {
        const translator = translators.get(request.translatorId);
        if (!translator) {
          throw new Error("Chrome Built-in AI translator session was not found.");
        }

        return {
          requestId: request.requestId,
          ok: true,
          translatedText: await translator.translate(request.text),
        };
      }
      case "chromeBuiltInAi.destroy":
        await translators.get(request.translatorId)?.destroy?.();
        translators.delete(request.translatorId);
        return { requestId: request.requestId, ok: true };
      case "chromeBuiltInAi.cancel":
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

const chromeRuntime = (globalThis as typeof globalThis & {
  chrome: { runtime: ChromeRuntimeLike };
}).chrome.runtime;

chromeRuntime.onConnect.addListener((port) => {
  if (port.name !== CHROME_BUILT_IN_AI_OFFSCREEN_PORT) {
    return;
  }

  port.onMessage.addListener((request: OffscreenRequest) => {
    void handleRequest(request).then((response) => port.postMessage(response));
  });
});
