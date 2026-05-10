import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const browserMock = vi.hoisted(() => ({
  runtimeListeners: new Set<(message: unknown) => void>(),
  runtimeOpenOptionsPage: vi.fn(),
  runtimeSendMessage: vi.fn(),
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
    tabs: {
      query: browserMock.tabsQuery,
      sendMessage: browserMock.tabsSendMessage,
    },
  },
}));

describe("popup app", () => {
  beforeEach(() => {
    browserMock.runtimeListeners.clear();
    browserMock.runtimeOpenOptionsPage.mockReset();
    browserMock.runtimeSendMessage.mockReset();
    browserMock.tabsQuery.mockReset();
    browserMock.tabsSendMessage.mockReset();

    browserMock.tabsQuery.mockResolvedValue([{ id: 123 }]);
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

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
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

  it("renders the default popup controls", async () => {
    render(PopupApp);

    expect(screen.getByText("悠悠阅读助手")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveDisplayValue(
      "自动检测",
    );
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveDisplayValue(
      "简体中文",
    );
    expect(screen.getByText("翻译服务")).toBeVisible();
    expect(await screen.findByText("OpenAI / api.openai.com")).toBeVisible();
    expect(screen.getByText("翻译当前页面")).toBeVisible();
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.getByText("0.1.0")).toBeVisible();
    expect(screen.getByText("更多")).toBeVisible();

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
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
      source: "popup",
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

    expect(screen.getByRole("button", { name: "打开设置" })).toBeVisible();
    expect(browserMock.tabsQuery).not.toHaveBeenCalled();
    expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(expect.any(Number), {
      type: "estimatePage",
    });
  });

  it("shows running background task before page estimate", async () => {
    browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "getProviderStatus") {
        return {
          type: "providerStatus",
          configured: true,
          readiness: "ready",
          providerLabel: "OpenAI / api.openai.com",
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
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported page URL.");
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
