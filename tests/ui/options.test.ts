import { fireEvent, render, screen } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OptionsApp from "../../entrypoints/options/App.vue";
import { createStorageRepositories } from "@/storage/repositories";

vi.mock("@/storage/repositories", () => ({
  createStorageRepositories: vi.fn(),
}));

const saveProfile = vi.fn();
const setActiveProviderId = vi.fn();

function mockStorageRepositories() {
  vi.mocked(createStorageRepositories).mockReturnValue({
    providers: {
      listProfiles: vi.fn(),
      saveProfile,
      getActiveProviderId: vi.fn(),
      setActiveProviderId,
    },
    uiPreferences: {
      get: vi.fn(),
      save: vi.fn(),
    },
  });
}

describe("options app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageRepositories();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("saves the selected provider profile and activates it", async () => {
    render(OptionsApp);

    await fireEvent.update(screen.getByRole("combobox", { name: "Preset" }), "deepseek");
    await fireEvent.update(screen.getByRole("textbox", { name: "Display Name" }), "DeepSeek Work");
    await fireEvent.update(screen.getByRole("textbox", { name: "Base URL" }), "https://api.example.com/v1");
    await fireEvent.update(screen.getByLabelText("API Key"), "secret-key");
    await fireEvent.update(screen.getByRole("textbox", { name: "Text Model" }), "deepseek-chat");
    await fireEvent.update(screen.getByRole("textbox", { name: "Vision Model" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Timeout" }), "45000");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Temperature" }), "0.7");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Max Tokens" }), "2048");

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(saveProfile).toHaveBeenCalledWith({
      id: "deepseek",
      displayName: "DeepSeek Work",
      presetId: "deepseek",
      type: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "secret-key",
      textModel: "deepseek-chat",
      visionModel: undefined,
      requestParams: {
        timeoutMs: 45000,
        temperature: 0.7,
        maxTokens: 2048,
      },
    });
    expect(setActiveProviderId).toHaveBeenCalledWith("deepseek");
    expect(await screen.findByText("已保存翻译服务。")).toBeVisible();
  });

  it("tests the current provider form with the fixed connection prompt without saving", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "deepseek-chat",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(OptionsApp);

    await fireEvent.update(screen.getByRole("combobox", { name: "Preset" }), "deepseek");
    await fireEvent.update(screen.getByRole("textbox", { name: "Display Name" }), "DeepSeek Work");
    await fireEvent.update(screen.getByRole("textbox", { name: "Base URL" }), "https://api.example.com/v1");
    await fireEvent.update(screen.getByLabelText("API Key"), "secret-key");
    await fireEvent.update(screen.getByRole("textbox", { name: "Text Model" }), "deepseek-chat");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Timeout" }), "45000");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Temperature" }), "0.7");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Max Tokens" }), "2048");

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0.7,
      max_tokens: 2048,
    });
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");
  });

  it("shows error feedback when testing the provider connection fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider request failed before receiving a response.",
    );
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });

  it("normalizes blank numeric request params before saving", async () => {
    render(OptionsApp);

    await fireEvent.update(screen.getByRole("spinbutton", { name: "Timeout" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Temperature" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "Max Tokens" }), "");

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        requestParams: {
          timeoutMs: 30000,
          temperature: 0.3,
          maxTokens: 4096,
        },
      }),
    );
  });

  it("shows error feedback when saving a provider profile fails", async () => {
    saveProfile.mockRejectedValueOnce(new Error("storage failed"));
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，请稍后重试。");
    expect(screen.queryByText("已保存翻译服务。")).not.toBeInTheDocument();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });
});
