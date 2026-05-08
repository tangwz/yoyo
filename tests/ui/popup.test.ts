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

const browserMock = vi.hoisted(() => ({
  runtimeSendMessage: vi.fn(),
  tabsQuery: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: browserMock.runtimeSendMessage,
    },
    tabs: {
      query: browserMock.tabsQuery,
      sendMessage: browserMock.tabsSendMessage,
    },
  },
}));

describe("popup app", () => {
  beforeEach(() => {
    browserMock.runtimeSendMessage.mockReset();
    browserMock.tabsQuery.mockReset();
    browserMock.tabsSendMessage.mockReset();

    browserMock.tabsQuery.mockResolvedValue([{ id: 123 }]);
    browserMock.tabsSendMessage.mockResolvedValue({
      type: "estimatePageResult",
      estimate: {
        canTranslate: true,
        estimatedSegments: 32,
        estimatedChars: 1200,
      },
    });
    browserMock.runtimeSendMessage.mockResolvedValue({
      type: "taskProgress",
      progress: {
        taskId: "task-1",
        state: "completed",
        total: 32,
        translated: 32,
        failed: 0,
      },
    });
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
    expect(screen.getByText("翻译当前页面")).toBeVisible();
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.getByText("0.1.0")).toBeVisible();
    expect(screen.getByText("更多")).toBeVisible();

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });
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

  it("keeps cancelled task progress in the translating state", async () => {
    browserMock.runtimeSendMessage.mockResolvedValueOnce({
      type: "taskProgress",
      progress: {
        taskId: "task-1",
        state: "cancelled",
        total: 32,
        translated: 12,
        failed: 0,
      },
    });

    render(PopupApp);

    await waitFor(() => {
      expect(browserMock.tabsSendMessage).toHaveBeenCalledWith(123, { type: "estimatePage" });
    });

    await fireEvent.click(screen.getByRole("button", { name: "翻译当前页面" }));

    expect(await screen.findByRole("button", { name: "取消翻译" })).toBeVisible();
    expect(screen.queryByText("翻译失败，请稍后重试。")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
});
