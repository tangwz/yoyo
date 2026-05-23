import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PopupApp from "../../entrypoints/popup/App.vue";
import LanguageSelector from "../../src/ui/components/LanguageSelector.vue";
import TaskProgress from "../../src/ui/components/TaskProgress.vue";
import {
  sourceLanguageOptions,
  targetLanguageOptions,
} from "../../src/i18n/languages";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

const browserMock = vi.hoisted(() => ({
  localStorageGet: vi.fn(),
  localStorageRemove: vi.fn(),
  localStorageSet: vi.fn(),
  runtimeListeners: new Set<(message: unknown) => void>(),
  runtimeOpenOptionsPage: vi.fn(),
  runtimeSendMessage: vi.fn(),
  sessionStorageGet: vi.fn(),
  sessionStorageRemove: vi.fn(),
  sessionStorageSet: vi.fn(),
  syncStorageGet: vi.fn(),
  syncStorageRemove: vi.fn(),
  syncStorageSet: vi.fn(),
  tabsDetectLanguage: vi.fn(),
  tabsQuery: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

function idleTaskProgress() {
  return {
    type: "taskProgress",
    progress: {
      taskId: "",
      state: "completed",
      total: 0,
      translated: 0,
      failed: 0,
    },
  };
}

function readyProviderStatus() {
  return {
    type: "providerStatus",
    configured: true,
    readiness: "ready",
    providerLabel: "OpenAI / api.openai.com",
    providerMode: "remote",
  };
}

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      openOptionsPage: browserMock.runtimeOpenOptionsPage,
      sendMessage: browserMock.runtimeSendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          browserMock.runtimeListeners.add(listener);
        },
        removeListener: (listener: (message: unknown) => void) => {
          browserMock.runtimeListeners.delete(listener);
        },
      },
    },
    storage: {
      local: {
        get: browserMock.localStorageGet,
        remove: browserMock.localStorageRemove,
        set: browserMock.localStorageSet,
      },
      session: {
        get: browserMock.sessionStorageGet,
        remove: browserMock.sessionStorageRemove,
        set: browserMock.sessionStorageSet,
      },
      sync: {
        get: browserMock.syncStorageGet,
        remove: browserMock.syncStorageRemove,
        set: browserMock.syncStorageSet,
      },
    },
    tabs: {
      detectLanguage: browserMock.tabsDetectLanguage,
      query: browserMock.tabsQuery,
      sendMessage: browserMock.tabsSendMessage,
    },
  },
}));

describe("popup app", () => {
  beforeEach(() => {
    browserMock.runtimeListeners.clear();
    browserMock.localStorageGet.mockReset();
    browserMock.localStorageRemove.mockReset();
    browserMock.localStorageSet.mockReset();
    browserMock.runtimeOpenOptionsPage.mockReset();
    browserMock.runtimeSendMessage.mockReset();
    browserMock.sessionStorageGet.mockReset();
    browserMock.sessionStorageRemove.mockReset();
    browserMock.sessionStorageSet.mockReset();
    browserMock.syncStorageGet.mockReset();
    browserMock.syncStorageRemove.mockReset();
    browserMock.syncStorageSet.mockReset();
    browserMock.tabsDetectLanguage.mockReset();
    browserMock.tabsQuery.mockReset();
    browserMock.tabsSendMessage.mockReset();

    const createStorageAreaMock = (
      getMock: typeof browserMock.syncStorageGet,
      setMock: typeof browserMock.syncStorageSet,
      removeMock: typeof browserMock.syncStorageRemove,
    ) => {
      const values = new Map<string, unknown>();

      getMock.mockImplementation(async (keys?: string | string[] | Record<string, unknown> | null) => {
        if (typeof keys === "string") {
          return values.has(keys) ? { [keys]: values.get(keys) } : {};
        }

        if (Array.isArray(keys)) {
          return Object.fromEntries(
            keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
          );
        }

        if (keys && typeof keys === "object") {
          return Object.fromEntries(
            Object.entries(keys).map(([key, fallback]) => [
              key,
              values.has(key) ? values.get(key) : fallback,
            ]),
          );
        }

        return Object.fromEntries(values.entries());
      });
      setMock.mockImplementation(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          values.set(key, value);
        }
      });
      removeMock.mockImplementation(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          values.delete(key);
        }
      });

      return values;
    };

    createStorageAreaMock(
      browserMock.localStorageGet,
      browserMock.localStorageSet,
      browserMock.localStorageRemove,
    );
    createStorageAreaMock(
      browserMock.syncStorageGet,
      browserMock.syncStorageSet,
      browserMock.syncStorageRemove,
    );
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: browserMock.localStorageGet,
          remove: browserMock.localStorageRemove,
          set: browserMock.localStorageSet,
        },
        sync: {
          get: browserMock.syncStorageGet,
          remove: browserMock.syncStorageRemove,
          set: browserMock.syncStorageSet,
        },
      },
    });

    const sessionValues = new Map<string, unknown>();
    browserMock.sessionStorageGet.mockImplementation(async (key: string) =>
      sessionValues.has(key) ? { [key]: sessionValues.get(key) } : {},
    );
    browserMock.sessionStorageSet.mockImplementation(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        sessionValues.set(key, value);
      }
    });
    browserMock.sessionStorageRemove.mockImplementation(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        sessionValues.delete(key);
      }
    });

    browserMock.tabsQuery.mockResolvedValue([{ id: 123 }]);
    browserMock.tabsDetectLanguage.mockResolvedValue("en");
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: false,
          };
        }

        if (message.type === "estimatePage") {
          return {
            type: "estimatePageResult",
            estimate: {
              canTranslate: true,
              estimatedSegments: 32,
              estimatedChars: 1200,
            },
          };
        }

        if (
          message.type === "hideTranslations" ||
          message.type === "showTranslations" ||
          message.type === "removeTranslations"
        ) {
          return {
            type: "contentActionResult",
            success: true,
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      if (message.type === "openOptions") {
        return { type: "backgroundActionResult", success: true };
      }

      if (message.type === "translatePage") {
        return {
          type: "taskProgress",
          progress: {
            taskId: "task-1",
            state: "completed",
            total: 32,
            translated: 32,
            failed: 0,
          },
        };
      }

      if (message.type === "summarizePage") {
        return { type: "backgroundActionResult", success: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops initialization when Provider status returns a background error", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "backgroundError",
          message: "Storage unavailable.",
        };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    render(PopupApp);

    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable.");
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "getTaskForTab" }),
    );
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("renders the default popup controls without configured provider details", async () => {
    render(PopupApp);

    expect(screen.getByText("悠悠阅读助手")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveDisplayValue(
      "自动检测",
    );
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveDisplayValue(
      "简体中文",
    );
    expect(screen.getByText("翻译当前页面")).toBeVisible();
    expect(screen.getByRole("button", { name: "一键总结" })).toBeVisible();
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.getByText("0.2.0")).toBeVisible();
    expect(screen.getByText("更多")).toBeVisible();

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    expect(screen.queryByLabelText("Translation provider")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenAI / api.openai.com")).not.toBeInTheDocument();
  });

  it("renders the default Chinese summary button", async () => {
    render(PopupApp);

    expect(await screen.findByRole("button", { name: "一键总结" })).toBeVisible();
  });

  it("renders the English summary button when UI preference is English", async () => {
    await browserMock.syncStorageSet({
      "yoyo.uiPreferences": { theme: "light", uiLanguage: "en-US" },
    });

    render(PopupApp);

    expect(await screen.findByRole("button", { name: "Summarize" })).toBeVisible();
  });

  it("continues initialization when preference storage fails", async () => {
    browserMock.syncStorageGet.mockRejectedValue(new Error("Sync storage unavailable."));

    render(PopupApp);

    expect(await screen.findByRole("button", { name: "翻译当前页面" })).toBeVisible();
    expect(screen.getByRole("button", { name: "一键总结" })).toBeVisible();
    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
        type: "getProviderStatus",
      });
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requests page summary for the active tab and selected target language", async () => {
    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "ja");
    await fireEvent.click(screen.getByRole("button", { name: "一键总结" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "summarizePage",
      tabId: 123,
      targetLanguage: "ja",
    });
  });

  it("uses stored Traditional Chinese target language for page summary", async () => {
    await browserMock.syncStorageSet({
      "yoyo.translationPreferences": { mode: "lazyViewport", targetLanguage: "zh-TW" },
    });

    render(PopupApp);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Target language" })).toHaveDisplayValue(
        "繁體中文",
      );
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "一键总结" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "summarizePage",
      tabId: 123,
      targetLanguage: "zh-TW",
    });
  });

  it("does not overwrite target language edits when popup preferences load late", async () => {
    const translationPreferences = createDeferred<Record<string, unknown>>();
    browserMock.syncStorageGet.mockImplementation(async (keys) => {
      if (
        keys &&
        typeof keys === "object" &&
        !Array.isArray(keys) &&
        "yoyo.translationPreferences" in keys
      ) {
        return translationPreferences.promise;
      }

      if (
        keys &&
        typeof keys === "object" &&
        !Array.isArray(keys) &&
        "yoyo.uiPreferences" in keys
      ) {
        return {
          "yoyo.uiPreferences": { theme: "light", uiLanguage: "zh-CN" },
        };
      }

      return {};
    });

    render(PopupApp);

    const targetSelect = screen.getByRole("combobox", { name: "Target language" });
    await fireEvent.update(targetSelect, "ja");

    translationPreferences.resolve({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "en" },
    });
    await flushPromises();

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    expect(targetSelect).toHaveValue("ja");
  });

  it("saves target language preferences while preserving translation mode", async () => {
    await browserMock.syncStorageSet({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "ja" },
    });

    render(PopupApp);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Target language" })).toHaveDisplayValue(
        "日本語",
      );
    });

    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "ko");

    await waitFor(() => {
      expect(browserMock.syncStorageSet).toHaveBeenCalledWith({
        "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "ko" },
      });
    });
  });

  it("saves target language with the latest stored translation mode", async () => {
    await browserMock.syncStorageSet({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "zh-CN" },
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await browserMock.syncStorageSet({
      "yoyo.translationPreferences": { mode: "lazyViewport", targetLanguage: "zh-CN" },
    });
    browserMock.syncStorageSet.mockClear();

    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "en");

    await waitFor(() => {
      expect(browserMock.syncStorageSet).toHaveBeenCalledWith({
        "yoyo.translationPreferences": { mode: "lazyViewport", targetLanguage: "en" },
      });
    });
  });

  it("serializes target language saves so the last popup selection wins", async () => {
    const firstSave = createDeferred<void>();
    await browserMock.syncStorageSet({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "zh-CN" },
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    browserMock.syncStorageSet.mockImplementation(async () => {
      if (browserMock.syncStorageSet.mock.calls.length === 1) {
        await firstSave.promise;
      }
    });
    browserMock.syncStorageSet.mockClear();

    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "en");
    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "ja");

    await waitFor(() => {
      expect(browserMock.syncStorageSet).toHaveBeenCalledTimes(1);
    });

    firstSave.resolve();

    await waitFor(() => {
      expect(browserMock.syncStorageSet).toHaveBeenCalledTimes(2);
    });
    expect(browserMock.syncStorageSet).toHaveBeenLastCalledWith({
      "yoyo.translationPreferences": { mode: "fullPage", targetLanguage: "ja" },
    });
  });

  it("disables translation while resolving the active tab", async () => {
    const activeTabQuery = createDeferred<Array<{ id: number }>>();
    browserMock.tabsQuery.mockReturnValueOnce(activeTabQuery.promise);

    render(PopupApp);

    const primaryButton = screen.getByRole("button", { name: "翻译当前页面" });

    expect(primaryButton).toBeDisabled();

    await fireEvent.click(primaryButton);

    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "translatePage" }),
    );
    expect(screen.queryByText("无法获取当前标签页。")).not.toBeInTheDocument();

    activeTabQuery.resolve([{ id: 123 }]);

    await waitFor(() => {
      expect(primaryButton).toBeEnabled();
    });
  });

  it("opens the options page from the settings button", async () => {
    render(PopupApp);

    await fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "openOptions",
    });
    expect(browserMock.runtimeOpenOptionsPage).not.toHaveBeenCalled();
  });

  it("opens Provider settings and skips page estimate when Provider is not ready", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: false,
          readiness: "missingApiKey",
          providerLabel: "未配置翻译服务",
          providerMode: "remote",
        };
      }

      if (message.type === "openOptions") {
        return { type: "backgroundActionResult", success: true };
      }

      return idleTaskProgress();
    });

    render(PopupApp);

    expect(await screen.findByText("未配置翻译服务")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "需要先配置 Provider，正在打开设置页面...",
    );

    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
        type: "openOptions",
        section: "provider",
        source: "first-run",
      });
    });

    expect(await screen.findByRole("button", { name: "打开设置" })).toBeVisible();
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(expect.any(Number), {
      type: "estimatePage",
    });
  });

  it("does not show extra local-only copy for a configured local provider", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "Chrome Built-in AI / Local only",
          providerMode: "local-only",
        };
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    expect(screen.queryByLabelText("Translation provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Chrome Built-in AI / Local only")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Local only. No remote provider will be used."),
    ).not.toBeInTheDocument();
    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith({
      type: "openOptions",
      section: "provider",
      source: "first-run",
    });
  });

  it("disables summary for a configured local-only provider", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "Chrome Built-in AI / Local only",
          providerMode: "local-only",
        };
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
      expect(screen.getByRole("button", { name: "一键总结" })).toBeDisabled();
    });
  });

  it("shows unsupported local provider errors without opening Provider settings", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: false,
          readiness: "browserUnsupported",
          providerLabel: "Chrome Built-in AI / Local only",
          providerMode: "local-only",
        };
      }

      if (message.type === "openOptions") {
        throw new Error("Provider settings should not open.");
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    render(PopupApp);

    expect(await screen.findByText("Chrome Built-in AI / Local only")).toBeVisible();
    expect(
      screen.queryByText("Local only. No remote provider will be used."),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chrome Built-in AI requires desktop Chrome 138 or later.",
    );
    expect(screen.getByRole("button", { name: "翻译当前页面" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "打开设置" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
        type: "getProviderStatus",
      });
    });
    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith({
      type: "openOptions",
      section: "provider",
      source: "first-run",
    });
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(expect.any(Number), {
      type: "estimatePage",
    });
  });

  it("does not automatically reopen first-run settings after the first redirect attempt", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: false,
          readiness: "missingApiKey",
          providerLabel: "未配置翻译服务",
          providerMode: "remote",
        };
      }

      if (message.type === "openOptions") {
        return { type: "backgroundActionResult", success: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    const firstPopup = render(PopupApp);

    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
        type: "openOptions",
        section: "provider",
        source: "first-run",
      });
    });

    firstPopup.unmount();
    browserMock.runtimeSendMessage.mockClear();

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
        type: "getProviderStatus",
      });
    });
    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith({
      type: "openOptions",
      section: "provider",
      source: "first-run",
    });
    expect(await screen.findByRole("button", { name: "打开设置" })).toBeVisible();
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
  });

  it("keeps first-run routing when the onboarding fallback button opens settings", async () => {
    let openOptionsCalls = 0;
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: false,
          readiness: "missingApiKey",
          providerLabel: "未配置翻译服务",
          providerMode: "remote",
        };
      }

      if (message.type === "openOptions") {
        openOptionsCalls += 1;
        if (openOptionsCalls === 1) {
          throw new Error("Options page blocked.");
        }

        return { type: "backgroundActionResult", success: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });

    render(PopupApp);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Options page blocked.");
    });

    await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    expect(openOptionsCalls).toBe(2);
    await waitFor(() => {
      expect(browserMock.runtimeSendMessage).toHaveBeenLastCalledWith({
        type: "openOptions",
        section: "provider",
        source: "first-run",
      });
    });
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
  });

  it("shows running background task before page estimate", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "OpenAI / api.openai.com",
          providerMode: "remote",
        };
      }

      if (message.type === "getTaskForTab") {
        return {
          type: "taskProgress",
          progress: {
            taskId: "task-1",
            state: "translating",
            total: 32,
            translated: 8,
            failed: 1,
          },
        };
      }

      return idleTaskProgress();
    });

    render(PopupApp);

    expect(await screen.findByRole("button", { name: "取消翻译" })).toBeVisible();
    expect(screen.getByLabelText("Task progress")).toBeVisible();
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(123, {
      type: "estimatePage",
    });
  });

  it("shows existing translations before page estimate when no task is running", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (message.type === "estimatePage") {
          return {
            type: "estimatePageResult",
            estimate: {
              canTranslate: true,
              estimatedSegments: 32,
              estimatedChars: 1200,
            },
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    expect(await screen.findByText("页面已有译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新翻译" })).toBeVisible();
    expect(screen.getByRole("button", { name: "隐藏译文" })).toBeVisible();
    expect(screen.getByRole("button", { name: "移除译文" })).toBeVisible();
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(123, {
      type: "estimatePage",
    });
  });

  it("toggles and removes existing translations", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (
          message.type === "hideTranslations" ||
          message.type === "showTranslations" ||
          message.type === "removeTranslations"
        ) {
          return {
            type: "contentActionResult",
            success: true,
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "隐藏译文" }));

    expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, {
      type: "hideTranslations",
      taskId: "task-previous",
    });
    expect(screen.getByRole("button", { name: "显示译文" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "显示译文" }));

    expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, {
      type: "showTranslations",
      taskId: "task-previous",
    });
    expect(screen.getByRole("button", { name: "隐藏译文" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "移除译文" }));

    expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, {
      type: "removeTranslations",
      taskId: "task-previous",
    });
    expect(screen.queryByText("页面已有译文")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "翻译当前页面" })).toBeVisible();
  });

  it("shows an alert when hiding existing translations fails", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (message.type === "hideTranslations") {
          return {
            type: "contentActionResult",
            success: false,
            message: "Cannot hide translations.",
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "隐藏译文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot hide translations.");
    expect(screen.getByRole("button", { name: "隐藏译文" })).toBeVisible();
  });

  it("shows an alert when removing existing translations returns a content error", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (message.type === "removeTranslations") {
          return {
            type: "contentError",
            message: "Cannot remove translations.",
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "移除译文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot remove translations.");
    expect(screen.getByText("页面已有译文")).toBeVisible();
  });

  it("shows an alert when removing existing translations rejects", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (message.type === "removeTranslations") {
          throw new Error("Content script disconnected.");
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "移除译文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Content script disconnected.");
    expect(screen.getByText("页面已有译文")).toBeVisible();
  });

  it("removes existing translations before re-translating", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "hidden",
          };
        }

        if (message.type === "removeTranslations") {
          return {
            type: "contentActionResult",
            success: true,
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "OpenAI / api.openai.com",
          providerMode: "remote",
        };
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      if (message.type === "translatePage") {
        return {
          type: "taskProgress",
          progress: {
            taskId: "task-new",
            state: "translating",
            total: 32,
            translated: 0,
            failed: 0,
          },
        };
      }

      return { type: "backgroundActionResult", success: true };
    });

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "重新翻译" }));

    expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, {
      type: "removeTranslations",
      taskId: "task-previous",
    });
    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "translatePage",
      tabId: 123,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });
  });

  it("keeps existing translations retryable when re-translate removal fails", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: true,
            taskId: "task-previous",
            visibility: "visible",
          };
        }

        if (message.type === "removeTranslations") {
          return {
            type: "contentError",
            message: "Cannot remove before translating.",
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await fireEvent.click(await screen.findByRole("button", { name: "重新翻译" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot remove before translating.",
    );
    expect(browserMock.runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "translatePage" }),
    );
    expect(screen.getByText("页面已有译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新翻译" })).toBeVisible();
    expect(screen.getByRole("button", { name: "隐藏译文" })).toBeVisible();
  });

  it("requests page translation for the active tab and shows completed progress", async () => {
    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsQuery).toHaveBeenCalledWith({
        active: true,
        currentWindow: true,
      });
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "translatePage",
      tabId: 123,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });

    expect(await screen.findByRole("button", { name: "重新翻译" })).toBeVisible();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText("32")).toHaveLength(2);
    expect(screen.getByText("0")).toBeVisible();
  });

  it("requests page translation with explicit source and target languages", async () => {
    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    await fireEvent.update(screen.getByRole("combobox", { name: "Source language" }), "en");
    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "ja");
    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "translatePage",
      tabId: 123,
      sourceLanguage: "en",
      targetLanguage: "ja",
    });
  });

  it("prepares Chrome Built-in AI from the popup click before translating", async () => {
    const detectorDestroy = vi.fn(async () => undefined);
    const translatorDestroy = vi.fn(async () => undefined);
    const languageDetectorCreate = vi.fn(async () => ({
      detect: vi.fn(async () => [{ detectedLanguage: "en", confidence: 0.9 }]),
      destroy: detectorDestroy,
    }));
    const translatorCreate = vi.fn(async () => ({
      translate: vi.fn(async () => "translated"),
      destroy: translatorDestroy,
    }));
    vi.stubGlobal("LanguageDetector", {
      availability: vi.fn(async () => "available"),
      create: languageDetectorCreate,
    });
    vi.stubGlobal("Translator", {
      availability: vi.fn(async () => "available"),
      create: translatorCreate,
    });
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "Chrome Built-in AI",
          providerMode: "local-only",
        };
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      if (message.type === "translatePage") {
        return {
          type: "taskProgress",
          progress: {
            taskId: "task-new",
            state: "translating",
            total: 32,
            translated: 0,
            failed: 0,
          },
        };
      }

      return { type: "backgroundActionResult", success: true };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(languageDetectorCreate).toHaveBeenCalledTimes(1);
    expect(detectorDestroy).toHaveBeenCalledTimes(1);
    expect(browserMock.tabsDetectLanguage).toHaveBeenCalledWith(123);
    expect(translatorCreate).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    await waitFor(() => {
      expect(translatorDestroy).toHaveBeenCalledTimes(1);
    });
    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "translatePage",
      tabId: 123,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
  });

  it("returns cancelled task progress to a recoverable idle state", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "cancelled",
          total: 32,
          translated: 12,
          failed: 0,
        },
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(await screen.findByRole("button", { name: "翻译当前页面" })).toBeVisible();
    expect(screen.queryByLabelText("Task progress")).not.toBeInTheDocument();
    expect(screen.queryByText("翻译失败，请稍后重试。")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends cancelTask for the current running task", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      if (message.type === "cancelTask") {
        return {
          type: "taskProgress",
          progress: {
            taskId: "task-1",
            state: "cancelled",
            total: 32,
            translated: 8,
            failed: 0,
          },
        };
      }

      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "collecting",
          total: 32,
          translated: 0,
          failed: 0,
        },
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));
    await fireEvent.click(await screen.findByRole("button", { name: "取消翻译" }));

    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "cancelTask",
      taskId: "task-1",
      reason: "userCancelled",
    });
    expect(await screen.findByRole("button", { name: "翻译当前页面" })).toBeVisible();
  });

  it("applies background progress broadcasts for the active task", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "collecting",
          total: 32,
          translated: 0,
          failed: 0,
        },
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    for (const listener of browserMock.runtimeListeners) {
      listener({
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "translating",
          total: 32,
          translated: 10,
          failed: 1,
        },
      });
    }

    expect(await screen.findByText("10")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
  });

  it("disables translation when page estimate says the page is unsupported", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: false,
          };
        }

        if (message.type === "estimatePage") {
          return {
            type: "estimatePageResult",
            estimate: {
              canTranslate: false,
              estimatedSegments: 0,
              estimatedChars: 0,
              reason: "Unsupported page URL.",
            },
          };
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
      expect(screen.getByRole("button", { name: "翻译当前页面" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "一键总结" })).toBeDisabled();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported page URL.");
  });

  it("disables translation and summary when page estimate fails", async () => {
    browserMock.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "getPageRuntimeState") {
          return {
            type: "pageRuntimeState",
            hasTranslations: false,
          };
        }

        if (message.type === "estimatePage") {
          throw new Error("Could not establish connection.");
        }

        throw new Error(`Unexpected tab message: ${message.type}`);
      },
    );

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
      expect(screen.getByRole("button", { name: "翻译当前页面" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "一键总结" })).toBeDisabled();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not establish connection.",
    );
  });

  it("shows completed UI with failed count for completedWithErrors progress", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "completedWithErrors",
          total: 32,
          translated: 29,
          failed: 3,
        },
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(await screen.findByRole("button", { name: "重新翻译" })).toBeVisible();
    expect(screen.getByLabelText("Task progress")).toBeVisible();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("29")).toBeVisible();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("32")).toBeVisible();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeVisible();
  });

  it("shows failed progress as an error without completed UI", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "failed",
          total: 32,
          translated: 11,
          failed: 1,
          errorMessage: "Translation provider is unavailable.",
        },
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Translation provider is unavailable.",
    );
    expect(screen.getByRole("button", { name: "翻译当前页面" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新翻译" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Task progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("shows background error responses from translate requests", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return readyProviderStatus();
      }

      if (message.type === "getTaskForTab") {
        return idleTaskProgress();
      }

      return {
        type: "backgroundError",
        message: "No provider is configured.",
      };
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No provider is configured.");
  });
});

describe("language selector", () => {
  it("emits source and target language updates when selections change", async () => {
    const { emitted } = render(LanguageSelector, {
      props: {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        sourceOptions: sourceLanguageOptions,
        targetOptions: targetLanguageOptions,
      },
    });

    await fireEvent.update(screen.getByRole("combobox", { name: "Source language" }), "en");
    await fireEvent.update(screen.getByRole("combobox", { name: "Target language" }), "ja");

    expect(emitted("update:sourceLanguage")).toEqual([["en"]]);
    expect(emitted("update:targetLanguage")).toEqual([["ja"]]);
  });
});

describe("task progress", () => {
  it("labels completed, total, and failed counts for assistive technology", () => {
    render(TaskProgress, {
      props: {
        completed: 3,
        total: 5,
        failed: 1,
      },
    });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeVisible();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeVisible();
  });

  it("shows failed and completed items as processed progress", () => {
    render(TaskProgress, {
      props: {
        completed: 3,
        total: 5,
        failed: 1,
      },
    });

    const progressBar = screen.getByRole("progressbar", {
      name: "Translation progress",
    });

    expect(progressBar).toHaveAttribute("aria-valuemin", "0");
    expect(progressBar).toHaveAttribute("aria-valuemax", "100");
    expect(progressBar).toHaveAttribute("aria-valuenow", "80");
    expect(screen.getByText("4 / 5")).toBeVisible();
  });
});
