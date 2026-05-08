import { fireEvent, render, screen } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";

import PopupApp from "../../entrypoints/popup/App.vue";
import LanguageSelector from "../../src/ui/components/LanguageSelector.vue";
import TaskProgress from "../../src/ui/components/TaskProgress.vue";
import {
  sourceLanguageOptions,
  targetLanguageOptions,
} from "../../src/i18n/languages";

describe("popup app", () => {
  it("renders the default popup controls", () => {
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
