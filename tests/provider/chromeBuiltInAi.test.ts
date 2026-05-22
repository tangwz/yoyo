import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { LocalAiError } from "@/provider/localAiErrors";
import type {
  ChromeBuiltInAiProviderProfile,
  OpenAiCompatibleProviderProfile,
} from "@/provider/types";

function profile(): ChromeBuiltInAiProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

function openAiProfile(): OpenAiCompatibleProviderProfile {
  return {
    id: "openai",
    displayName: "OpenAI",
    type: "openai-compatible",
    baseURL: "https://api.example.test",
    apiKey: "secret",
    textModel: "gpt-5-mini",
  };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChromeBuiltInTranslatorProvider", () => {
  it("translates text with the browser Translator API", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available" as const);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).resolves.toEqual({ translatedText: "translated:Hello" });
    expect(availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      signal: undefined,
    });
    expect(translate).toHaveBeenCalledWith("Hello", { signal: undefined });
  });

  it("passes abort signals to create and translate", async () => {
    const abortController = new AbortController();
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create,
      }),
    });

    await provider.translateText({
      profile: profile(),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      text: "Hello",
      abortSignal: abortController.signal,
    });

    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      signal: abortController.signal,
    });
    expect(translate).toHaveBeenCalledWith("Hello", {
      signal: abortController.signal,
    });
  });

  it("rejects auto source language without calling the browser Translator API", async () => {
    const availability = vi.fn(async () => "available" as const);
    const create = vi.fn(async () => ({
      translate: vi.fn(async (text: string) => `translated:${text}`),
    }));
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "languagePairUnavailable",
    } satisfies Partial<LocalAiError>);
    expect(availability).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("fails locally when the API is unavailable", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => undefined,
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it("maps offscreen API unavailable errors to local API unavailable errors", async () => {
    const cause = new Error("Chrome offscreen APIs are not available.");
    cause.name = "ApiUnavailableError";
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps plain offscreen Translator API missing errors to local API unavailable errors", async () => {
    const cause = new Error("Chrome Built-in AI Translator API is not available.");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("does not fall back to the global Translator when an injected API getter returns undefined", async () => {
    vi.stubGlobal("Translator", {
      availability: vi.fn(async () => "available" as const),
      create: vi.fn(async () => ({
        translate: vi.fn(async (text: string) => `translated:${text}`),
      })),
    });
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => undefined,
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it("uses the global Translator API when no injection is provided", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available" as const);
    vi.stubGlobal("Translator", { availability, create });
    const provider = new ChromeBuiltInTranslatorProvider();

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).resolves.toEqual({ translatedText: "translated:Hello" });
    expect(availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      signal: undefined,
    });
  });

  it("fails locally when the language pair is unavailable", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "unavailable" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "languagePairUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it.each(["downloadable", "downloading"] as const)(
    "creates the translator when the model is %s",
    async (availabilityResult) => {
      const translate = vi.fn(async (text: string) => `translated:${text}`);
      const create = vi.fn(async () => ({ translate }));
      const provider = new ChromeBuiltInTranslatorProvider({
        getTranslatorApi: () => ({
          availability: vi.fn(async () => availabilityResult),
          create,
        }),
      });

      await expect(
        provider.translateText({
          profile: profile(),
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          text: "Hello",
        }),
      ).resolves.toEqual({ translatedText: "translated:Hello" });
      expect(create).toHaveBeenCalledWith({
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        signal: undefined,
      });
    },
  );

  it("rejects non Chrome Built-in AI profiles", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: openAiProfile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
    } satisfies Partial<LocalAiError>);
  });

  it("rejects non Chrome Built-in AI profiles for empty batches", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateBatch({
        profile: openAiProfile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [],
      }),
    ).rejects.toMatchObject({
      code: "unknown",
    } satisfies Partial<LocalAiError>);
  });

  it("maps availability errors to local unknown errors", async () => {
    const cause = new Error("availability failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps availability errors to local aborted errors when aborted", async () => {
    const abortController = new AbortController();
    const cause = new Error("availability failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => {
          abortController.abort();
          throw cause;
        }),
        create: vi.fn(async () => ({
          translate: vi.fn(async (text: string) => `translated:${text}`),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps create errors to local unknown errors", async () => {
    const cause = new Error("create failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => {
          throw cause;
        }),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "unknown",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps activation-gated create errors to model download required", async () => {
    const cause = namedError("NotAllowedError");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => {
          throw cause;
        }),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "modelDownloadRequired",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("maps create errors to local aborted errors when aborted", async () => {
    const abortController = new AbortController();
    const cause = new Error("create failed");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => {
          abortController.abort();
          throw cause;
        }),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it.each([
    ["AbortError", "aborted"],
    ["NotSupportedError", "languagePairUnavailable"],
    ["QuotaExceededError", "textTooLong"],
    ["NetworkError", "modelDownloadFailed"],
    ["NotAllowedError", "modelDownloadRequired"],
  ] as const)("maps %s DOMException names to %s", async (name, code) => {
    const cause = namedError(name);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async () => {
            throw cause;
          }),
        })),
      }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code,
      cause,
    } satisfies Partial<LocalAiError>);
  });

  it("translates batches with one translator session", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const destroy = vi.fn(async () => undefined);
    const availability = vi.fn(async () => "available" as const);
    const create = vi.fn(async () => ({ translate, destroy }));
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          {
            id: "segment-1",
            order: 1,
            sourceText: "Hello",
            kind: "paragraph",
            pathHint: "body.p1",
            textHash: "hash-1",
            priority: "viewport",
          },
          {
            id: "segment-2",
            order: 2,
            sourceText: "World",
            kind: "paragraph",
            pathHint: "body.p2",
            textHash: "hash-2",
            priority: "viewport",
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        { segmentId: "segment-1", translatedText: "translated:Hello" },
        { segmentId: "segment-2", translatedText: "translated:World" },
      ],
    });
    expect(availability).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("traces local provider batch translation without private text", async () => {
    vi.stubEnv("DEV", true);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const translate = vi.fn(async (text: string) => `private translated:${text}`);
    const availability = vi.fn(async () => "available" as const);
    const create = vi.fn(async () => ({ translate }));
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        traceContext: {
          taskId: "task-1",
          batchId: "batch-1",
          stage: "page",
          providerType: "chrome-built-in-ai",
        },
        segments: [
          {
            id: "segment-1",
            order: 1,
            sourceText: "Private source one",
            kind: "paragraph",
            pathHint: "body.p1",
            textHash: "hash-1",
            priority: "viewport",
          },
          {
            id: "segment-2",
            order: 2,
            sourceText: "Private source two",
            kind: "paragraph",
            pathHint: "body.p2",
            textHash: "hash-2",
            priority: "viewport",
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          segmentId: "segment-1",
          translatedText: "private translated:Private source one",
        },
        {
          segmentId: "segment-2",
          translatedText: "private translated:Private source two",
        },
      ],
    });

    const output = JSON.stringify(consoleInfo.mock.calls);
    expect(output).toContain("localAi.availability.done");
    expect(output).toContain("localAi.createTranslator.done");
    expect(output).toContain("localAi.translate.segment.done");
    expect(output).toContain("localAi.translate.batch.done");
    expect(output).toContain("\"taskId\":\"task-1\"");
    expect(output).toContain("\"batchId\":\"batch-1\"");
    expect(output).toContain("\"segmentId\":\"segment-1\"");
    expect(output).toContain("\"segmentOrder\":2");
    expect(output).toContain("\"sourceCharCount\":36");
    expect(output).not.toContain("Private source one");
    expect(output).not.toContain("Private source two");
    expect(output).not.toContain("private translated");
  });

  it("traces already aborted provider text requests without private text", async () => {
    vi.stubEnv("DEV", true);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const availability = vi.fn(async () => "available" as const);
    const create = vi.fn(async () => ({
      translate: vi.fn(async (text: string) => `translated:${text}`),
    }));
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Private provider text",
        traceContext: {
          taskId: "task-1",
          batchId: "batch-1",
          stage: "selection",
          providerType: "chrome-built-in-ai",
        },
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
    } satisfies Partial<LocalAiError>);

    const output = JSON.stringify(consoleInfo.mock.calls);
    expect(output).toContain("localAi.request.error");
    expect(output).toContain("\"providerType\":\"chrome-built-in-ai\"");
    expect(output).toContain("\"requestType\":\"translateText\"");
    expect(output).toContain("\"success\":false");
    expect(output).not.toContain("Private provider text");
    expect(availability).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("destroys batch translator sessions on failure", async () => {
    const destroy = vi.fn(async () => undefined);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          translate: vi.fn(async () => {
            throw new Error("translation failed");
          }),
          destroy,
        })),
      }),
    });

    await expect(
      provider.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          {
            id: "segment-1",
            order: 1,
            sourceText: "Hello",
            kind: "paragraph",
            pathHint: "body.p1",
            textHash: "hash-1",
            priority: "viewport",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "unknown",
    } satisfies Partial<LocalAiError>);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
