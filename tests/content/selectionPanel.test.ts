import { beforeEach, describe, expect, it, vi } from "vitest";
import { showSelectionTranslation } from "@/content/selectionPanel";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
} from "@/messaging/contracts";

const translatedInput = {
  type: "showSelectionTranslation",
  requestId: "selection-request-1",
  state: "translated",
  sourceText: "Hello",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  selectedProviderId: "provider-1",
  providerOptions: [
    {
      id: "provider-1",
      label: "DeepSeek / deepseek-v4-flash",
      providerMode: "remote",
    },
  ],
  translatedText: "Hello translated",
} satisfies Extract<ContentRequest, { type: "showSelectionTranslation" }>;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function getPanel(): HTMLElement {
  const panel = document.getElementById("yoyo-selection-translation-panel");
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

function renderedConsoleOutput(calls: unknown[][]): string {
  return calls
    .map((call) =>
      call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" "),
    )
    .join("\n");
}

describe("selection panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("renders only translated text and no source text", () => {
    showSelectionTranslation({
      ...translatedInput,
      translatedText: "Ni hao",
    });

    const panel = getPanel();
    expect(panel.textContent).toContain("Ni hao");
    expect(panel.textContent).not.toContain("Hello");
    expect(panel.classList.contains("notranslate")).toBe(true);
    expect(panel.getAttribute("translate")).toBe("no");
    expect(panel.dataset.yoyoExtension).toBe("selection-translation-panel");
    expect(panel.getAttribute("role")).toBe("status");
  });

  it("renders provider dropdown and icon-only actions", () => {
    showSelectionTranslation(translatedInput);

    const panel = getPanel();
    const brand = panel.querySelector("[data-yoyo-selection-brand]");
    const providerSelect = panel.querySelector("select");
    const copyButton = panel.querySelector(
      '[data-yoyo-selection-action="copy"]',
    ) as HTMLButtonElement | null;
    const closeButton = panel.querySelector(
      '[data-yoyo-selection-action="close"]',
    ) as HTMLButtonElement | null;

    expect(brand).not.toBeNull();
    expect(providerSelect).not.toBeNull();
    expect(providerSelect?.getAttribute("aria-label")).toBe(
      "Selection translation provider",
    );
    expect(providerSelect?.textContent).toContain("DeepSeek / deepseek-v4-flash");
    expect(copyButton?.getAttribute("aria-label")).toBe("Copy translation");
    expect(closeButton?.getAttribute("aria-label")).toBe(
      "Close translation popup",
    );
    expect(copyButton?.querySelector("svg")).not.toBeNull();
    expect(closeButton?.querySelector("svg")).not.toBeNull();
    expect(copyButton?.textContent).not.toContain("Copy");
    expect(closeButton?.textContent).not.toContain("Close");
  });

  it("disables provider dropdown while a selection translation is loading", () => {
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-1",
      state: "loading",
    });

    const providerSelect = getPanel().querySelector("select") as HTMLSelectElement;

    expect(providerSelect.disabled).toBe(true);
  });

  it("replaces previous panel content", () => {
    showSelectionTranslation(translatedInput);
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-2",
      sourceText: "Good morning",
      state: "loading",
    });
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-2",
      sourceText: "Good morning",
      translatedText: "Morning translated",
    });

    expect(document.querySelectorAll("#yoyo-selection-translation-panel")).toHaveLength(
      1,
    );
    expect(document.body.textContent).not.toContain("Hello translated");
    expect(document.body.textContent).not.toContain("Good morning");
    expect(document.body.textContent).toContain("Morning translated");
  });

  it("ignores terminal results from stale selection requests", () => {
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-1",
      state: "loading",
    });
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-2",
      state: "loading",
      sourceText: "Good morning",
    });
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-1",
      translatedText: "Stale translation",
    });

    const panel = getPanel();
    expect(panel.textContent).toContain("Translating...");
    expect(panel.textContent).not.toContain("Stale translation");
    expect(panel.textContent).not.toContain("Good morning");
  });

  it("shows a new failed result after its loading state replaces an older popup", () => {
    showSelectionTranslation(translatedInput);
    showSelectionTranslation({
      ...translatedInput,
      requestId: "selection-request-2",
      state: "loading",
      sourceText: "Good morning",
      providerOptions: [],
    });
    showSelectionTranslation({
      type: "showSelectionTranslation",
      requestId: "selection-request-2",
      state: "failed",
      sourceText: "Good morning",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      providerOptions: [],
      errorMessage: "No translation provider is configured.",
    });

    const panel = getPanel();
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("No translation provider is configured.");
    expect(panel.textContent).not.toContain("Hello translated");
    expect(panel.textContent).not.toContain("Good morning");
  });

  it("does not reopen a closed panel when its terminal result arrives", () => {
    showSelectionTranslation({
      ...translatedInput,
      requestId: "closed-request-1",
      state: "loading",
    });

    const closeButton = getPanel().querySelector(
      '[data-yoyo-selection-action="close"]',
    ) as HTMLButtonElement;
    closeButton.click();

    showSelectionTranslation({
      ...translatedInput,
      requestId: "closed-request-1",
      translatedText: "Late translation",
    });

    expect(document.getElementById("yoyo-selection-translation-panel")).toBeNull();
  });

  it("does not reopen a closed panel when a later loading state arrives", () => {
    showSelectionTranslation({
      ...translatedInput,
      requestId: "closed-request-2",
      state: "loading",
      providerOptions: [],
    });

    const closeButton = getPanel().querySelector(
      '[data-yoyo-selection-action="close"]',
    ) as HTMLButtonElement;
    closeButton.click();

    showSelectionTranslation({
      ...translatedInput,
      requestId: "closed-request-2",
      state: "loading",
    });

    expect(document.getElementById("yoyo-selection-translation-panel")).toBeNull();
  });

  it("renders failed state without source text", () => {
    showSelectionTranslation({
      type: "showSelectionTranslation",
      requestId: "selection-request-1",
      state: "failed",
      sourceText: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: translatedInput.providerOptions,
      errorMessage: "Chrome Built-in AI is unavailable.",
    });

    const panel = getPanel();
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("Chrome Built-in AI is unavailable.");
    expect(panel.textContent).not.toContain("Hello");
  });

  it("sends provider update and translate messages on provider change", async () => {
    const messages: BackgroundRequest[] = [];
    const sendBackgroundMessage = vi.fn(
      async (message: BackgroundRequest): Promise<BackgroundResponse> => {
        messages.push(message);
        if (message.type === "setSelectionTranslationProvider") {
          return { type: "backgroundActionResult", success: true };
        }
        return {
          type: "selectionTranslationResult",
          requestId: "selection-request-2",
          providerId: "provider-2",
          translatedText: "Provider two translation",
        };
      },
    );

    showSelectionTranslation(
      {
        ...translatedInput,
        providerOptions: [
          ...translatedInput.providerOptions,
          {
            id: "provider-2",
            label: "OpenAI / gpt-4.1-mini",
            providerMode: "remote",
          },
        ],
      },
      {
        createRequestId: () => "selection-request-2",
        sendBackgroundMessage,
      },
    );

    const select = getPanel().querySelector("select") as HTMLSelectElement;
    select.value = "provider-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(getPanel().textContent).toContain("Translating...");

    await vi.waitFor(() => {
      expect(sendBackgroundMessage).toHaveBeenCalledTimes(2);
    });

    expect(messages).toEqual([
      {
        type: "setSelectionTranslationProvider",
        providerId: "provider-2",
      },
      {
        type: "translateSelectionWithProvider",
        requestId: "selection-request-2",
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        providerId: "provider-2",
      },
    ]);
    expect(getPanel().textContent).toContain("Provider two translation");
  });

  it("ignores stale provider switch results", async () => {
    const sendBackgroundMessage = vi.fn(
      async (message: BackgroundRequest): Promise<BackgroundResponse> => {
        if (message.type === "setSelectionTranslationProvider") {
          return { type: "backgroundActionResult", success: true };
        }
        return {
          type: "selectionTranslationResult",
          requestId: "stale-request",
          providerId: "provider-2",
          translatedText: "Stale translation",
        };
      },
    );

    showSelectionTranslation(
      {
        ...translatedInput,
        providerOptions: [
          ...translatedInput.providerOptions,
          {
            id: "provider-2",
            label: "OpenAI / gpt-4.1-mini",
            providerMode: "remote",
          },
        ],
      },
      {
        createRequestId: () => "selection-request-2",
        sendBackgroundMessage,
      },
    );

    const select = getPanel().querySelector("select") as HTMLSelectElement;
    select.value = "provider-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sendBackgroundMessage).toHaveBeenCalledTimes(2);
    });

    expect(getPanel().textContent).toContain("Translating...");
    expect(getPanel().textContent).not.toContain("Stale translation");
  });

  it("does not send translate when closed while provider save is pending", async () => {
    const setProvider = createDeferred<BackgroundResponse>();
    const messages: BackgroundRequest[] = [];
    const sendBackgroundMessage = vi.fn(
      async (message: BackgroundRequest): Promise<BackgroundResponse> => {
        messages.push(message);
        if (message.type === "setSelectionTranslationProvider") {
          return setProvider.promise;
        }
        return {
          type: "selectionTranslationResult",
          requestId: "selection-request-2",
          providerId: "provider-2",
          translatedText: "Provider two translation",
        };
      },
    );

    showSelectionTranslation(
      {
        ...translatedInput,
        providerOptions: [
          ...translatedInput.providerOptions,
          {
            id: "provider-2",
            label: "OpenAI / gpt-4.1-mini",
            providerMode: "remote",
          },
        ],
      },
      {
        createRequestId: () => "selection-request-2",
        sendBackgroundMessage,
      },
    );

    const select = getPanel().querySelector("select") as HTMLSelectElement;
    select.value = "provider-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(sendBackgroundMessage).toHaveBeenCalledTimes(1);
    });

    const closeButton = getPanel().querySelector(
      '[data-yoyo-selection-action="close"]',
    ) as HTMLButtonElement;
    closeButton.click();
    setProvider.resolve({ type: "backgroundActionResult", success: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(messages).toEqual([
      {
        type: "setSelectionTranslationProvider",
        providerId: "provider-2",
      },
    ]);
    expect(
      messages.some((message) => message.type === "translateSelectionWithProvider"),
    ).toBe(false);
    expect(document.getElementById("yoyo-selection-translation-panel")).toBeNull();
  });

  it("renders failed state when provider save returns background error", async () => {
    const messages: BackgroundRequest[] = [];
    const sendBackgroundMessage = vi.fn(
      async (message: BackgroundRequest): Promise<BackgroundResponse> => {
        messages.push(message);
        return {
          type: "backgroundError",
          message: "Unable to save provider.",
        };
      },
    );

    showSelectionTranslation(
      {
        ...translatedInput,
        providerOptions: [
          ...translatedInput.providerOptions,
          {
            id: "provider-2",
            label: "OpenAI / gpt-4.1-mini",
            providerMode: "remote",
          },
        ],
      },
      {
        createRequestId: () => "selection-request-2",
        sendBackgroundMessage,
      },
    );

    const select = getPanel().querySelector("select") as HTMLSelectElement;
    select.value = "provider-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(getPanel().textContent).toContain("Unable to save provider.");
    });

    expect(messages).toEqual([
      {
        type: "setSelectionTranslationProvider",
        providerId: "provider-2",
      },
    ]);
    expect(getPanel().getAttribute("role")).toBe("alert");
  });

  it("renders failed state when translate returns background error", async () => {
    const sendBackgroundMessage = vi.fn(
      async (message: BackgroundRequest): Promise<BackgroundResponse> => {
        if (message.type === "setSelectionTranslationProvider") {
          return { type: "backgroundActionResult", success: true };
        }
        return {
          type: "backgroundError",
          message: "Translation failed in background.",
        };
      },
    );

    showSelectionTranslation(
      {
        ...translatedInput,
        providerOptions: [
          ...translatedInput.providerOptions,
          {
            id: "provider-2",
            label: "OpenAI / gpt-4.1-mini",
            providerMode: "remote",
          },
        ],
      },
      {
        createRequestId: () => "selection-request-2",
        sendBackgroundMessage,
      },
    );

    const select = getPanel().querySelector("select") as HTMLSelectElement;
    select.value = "provider-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(getPanel().textContent).toContain("Translation failed in background.");
    });

    expect(getPanel().getAttribute("role")).toBe("alert");
  });

  it("updates copy button state and aria-label on copy success", async () => {
    const clipboard = {
      writeText: vi.fn(async () => undefined),
    };
    showSelectionTranslation(translatedInput, { clipboard });

    const panel = getPanel();
    const copyButton = panel.querySelector(
      '[data-yoyo-selection-action="copy"]',
    ) as HTMLButtonElement;
    copyButton.click();

    await vi.waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalledWith("Hello translated");
    });

    expect(copyButton.dataset.yoyoCopyState).toBe("copied");
    expect(copyButton.getAttribute("aria-label")).toBe("Copied");
    expect(panel.textContent).not.toContain("Copied");
  });

  it("updates copy button state and aria-label on copy failure", async () => {
    const clipboard = {
      writeText: vi.fn(async () => {
        throw new Error("Denied");
      }),
    };
    showSelectionTranslation(translatedInput, { clipboard });

    const panel = getPanel();
    const copyButton = panel.querySelector(
      '[data-yoyo-selection-action="copy"]',
    ) as HTMLButtonElement;
    copyButton.click();

    await vi.waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalledWith("Hello translated");
    });

    expect(copyButton.dataset.yoyoCopyState).toBe("failed");
    expect(copyButton.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.textContent).not.toContain("Copy failed");
  });

  it("removes panel on close", () => {
    showSelectionTranslation({
      ...translatedInput,
      requestId: "close-request-1",
    });

    const closeButton = getPanel().querySelector(
      '[data-yoyo-selection-action="close"]',
    ) as HTMLButtonElement;
    closeButton.click();

    expect(document.getElementById("yoyo-selection-translation-panel")).toBeNull();
  });

  it("traces successful selection panel rendering without raw text", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    showSelectionTranslation({
      ...translatedInput,
      sourceText: "Private source",
      translatedText: "Private translation",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.selectionPanel.done",
      expect.objectContaining({
        stage: "selection",
        sourceCharCount: 14,
        outputCharCount: 19,
        success: true,
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Private source");
    expect(output).not.toContain("Private translation");
  });

  it("traces failed selection panel rendering without raw text", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    showSelectionTranslation({
      type: "showSelectionTranslation",
      requestId: "selection-request-1",
      state: "failed",
      sourceText: "Private source",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: translatedInput.providerOptions,
      errorMessage: "Provider failed",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.selectionPanel.done",
      expect.objectContaining({
        stage: "selection",
        sourceCharCount: 14,
        outputCharCount: 0,
        success: false,
      }),
    );

    const output = renderedConsoleOutput(infoSpy.mock.calls);
    expect(output).not.toContain("Private source");
    expect(output).not.toContain("Provider failed");
  });
});
