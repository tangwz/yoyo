import { describe, expect, it, vi } from "vitest";
import {
  CHROME_BUILT_IN_AI_OFFSCREEN_PORT,
  ChromeBuiltInAiOffscreenClient,
} from "@/provider/chromeBuiltInAiOffscreenClient";

type RequestMessage = {
  requestId: string;
  type: string;
  options?: { sourceLanguage: string; targetLanguage: string };
  translatorId?: string;
  text?: string;
};

type ResponseMessage =
  | {
      requestId: string;
      ok: true;
      availability?: "available" | "downloadable" | "downloading" | "unavailable";
      translatorId?: string;
      translatedText?: string;
    }
  | {
      requestId: string;
      ok: false;
      error: { name?: string; message?: string };
    };

type MockPort = {
  onMessage: { addListener(listener: (message: ResponseMessage) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage: ReturnType<typeof vi.fn<(message: RequestMessage) => void>>;
  disconnect: ReturnType<typeof vi.fn<() => void>>;
};

function createPort(handler: (message: RequestMessage) => ResponseMessage): MockPort {
  let messageListener: ((message: ResponseMessage) => void) | undefined;
  return {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
    onDisconnect: {
      addListener: vi.fn(),
    },
    postMessage: vi.fn((message: RequestMessage) => {
      messageListener?.(handler(message));
    }),
    disconnect: vi.fn(),
  };
}

describe("ChromeBuiltInAiOffscreenClient", () => {
  it("creates an offscreen document and requests availability over a runtime port", async () => {
    const port = createPort((message) => ({
      requestId: message.requestId,
      ok: true,
      availability: "available",
    }));
    const runtime = {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      getContexts: vi.fn(async () => []),
      connect: vi.fn(() => port),
    };
    const offscreen = {
      createDocument: vi.fn(async () => undefined),
    };
    const client = new ChromeBuiltInAiOffscreenClient({ runtime, offscreen });

    await expect(
      client.availability({ sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).resolves.toBe("available");

    expect(runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: ["chrome-extension://test/chrome-built-in-ai-offscreen.html"],
    });
    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: "chrome-built-in-ai-offscreen.html",
      reasons: ["DOM_PARSER"],
      justification:
        "Run Chrome Built-in AI Translator API from an extension document context.",
    });
    expect(runtime.connect).toHaveBeenCalledWith({
      name: CHROME_BUILT_IN_AI_OFFSCREEN_PORT,
    });
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chromeBuiltInAi.availability",
        options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
      }),
    );
  });

  it("reuses an existing offscreen document and proxies create and translate", async () => {
    const sentMessages: RequestMessage[] = [];
    const port = createPort((message) => {
      sentMessages.push(message);
      if (message.type === "chromeBuiltInAi.create") {
        return { requestId: message.requestId, ok: true, translatorId: "translator-1" };
      }
      if (message.type === "chromeBuiltInAi.translate") {
        return {
          requestId: message.requestId,
          ok: true,
          translatedText: `translated:${message.text}`,
        };
      }
      return { requestId: message.requestId, ok: true };
    });
    const runtime = {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      getContexts: vi.fn(async () => [{ contextId: "existing" }]),
      connect: vi.fn(() => port),
    };
    const offscreen = {
      createDocument: vi.fn(async () => undefined),
    };
    const client = new ChromeBuiltInAiOffscreenClient({ runtime, offscreen });

    const translator = await client.create({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    await expect(translator.translate("Hello")).resolves.toBe("translated:Hello");
    await translator.destroy?.();
    await vi.waitFor(() => expect(sentMessages).toHaveLength(3));

    expect(offscreen.createDocument).not.toHaveBeenCalled();
    expect(sentMessages).toEqual([
      expect.objectContaining({
        type: "chromeBuiltInAi.create",
        options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
      }),
      expect.objectContaining({
        type: "chromeBuiltInAi.translate",
        translatorId: "translator-1",
        text: "Hello",
      }),
      expect.objectContaining({
        type: "chromeBuiltInAi.destroy",
        translatorId: "translator-1",
      }),
    ]);
  });

  it("rethrows offscreen errors with the remote error name", async () => {
    const port = createPort((message) => ({
      requestId: message.requestId,
      ok: false,
      error: { name: "NotSupportedError", message: "Unsupported pair" },
    }));
    const client = new ChromeBuiltInAiOffscreenClient({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        getContexts: vi.fn(async () => [{ contextId: "existing" }]),
        connect: vi.fn(() => port),
      },
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
    });

    await expect(
      client.availability({ sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).rejects.toMatchObject({
      name: "NotSupportedError",
      message: "Unsupported pair",
    });
  });

  it("rejects malformed translate responses", async () => {
    const port = createPort((message) => {
      if (message.type === "chromeBuiltInAi.create") {
        return { requestId: message.requestId, ok: true, translatorId: "translator-1" };
      }
      return { requestId: message.requestId, ok: true };
    });
    const client = new ChromeBuiltInAiOffscreenClient({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        getContexts: vi.fn(async () => [{ contextId: "existing" }]),
        connect: vi.fn(() => port),
      },
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
    });

    const translator = await client.create({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    await expect(translator.translate("Hello")).rejects.toThrow(
      "Chrome Built-in AI offscreen response omitted translatedText.",
    );
  });

  it("rejects and disconnects when an in-flight request is aborted", async () => {
    let disconnectListener: (() => void) | undefined;
    const port: MockPort = {
      onMessage: {
        addListener: vi.fn(),
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListener = listener;
        },
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(() => {
        disconnectListener?.();
      }),
    };
    const abortController = new AbortController();
    const client = new ChromeBuiltInAiOffscreenClient({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        getContexts: vi.fn(async () => [{ contextId: "existing" }]),
        connect: vi.fn(() => port),
      },
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
    });

    const createPromise = client.create({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    abortController.abort();

    await expect(createPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chromeBuiltInAi.cancel",
      }),
    );
  });
});
