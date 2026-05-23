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
const getUiPreferences = vi.fn();
const saveUiPreferences = vi.fn();
const getTranslationPreferences = vi.fn();
const saveTranslationPreferences = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;

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
      get: getUiPreferences,
      save: saveUiPreferences,
    },
    translationPreferences: {
      get: getTranslationPreferences,
      save: saveTranslationPreferences,
    },
  });
}

async function renderReady(navigationName = "设置分区") {
  const result = render(OptionsApp);

  await screen.findByRole("navigation", { name: navigationName });

  return result;
}

function getTextModelInput(): HTMLInputElement {
  return screen.getByLabelText("文本模型") as HTMLInputElement;
}

describe("options app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/options.html");
    listProfiles.mockResolvedValue([]);
    getActiveProviderId.mockResolvedValue(undefined);
    getUiPreferences.mockResolvedValue({ theme: "light", uiLanguage: "zh-CN" });
    saveUiPreferences.mockResolvedValue(undefined);
    getTranslationPreferences.mockResolvedValue({
      mode: "lazyViewport",
      targetLanguage: "zh-CN",
    });
    saveTranslationPreferences.mockResolvedValue(undefined);
    mockStorageRepositories();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    window.history.pushState({}, "", "/options.html");
  });

  it("renders provider, translation, privacy, and advanced settings", async () => {
    await renderReady();

    const navigation = screen.getByRole("navigation", { name: "设置分区" });
    expect(navigation).toBeVisible();
    expect(screen.getByRole("link", { name: "模型服务" })).toHaveAttribute(
      "href",
      "#provider-heading",
    );
    expect(screen.getByRole("link", { name: "翻译" })).toHaveAttribute(
      "href",
      "#translation-heading",
    );
    expect(screen.getByRole("link", { name: "隐私" })).toHaveAttribute(
      "href",
      "#privacy-heading",
    );
    expect(screen.getByRole("link", { name: "高级设置" })).toHaveAttribute(
      "href",
      "#advanced-heading",
    );

    expect(screen.getByRole("heading", { name: "模型服务" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "翻译" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "隐私" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "高级设置" })).toBeVisible();

    expect(
      screen.getByText("访问密钥保存在浏览器扩展本地存储，不跨设备同步。"),
    ).toBeVisible();
    expect(
      screen.getByText("只有在你手动开始翻译时，扩展才会提取页面文本。"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "选择 OpenAI-compatible Provider 时，提取的文本会发送到你配置的模型服务；选择 Chrome Built-in AI 时，文本在本地处理，不会自动回退到远端 Provider。",
      ),
    ).toBeVisible();
  });

  it("renders options messages from the saved UI language", async () => {
    getUiPreferences.mockResolvedValue({ theme: "light", uiLanguage: "en-US" });

    await renderReady("Settings sections");

    expect(
      await screen.findByRole("navigation", { name: "Settings sections" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Provider" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Translation" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Advanced" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Interface language" })).toHaveValue("en-US");
    expect(
      screen.getByText(
        "The API key is stored locally in this browser extension and is not synced across devices.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Custom OpenAI compatible" })).toBeInTheDocument();
  });

  it("does not render settings text before the stored UI language is loaded", async () => {
    const uiPreferences = createDeferred<{ theme: "light"; uiLanguage: "en-US" }>();
    getUiPreferences.mockReturnValue(uiPreferences.promise);

    render(OptionsApp);

    expect(screen.queryByRole("navigation", { name: "设置分区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();

    uiPreferences.resolve({ theme: "light", uiLanguage: "en-US" });

    expect(
      await screen.findByRole("navigation", { name: "Settings sections" }),
    ).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "设置分区" })).not.toBeInTheDocument();
  });

  it("falls back to the default UI language when stored preferences are corrupted", async () => {
    getUiPreferences.mockResolvedValue({ theme: "light", uiLanguage: "fr-FR" });

    await renderReady();

    expect(await screen.findByRole("navigation", { name: "设置分区" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "模型服务" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "界面语言" })).toHaveValue("zh-CN");
  });

  it("falls back to the default UI language when stored preferences are missing it", async () => {
    getUiPreferences.mockResolvedValue({ theme: "light" });

    await renderReady();

    expect(await screen.findByRole("navigation", { name: "设置分区" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "模型服务" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "界面语言" })).toHaveValue("zh-CN");
  });

  it("renders provider form fields and advanced controls", async () => {
    await renderReady();

    expect(screen.getByRole("radio", { name: "OpenAI 兼容服务" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Chrome Built-in AI" })).toBeDisabled();
    expect(screen.getByText("需要桌面版 Chrome 138 或更高版本。无需访问密钥。")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "服务预设" })).toHaveDisplayValue("OpenAI");
    expect(screen.getByRole("textbox", { name: "显示名称" })).toHaveValue("OpenAI");
    expect(screen.getByRole("textbox", { name: "接口地址" })).toHaveValue(
      "https://api.openai.com/v1",
    );
    expect(screen.getByLabelText("访问密钥")).toHaveAttribute("type", "password");
    expect(getTextModelInput()).toHaveValue("gpt-5-mini");
    expect(screen.getByRole("textbox", { name: "视觉模型" })).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeVisible();

    expect(screen.getByRole("combobox", { name: "目标语言" })).toHaveValue("zh-CN");
    expect(screen.getByRole("combobox", { name: "翻译模式" })).toHaveValue(
      "lazyViewport",
    );
    expect(screen.getByRole("combobox", { name: "界面语言" })).toHaveValue("zh-CN");
    expect(screen.getByRole("spinbutton", { name: "超时时间" })).toHaveValue(30000);
    expect(screen.getByRole("spinbutton", { name: "温度" })).toHaveAttribute(
      "step",
      "0.1",
    );
    expect(screen.getByRole("spinbutton", { name: "最大输出长度" })).toHaveValue(4096);
  });

  it("defaults to Chrome Built-in AI first when the browser supports it", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("Translator", {});

    await renderReady();

    const providerTypeOptions = screen.getAllByRole("radio");

    expect(providerTypeOptions[0]).toHaveAccessibleName("Chrome Built-in AI");
    expect(screen.getByRole("radio", { name: "Chrome Built-in AI" })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Chrome Built-in AI" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "服务预设" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "测试连接" })).not.toBeInTheDocument();
  });

  it("saves Chrome Built-in AI as a zero-configuration provider when supported", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("LanguageDetector", {});
    vi.stubGlobal("Translator", {});
    await renderReady();

    await fireEvent.click(screen.getByRole("radio", { name: "Chrome Built-in AI" }));

    expect(screen.getByRole("radio", { name: "Chrome Built-in AI" })).toBeChecked();
    expect(screen.queryByRole("combobox", { name: "服务预设" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("访问密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "超时时间" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "温度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "最大输出长度" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chrome Built-in AI" })).toBeVisible();
    expect(screen.getByText("在支持的桌面版 Chrome 中本地运行。无需访问密钥。")).toBeVisible();
    expect(screen.getByText("需要桌面版 Chrome 138 或更高版本。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "测试连接" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(saveProfile).toHaveBeenCalledWith({
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    });
    expect(setActiveProviderId).toHaveBeenCalledWith("chrome-built-in-ai");
  });

  it("keeps a saved Chrome Built-in AI provider selected when the browser is unsupported", async () => {
    listProfiles.mockResolvedValue([
      {
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      },
    ]);
    getActiveProviderId.mockResolvedValue("chrome-built-in-ai");

    await renderReady();

    expect(screen.getByRole("radio", { name: "Chrome Built-in AI" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Chrome Built-in AI" })).toBeDisabled();
    expect(screen.getByText("需要桌面版 Chrome 138 或更高版本。无需访问密钥。")).toBeVisible();
    expect(screen.getByText("当前浏览器不可使用 Chrome Built-in AI。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Chrome Built-in AI" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "服务预设" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "超时时间" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "测试连接" })).not.toBeInTheDocument();
  });

  it("saves the selected UI language and rerenders options messages", async () => {
    await renderReady();

    const languageSelect = await screen.findByRole("combobox", { name: "界面语言" });
    expect(languageSelect).toHaveValue("zh-CN");

    await fireEvent.update(languageSelect, "en-US");

    await waitFor(() => {
      expect(saveUiPreferences).toHaveBeenCalledWith({
        theme: "light",
        uiLanguage: "en-US",
      });
    });
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Interface language" })).toHaveValue("en-US");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeVisible();
  });

  it("loads the stored target language", async () => {
    getTranslationPreferences.mockResolvedValue({
      mode: "fullPage",
      targetLanguage: "en",
    });

    await renderReady();

    const targetSelect = await screen.findByRole("combobox", { name: "目标语言" });
    await waitFor(() => {
      expect(targetSelect).toHaveValue("en");
    });
    expect(targetSelect).toHaveDisplayValue("英语");
  });

  it("saves target language changes without changing translation mode", async () => {
    getTranslationPreferences.mockResolvedValue({
      mode: "fullPage",
      targetLanguage: "en",
    });

    await renderReady();

    const targetSelect = await screen.findByRole("combobox", { name: "目标语言" });
    await fireEvent.update(targetSelect, "ja");

    await waitFor(() => {
      expect(saveTranslationPreferences).toHaveBeenCalledWith({
        mode: "fullPage",
        targetLanguage: "ja",
      });
    });
  });

  it("saves target language changes with the latest stored translation mode", async () => {
    getTranslationPreferences
      .mockResolvedValueOnce({ mode: "fullPage", targetLanguage: "en" })
      .mockResolvedValueOnce({ mode: "lazyViewport", targetLanguage: "en" });

    await renderReady();

    const targetSelect = await screen.findByRole("combobox", { name: "目标语言" });
    await fireEvent.update(targetSelect, "ja");

    await waitFor(() => {
      expect(saveTranslationPreferences).toHaveBeenCalledWith({
        mode: "lazyViewport",
        targetLanguage: "ja",
      });
    });
  });

  it("saves translation mode changes without changing target language", async () => {
    getTranslationPreferences.mockResolvedValue({
      mode: "fullPage",
      targetLanguage: "en",
    });

    await renderReady();

    const modeSelect = await screen.findByRole("combobox", { name: "翻译模式" });
    await waitFor(() => {
      expect(modeSelect).toHaveValue("fullPage");
    });

    await fireEvent.update(modeSelect, "lazyViewport");

    await waitFor(() => {
      expect(saveTranslationPreferences).toHaveBeenCalledWith({
        mode: "lazyViewport",
        targetLanguage: "en",
      });
    });
  });

  it("serializes translation preference saves so quick changes keep both final values", async () => {
    const storedPreferences: { mode: "fullPage" | "lazyViewport"; targetLanguage: string } = {
      mode: "fullPage",
      targetLanguage: "en",
    };
    const firstSave = createDeferred<void>();
    saveTranslationPreferences.mockImplementation(async (preferences) => {
      storedPreferences.mode = preferences.mode;
      storedPreferences.targetLanguage = preferences.targetLanguage;

      if (saveTranslationPreferences.mock.calls.length === 1) {
        await firstSave.promise;
      }
    });
    getTranslationPreferences.mockImplementation(async () => ({ ...storedPreferences }));

    await renderReady();

    const modeSelect = await screen.findByRole("combobox", { name: "翻译模式" });
    const targetSelect = await screen.findByRole("combobox", { name: "目标语言" });

    await fireEvent.update(modeSelect, "lazyViewport");
    await fireEvent.update(targetSelect, "ja");

    expect(saveTranslationPreferences).toHaveBeenCalledTimes(1);

    firstSave.resolve();

    await waitFor(() => {
      expect(saveTranslationPreferences).toHaveBeenCalledTimes(2);
    });
    expect(saveTranslationPreferences).toHaveBeenLastCalledWith({
      mode: "lazyViewport",
      targetLanguage: "ja",
    });
  });

  it("lands on the provider section from first-run options routing", async () => {
    const scrollIntoView = vi.fn();
    window.history.pushState(
      {},
      "",
      "/options.html?section=provider&source=first-run",
    );
    Element.prototype.scrollIntoView = scrollIntoView;

    await renderReady();

    expect(screen.getByText("首次使用前，请先配置模型服务。")).toBeVisible();

    const providerSection = screen.getByRole("heading", { name: "模型服务" }).closest("section");
    const presetSelect = screen.getByRole("combobox", { name: "服务预设" });

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
      expect(scrollIntoView.mock.instances[0]).toBe(providerSection);
      expect(presetSelect).toHaveFocus();
    });
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

    await renderReady();

    expect(await screen.findByDisplayValue("Custom Provider")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "服务预设" })).toHaveDisplayValue(
      "自定义兼容服务",
    );
    expect(screen.getByRole("textbox", { name: "接口地址" })).toHaveValue(
      "https://api.example.test/v1",
    );
    expect(screen.getByLabelText("访问密钥")).toHaveValue("saved-key");
    expect(screen.getByRole("textbox", { name: "文本模型" })).toHaveValue(
      "custom-text-model",
    );
    expect(screen.getByRole("textbox", { name: "视觉模型" })).toHaveValue(
      "custom-vision-model",
    );
    expect(screen.getByRole("spinbutton", { name: "超时时间" })).toHaveValue(60000);
    expect(screen.getByRole("spinbutton", { name: "温度" })).toHaveValue(0.2);
    expect(screen.getByRole("spinbutton", { name: "最大输出长度" })).toHaveValue(8192);
  });

  it("loads a fallback provider profile when the active provider id is missing", async () => {
    listProfiles.mockResolvedValue([
      {
        id: "incomplete",
        displayName: "Incomplete Provider",
        presetId: "custom",
        type: "openai-compatible",
        baseURL: "https://api.incomplete.example/v1",
        apiKey: "",
        textModel: "missing-key-model",
      },
      {
        id: "deepseek",
        displayName: "DeepSeek Work",
        presetId: "deepseek",
        type: "openai-compatible",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "saved-key",
        textModel: "deepseek-chat",
      },
    ]);
    getActiveProviderId.mockResolvedValue(undefined);

    await renderReady();

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "显示名称" })).toHaveValue("DeepSeek Work");
    });
    expect(screen.getByRole("combobox", { name: "服务预设" })).toHaveDisplayValue("DeepSeek");
    expect(screen.getByRole("textbox", { name: "接口地址" })).toHaveValue(
      "https://api.deepseek.com/v1",
    );
    expect(screen.getByLabelText("访问密钥")).toHaveValue("saved-key");
    expect(getTextModelInput()).toHaveValue("deepseek-chat");
    expect(setActiveProviderId).toHaveBeenCalledWith("deepseek");
  });

  it.each([
    ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-v4-flash"],
    ["kimi", "Kimi", "https://api.moonshot.ai/v1", "kimi-k2.6"],
    ["glm", "GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-5.1"],
    ["minimax", "MiniMax", "https://api.minimax.io/v1", "MiniMax-M2.7"],
    ["xiaomi-mimo", "Xiaomi MiMo", "https://api.xiaomimimo.com/v1", "MiMo-V2.5"],
  ])("fills provider fields from the %s preset", async (presetId, name, url, model) => {
    await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), presetId);

    expect(screen.getByRole("textbox", { name: "显示名称" })).toHaveValue(name);
    expect(screen.getByRole("textbox", { name: "接口地址" })).toHaveValue(url);
    expect(getTextModelInput()).toHaveValue(model);
  });

  it("offers current OpenAI, DeepSeek, and Kimi model options", async () => {
    const { container } = await renderReady();

    expect(
      [...container.querySelectorAll<HTMLOptionElement>("datalist#text-model-options option")].map(
        (option) => option.value,
      ),
    ).toEqual(["gpt-5-mini", "gpt-5", "gpt-5.2"]);

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "deepseek");
    expect(
      [...container.querySelectorAll<HTMLOptionElement>("datalist#text-model-options option")].map(
        (option) => option.value,
      ),
    ).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "kimi");
    expect(
      [...container.querySelectorAll<HTMLOptionElement>("datalist#text-model-options option")].map(
        (option) => option.value,
      ),
    ).toEqual(["kimi-k2.6", "kimi-k2.5"]);
  });

  it("offers Xiaomi MiMo Pro as a selectable text model option", async () => {
    const { container } = await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "xiaomi-mimo");

    const textModelInput = screen.getByRole("combobox", { name: "文本模型" });
    expect(textModelInput).toHaveAttribute("list", "text-model-options");
    expect(
      [...container.querySelectorAll<HTMLOptionElement>("datalist#text-model-options option")].map(
        (option) => option.value,
      ),
    ).toEqual(["MiMo-V2.5", "MiMo-V2.5-Pro"]);
  });

  it("saves the selected provider profile and activates it", async () => {
    await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "deepseek");
    await fireEvent.update(screen.getByRole("textbox", { name: "显示名称" }), "DeepSeek Work");
    await fireEvent.update(screen.getByRole("textbox", { name: "接口地址" }), "https://api.example.com/v1");
    await fireEvent.update(screen.getByLabelText("访问密钥"), "secret-key");
    await fireEvent.update(getTextModelInput(), "deepseek-chat");
    await fireEvent.update(screen.getByRole("textbox", { name: "视觉模型" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "超时时间" }), "45000");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "温度" }), "0.7");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "最大输出长度" }), "2048");

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

  it("normalizes known preset model casing before saving", async () => {
    await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "openai");
    await fireEvent.update(getTextModelInput(), " GPT-5-MINI ");
    await fireEvent.update(screen.getByRole("textbox", { name: "视觉模型" }), " CUSTOM-VISION ");

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        textModel: "gpt-5-mini",
        visionModel: "CUSTOM-VISION",
      }),
    );
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
    await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "deepseek");
    await fireEvent.update(screen.getByRole("textbox", { name: "显示名称" }), "DeepSeek Work");
    await fireEvent.update(screen.getByRole("textbox", { name: "接口地址" }), "https://api.example.com/v1");
    await fireEvent.update(screen.getByLabelText("访问密钥"), "secret-key");
    await fireEvent.update(getTextModelInput(), "deepseek-chat");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "超时时间" }), "45000");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "温度" }), "0.7");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "最大输出长度" }), "2048");

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
      temperature: 0,
      max_tokens: 32,
    });
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");
  });

  it("rerenders successful provider test feedback when the UI language changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            model: "gpt-5-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");

    await fireEvent.update(screen.getByRole("combobox", { name: "界面语言" }), "en-US");

    expect(await screen.findByText("Test succeeded.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("测试成功。")).not.toBeInTheDocument();
  });

  it("keeps the original text model when lower-case probing is rejected during a successful test", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("model not found", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderReady();

    await fireEvent.update(screen.getByRole("combobox", { name: "服务预设" }), "custom");
    await fireEvent.update(getTextModelInput(), "Custom-Model");
    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");
    expect(getTextModelInput()).toHaveValue("Custom-Model");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe("custom-model");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).model).toBe("Custom-Model");
  });

  it("tests MiMo mixed-case input using lower-case model casing without surfacing casing details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderReady();

    await fireEvent.update(
      screen.getByRole("textbox", { name: "接口地址" }),
      "https://token-plan-cn.xiaomimimo.com/v1",
    );
    await fireEvent.update(getTextModelInput(), "MiMo-V2.5");
    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      model: "mimo-v2.5",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      temperature: 0,
      max_tokens: 32,
    });
    expect(getTextModelInput()).toHaveValue("mimo-v2.5");
    expect(screen.queryByText(/大小写/)).not.toBeInTheDocument();
  });

  it("tests a pasted chat completions endpoint with query params without duplicating the endpoint path", async () => {
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
    await renderReady();

    await fireEvent.update(
      screen.getByRole("textbox", { name: "接口地址" }),
      "https://api.example.com/v1/chat/completions?api-version=2026-05-01",
    );

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions?api-version=2026-05-01",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");
  });

  it("shows error feedback when testing the provider connection fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法连接到服务，请检查接口地址和网络后重试。",
    );
    expect(saveProfile).not.toHaveBeenCalled();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });

  it("rerenders failed provider test feedback when the UI language changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法连接到服务，请检查接口地址和网络后重试。",
    );

    await fireEvent.update(screen.getByRole("combobox", { name: "界面语言" }), "en-US");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot connect to the provider. Check the Base URL and network, then try again.",
    );
    expect(
      screen.queryByText("无法连接到服务，请检查接口地址和网络后重试。"),
    ).not.toBeInTheDocument();
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
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型名或请求参数无效，请检查后重试。",
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
            model: "gpt-5-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试成功。")).toHaveAttribute("role", "status");

    await fireEvent.update(getTextModelInput(), "gpt-5");

    expect(screen.queryByText("测试成功。")).not.toBeInTheDocument();
  });

  it("ignores provider test results when the form changes before the request completes", async () => {
    const response = createDeferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(response.promise));
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await fireEvent.update(getTextModelInput(), "gpt-5");

    response.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "gpt-5-mini",
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
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("测试失败，请检查服务配置后重试。");
    expect(screen.queryByText(/sk-secret-token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private\.example\.com/)).not.toBeInTheDocument();
  });

  it("normalizes blank numeric request params before saving", async () => {
    await renderReady();

    await fireEvent.update(screen.getByRole("spinbutton", { name: "超时时间" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "温度" }), "");
    await fireEvent.update(screen.getByRole("spinbutton", { name: "最大输出长度" }), "");

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
    await renderReady();

    await fireEvent.click(screen.getByRole("button", { name: "保存翻译服务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，请稍后重试。");
    expect(screen.queryByText("已保存翻译服务。")).not.toBeInTheDocument();
    expect(setActiveProviderId).not.toHaveBeenCalled();
  });
});
