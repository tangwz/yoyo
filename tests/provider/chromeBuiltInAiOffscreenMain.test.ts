import { describe, expect, it, vi } from "vitest";
import {
  createChromeBuiltInAiOffscreenRequestHandler,
  createChromeBuiltInAiOffscreenSession,
} from "../../entrypoints/chrome-built-in-ai-offscreen/main";

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve: resolve!, reject: reject! };
}

describe("chrome-built-in-ai offscreen handler", () => {
  it("aborts in-flight create requests and destroys late translators", async () => {
    const created = deferred<{ translate: () => Promise<string>; destroy: () => Promise<void> }>();
    const destroy = vi.fn(async () => undefined);
    let createSignal: AbortSignal | undefined;
    const handleRequest = createChromeBuiltInAiOffscreenRequestHandler({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async (options) => {
          createSignal = options.signal;
          return created.promise;
        }),
      }),
    });

    const createResponsePromise = handleRequest({
      requestId: "create-1",
      type: "chromeBuiltInAi.create",
      options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
    });
    await vi.waitFor(() => expect(createSignal).toBeDefined());

    await expect(
      handleRequest({
        requestId: "cancel-1",
        type: "chromeBuiltInAi.cancel",
        cancelledRequestId: "create-1",
      }),
    ).resolves.toEqual({ requestId: "cancel-1", ok: true });
    expect(createSignal?.aborted).toBe(true);

    created.resolve({
      translate: vi.fn(async () => "translated"),
      destroy,
    });

    await expect(createResponsePromise).resolves.toMatchObject({
      requestId: "create-1",
      ok: false,
      error: { name: "AbortError" },
    });
    expect(destroy).toHaveBeenCalledTimes(1);

    await expect(
      handleRequest({
        requestId: "translate-1",
        type: "chromeBuiltInAi.translate",
        translatorId: "translator-1",
        text: "Hello",
      }),
    ).resolves.toMatchObject({
      requestId: "translate-1",
      ok: false,
    });
  });

  it("aborts in-flight translate requests", async () => {
    const translated = deferred<string>();
    let translateSignal: AbortSignal | undefined;
    const translate = vi.fn(async (_text: string, options?: { signal?: AbortSignal }) => {
      translateSignal = options?.signal;
      return translated.promise;
    });
    const handleRequest = createChromeBuiltInAiOffscreenRequestHandler({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({ translate })),
      }),
    });

    await expect(
      handleRequest({
        requestId: "create-1",
        type: "chromeBuiltInAi.create",
        options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
      }),
    ).resolves.toEqual({ requestId: "create-1", ok: true, translatorId: "translator-1" });

    const translateResponsePromise = handleRequest({
      requestId: "translate-1",
      type: "chromeBuiltInAi.translate",
      translatorId: "translator-1",
      text: "Hello",
    });
    await vi.waitFor(() => expect(translateSignal).toBeDefined());

    await handleRequest({
      requestId: "cancel-1",
      type: "chromeBuiltInAi.cancel",
      cancelledRequestId: "translate-1",
    });
    expect(translateSignal?.aborted).toBe(true);

    translated.reject(new DOMException("Cancelled", "AbortError"));
    await expect(translateResponsePromise).resolves.toMatchObject({
      requestId: "translate-1",
      ok: false,
      error: { name: "AbortError" },
    });
  });

  it("aborts create and destroys the late translator when the port disconnects", async () => {
    const created = deferred<{ translate: () => Promise<string>; destroy: () => Promise<void> }>();
    const destroy = vi.fn(async () => undefined);
    let createSignal: AbortSignal | undefined;
    const session = createChromeBuiltInAiOffscreenSession({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async (options) => {
          createSignal = options.signal;
          return created.promise;
        }),
      }),
    });

    const createResponsePromise = session.handleRequest({
      requestId: "create-1",
      type: "chromeBuiltInAi.create",
      options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
    });
    await vi.waitFor(() => expect(createSignal).toBeDefined());

    session.disconnect();
    expect(createSignal?.aborted).toBe(true);

    created.resolve({
      translate: vi.fn(async () => "translated"),
      destroy,
    });

    await expect(createResponsePromise).resolves.toMatchObject({
      requestId: "create-1",
      ok: false,
      error: { name: "AbortError" },
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight translate requests when the port disconnects", async () => {
    const translated = deferred<string>();
    let translateSignal: AbortSignal | undefined;
    const translate = vi.fn(async (_text: string, options?: { signal?: AbortSignal }) => {
      translateSignal = options?.signal;
      return translated.promise;
    });
    const session = createChromeBuiltInAiOffscreenSession({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({ translate })),
      }),
    });

    await expect(
      session.handleRequest({
        requestId: "create-1",
        type: "chromeBuiltInAi.create",
        options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
      }),
    ).resolves.toEqual({ requestId: "create-1", ok: true, translatorId: "translator-1" });

    const translateResponsePromise = session.handleRequest({
      requestId: "translate-1",
      type: "chromeBuiltInAi.translate",
      translatorId: "translator-1",
      text: "Hello",
    });
    await vi.waitFor(() => expect(translateSignal).toBeDefined());

    session.disconnect();
    expect(translateSignal?.aborted).toBe(true);

    translated.reject(new DOMException("Cancelled", "AbortError"));
    await expect(translateResponsePromise).resolves.toMatchObject({
      requestId: "translate-1",
      ok: false,
      error: { name: "AbortError" },
    });
  });

  it("does not retain a translator after disconnected create resolves", async () => {
    const created = deferred<{ translate: () => Promise<string>; destroy: () => Promise<void> }>();
    const session = createChromeBuiltInAiOffscreenSession({
      createTranslatorId: () => "translator-1",
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => created.promise),
      }),
    });

    const createResponsePromise = session.handleRequest({
      requestId: "create-1",
      type: "chromeBuiltInAi.create",
      options: { sourceLanguage: "en", targetLanguage: "zh-CN" },
    });
    session.disconnect();
    created.resolve({
      translate: vi.fn(async () => "translated"),
      destroy: vi.fn(async () => undefined),
    });

    await createResponsePromise;
    expect(session.hasTranslator("translator-1")).toBe(false);
  });
});
