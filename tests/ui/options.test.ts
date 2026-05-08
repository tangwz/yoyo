import { fireEvent, render, screen } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";

import OptionsApp from "../../entrypoints/options/App.vue";

describe("options app", () => {
  it("renders provider, translation, privacy, and advanced settings", () => {
    render(OptionsApp);

    expect(screen.getByRole("heading", { name: "Provider" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Translation" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Advanced" })).toBeVisible();

    expect(
      screen.getByText("API Key 保存在浏览器扩展本地存储，不跨设备同步。"),
    ).toBeVisible();
    expect(
      screen.getByText("Page text is extracted only when you manually start translation."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Extracted text is sent to your configured model provider during translation.",
      ),
    ).toBeVisible();
  });

  it("renders provider form fields and advanced controls", () => {
    render(OptionsApp);

    expect(screen.getByRole("combobox", { name: "Preset" })).toHaveDisplayValue("OpenAI");
    expect(screen.getByRole("textbox", { name: "Display Name" })).toHaveValue("OpenAI");
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://api.openai.com/v1",
    );
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("textbox", { name: "Text Model" })).toHaveValue("gpt-4.1-mini");
    expect(screen.getByRole("textbox", { name: "Vision Model" })).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeVisible();

    expect(screen.getByRole("combobox", { name: "Target Language" })).toHaveValue("zh-CN");
    expect(screen.getByRole("spinbutton", { name: "Timeout" })).toHaveValue(30000);
    expect(screen.getByRole("spinbutton", { name: "Temperature" })).toHaveAttribute(
      "step",
      "0.1",
    );
    expect(screen.getByRole("spinbutton", { name: "Max Tokens" })).toHaveValue(4096);
  });

  it("fills provider fields from the selected preset", async () => {
    render(OptionsApp);

    await fireEvent.update(screen.getByRole("combobox", { name: "Preset" }), "deepseek");

    expect(screen.getByRole("textbox", { name: "Display Name" })).toHaveValue("DeepSeek");
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://api.deepseek.com/v1",
    );
    expect(screen.getByRole("textbox", { name: "Text Model" })).toHaveValue("deepseek-chat");
  });
});
