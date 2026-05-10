import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OptionsApp from "../../entrypoints/options/App.vue";
import { createStorageRepositories } from "@/storage/repositories";

vi.mock("@/storage/repositories", () => ({
  createStorageRepositories: vi.fn(),
}));

const saveProfile = vi.fn();
const setActiveProviderId = vi.fn();
const listProfiles = vi.fn();
const getActiveProviderId = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function mockStorageRepositories() {
  vi.mocked(createStorageRepositories).mockReturnValue({
    providers: {
      listProfiles,
      saveProfile,
      getActiveProviderId,
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
    listProfiles.mockResolvedValue([]);
    getActiveProviderId.mockResolvedValue(undefined);
    mockStorageRepositories();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders provider, translation, privacy, and advanced settings", () => {
    render(OptionsApp);

    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(navigation).toBeVisible();
    expect(screen.getByRole("link", { name: "Provider" })).toHaveAttribute(
      "href",
      "#provider-heading",
    );
    expect(screen.getByRole("link", { name: "Translation" })).toHaveAttribute(
      "href",
      "#translation-heading",
    );
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "#privacy-heading",
    );
    expect(screen.getByRole("link", { name: "Advanced" })).toHaveAttribute(
      "href",
      "#advanced-heading",
    );

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

  it("loads the active provider profile into the settings form", async () => {
    listProfiles.mockResolvedValue([
      {
        id: "openai",
        displayName: "Custom Provider",
        presetId: "custom",
        type: "openai-compatible",
        baseURL: "https://api.example.test/v1",
        apiKey: "saved-key",
        textModel: "custom-text-model",
        visionModel: "custom-vision-model",
        requestParams: {
          timeoutMs: 60000,
          temperature: 0.2,
          maxTokens: 8192,
        },
      },
    ]);
    getActiveProviderId.mockResolvedValue("openai");

    render(OptionsApp);

    expect(await screen.findByDisplayValue("Custom Provider")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Preset" })).toHaveDisplayValue(
      "Custom OpenAI Compatible",
    );
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://api.example.test/v1",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("saved-key");
    expect(screen.getByRole("textbox", { name: "Text Model" })).toHaveValue(
      "custom-text-model",
    );
    expect(screen.getByRole("textbox", { name: "Vision Model" })).toHaveValue(
      "custom-vision-model",
    );
    expect(screen.getByRole("spinbutton", { name: "Timeout" })).toHaveValue(60000);
    expect(screen.getByRole("spinbutton", { name: "Temperature" })).toHaveValue(0.2);
    expect(screen.getByRole("spinbutton", { name: "Max Tokens" })).toHaveValue(8192);
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
      "无法连接到服务，请检查 Base URL 和网络后重试。",
    );
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });

  it("shows model-specific feedback when the provider rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型名或请求参数无效，请确认模型 ID 区分大小写。",
    );
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });

  it("clears successful provider test feedback when the tested form changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            model: "gpt-4.1-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");

    await fireEvent.update(screen.getByRole("textbox", { name: "Text Model" }), "gpt-4.1");

    expect(screen.queryByText("测试成功。")).not.toBeInTheDocument();
  });

  it("ignores provider test results when the form changes before the request completes", async () => {
    const response = createDeferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(response.promise));
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await fireEvent.update(screen.getByRole("textbox", { name: "Text Model" }), "gpt-4.1");

    response.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "gpt-4.1-mini",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(screen.queryByText("正在测试连接...")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("测试成功。")).not.toBeInTheDocument();
  });

  it("shows bounded provider test failure feedback without rendering sensitive response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream leaked sk-secret-token and https://private.example.com/v1", {
          status: 418,
        }),
      ),
    );
    render(OptionsApp);

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("测试失败，请检查服务配置后重试。");
    expect(screen.queryByText(/sk-secret-token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private\.example\.com/)).not.toBeInTheDocument();
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
