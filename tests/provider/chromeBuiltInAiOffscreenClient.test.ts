import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROME_BUILT_IN_AI_OFFSCREEN_PORT,
  ChromeBuiltInAiOffscreenClient,
} from "@/provider/chromeBuiltInAiOffscreenClient";
import { createChromeBuiltInAiOffscreenSession } from "../../entrypoints/chrome-built-in-ai-offscreen/main";

type RequestMessage =
  | {
      requestId: string;
      type: "chromeBuiltInAi.availability";
      options: { sourceLanguage: string; targetLanguage: string };
    }
  | {
      requestId: string;
      type: "chromeBuiltInAi.create";
      options: { sourceLanguage: string; targetLanguage: string };
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

type ResponseMessage =
  | {
      requestId: string;
      ok: true;
      availability?: "available" | "downloadable" | "downloading" | "unavailable";
      detectedLanguage?: string;
      translatorId?: string;
      translatedText?: string;
    }
  | {
      requestId: string;
      ok: false;
      error: { name?: string; message?: string };
    };

type MockPort = {
  onMessage: {
    addListener(listener: (message: ResponseMessage) => void): void;
    removeListener?(listener: (message: ResponseMessage) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener?(listener: () => void): void;
  };
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

  it("traces offscreen availability requests without raw request payloads", async () => {
    vi.stubEnv("DEV", true);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
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

    const output = JSON.stringify(consoleInfo.mock.calls);
    expect(output).toContain("localAi.offscreen.ensureDocument.done");
    expect(output).toContain("localAi.offscreen.request.done");
    expect(output).toContain("chromeBuiltInAi.availability");
    expect(output).toContain("\"createdDocument\":true");
    expect(output).not.toContain("\"options\"");
    expect(output).not.toContain("\"sourceLanguage\":\"en\"");
    expect(output).not.toContain("\"targetLanguage\":\"zh-CN\"");
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

  it("detects source language over a runtime port", async () => {
    const port = createPort((message) => ({
      requestId: message.requestId,
      ok: true,
      detectedLanguage: "en",
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

    await expect(client.detectLanguage("Hello world.")).resolves.toBe("en");
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chromeBuiltInAi.detectLanguage",
        text: "Hello world.",
      }),
    );
  });

  it("traces language detection without source text", async () => {
    vi.stubEnv("DEV", true);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const port = createPort((message) => ({
      requestId: message.requestId,
      ok: true,
      detectedLanguage: "en",
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

    await expect(client.detectLanguage("Private detector source")).resolves.toBe("en");

    const output = JSON.stringify(consoleInfo.mock.calls);
    expect(output).toContain("localAi.detectLanguage.done");
    expect(output).toContain("\"detectedLanguage\":\"en\"");
    expect(output).toContain("\"sourceCharCount\":23");
    expect(output).not.toContain("Private detector source");
  });

  it("keeps the create port alive so translator sessions can translate before destroy", async () => {
    const destroy = vi.fn(async () => undefined);
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const session = createChromeBuiltInAiOffscreenSession({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({ translate, destroy })),
      }),
    });
    let messageListener: ((message: ResponseMessage) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    const port: MockPort = {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListener = listener;
        },
      },
      postMessage: vi.fn((message) => {
        void session.handleRequest(message).then((response) => {
          messageListener?.(response);
        });
      }),
      disconnect: vi.fn(() => {
        session.disconnect();
        disconnectListener?.();
      }),
    };
    const runtime = {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      getContexts: vi.fn(async () => [{ contextId: "existing" }]),
      connect: vi.fn(() => port),
    };
    const client = new ChromeBuiltInAiOffscreenClient({
      runtime,
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
    });

    const translator = await client.create({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(destroy).not.toHaveBeenCalled();

    await expect(translator.translate("Hello")).resolves.toBe("translated:Hello");
    expect(translate).toHaveBeenCalledWith("Hello", expect.objectContaining({}));
    expect(destroy).not.toHaveBeenCalled();

    await translator.destroy?.();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
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

  it("disconnects when the signal is aborted after opening a request port", async () => {
    const port: MockPort = {
      onMessage: {
        addListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn(),
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const abortController = new AbortController();
    const client = new ChromeBuiltInAiOffscreenClient({
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        getContexts: vi.fn(async () => [{ contextId: "existing" }]),
        connect: vi.fn(() => {
          abortController.abort();
          return port;
        }),
      },
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
    });

    await expect(client.detectLanguage("Hello", abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("removes per-request port listeners after responses settle", async () => {
    const messageListeners = new Set<(message: ResponseMessage) => void>();
    const disconnectListeners = new Set<() => void>();
    const port: MockPort = {
      onMessage: {
        addListener(listener) {
          messageListeners.add(listener);
        },
        removeListener(listener) {
          messageListeners.delete(listener);
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListeners.add(listener);
        },
        removeListener(listener) {
          disconnectListeners.delete(listener);
        },
      },
      postMessage: vi.fn((message) => {
        for (const listener of [...messageListeners]) {
          listener({
            requestId: message.requestId,
            ok: true,
            availability: "available",
          });
        }
      }),
      disconnect: vi.fn(),
    };
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
    ).resolves.toBe("available");

    expect(messageListeners.size).toBe(0);
    expect(disconnectListeners.size).toBe(0);
  });

  it("cleans per-request listeners when port postMessage throws", async () => {
    const messageListeners = new Set<(message: ResponseMessage) => void>();
    const disconnectListeners = new Set<() => void>();
    const cause = new Error("Port disconnected.");
    const port: MockPort = {
      onMessage: {
        addListener(listener) {
          messageListeners.add(listener);
        },
        removeListener(listener) {
          messageListeners.delete(listener);
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListeners.add(listener);
        },
        removeListener(listener) {
          disconnectListeners.delete(listener);
        },
      },
      postMessage: vi.fn(() => {
        throw cause;
      }),
      disconnect: vi.fn(),
    };
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
    ).rejects.toBe(cause);

    expect(messageListeners.size).toBe(0);
    expect(disconnectListeners.size).toBe(0);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
});
