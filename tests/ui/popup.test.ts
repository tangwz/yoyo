import { render, screen } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";

import PopupApp from "../../entrypoints/popup/App.vue";

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
