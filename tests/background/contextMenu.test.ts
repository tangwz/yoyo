import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onSummarizePageMenuClick,
  onTranslatePageMenuClick,
  onTranslateSelectionMenuClick,
  registerContextMenus,
  summarizePageMenuId,
  translatePageMenuId,
  translateSelectionMenuId,
} from "@/background/contextMenu";

const { addListener, create, removeAll } = vi.hoisted(() => ({
  addListener: vi.fn(),
  create: vi.fn(),
  removeAll: vi.fn((callback: () => void) => callback()),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    contextMenus: {
      create,
      removeAll,
      onClicked: {
        addListener,
      },
    },
  },
}));

describe("context menu registration", () => {
  beforeEach(() => {
    addListener.mockReset();
    create.mockReset();
    removeAll.mockClear();
  });

  it("registers localized Chinese page translation, selection translation, and page summary menu items by default", () => {
    registerContextMenus();

    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledWith({
      id: translatePageMenuId,
      title: "翻译此页面",
      contexts: ["page"],
    });
    expect(create).toHaveBeenCalledWith({
      id: translateSelectionMenuId,
      title: "翻译选中文本",
      contexts: ["selection"],
    });
    expect(create).toHaveBeenCalledWith({
      id: summarizePageMenuId,
      title: "总结此页面",
      contexts: ["page"],
    });
  });

  it("registers English menu titles when the UI language is English", () => {
    registerContextMenus("en-US");

    expect(create).toHaveBeenCalledWith({
      id: translatePageMenuId,
      title: "Translate this page",
      contexts: ["page"],
    });
    expect(create).toHaveBeenCalledWith({
      id: translateSelectionMenuId,
      title: "Translate selection",
      contexts: ["selection"],
    });
    expect(create).toHaveBeenCalledWith({
      id: summarizePageMenuId,
      title: "Summarize this page",
      contexts: ["page"],
    });
  });

  it("routes async handler failures to the error callback", async () => {
    const error = new Error("translation failed");
    const onError = vi.fn();

    onTranslatePageMenuClick(
      async () => {
        throw error;
      },
      onError,
    );

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: translatePageMenuId }, { id: 42 });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(error, 42);
    });
  });

  it("ignores clicks from other menu items", () => {
    const handler = vi.fn();

    onTranslatePageMenuClick(handler);

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: "other.menu" }, { id: 42 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("routes selection clicks with tab id and selected text", () => {
    const handler = vi.fn(async () => undefined);

    onTranslateSelectionMenuClick(handler);

    const listener = addListener.mock.calls[0]?.[0];
    listener(
      { menuItemId: translateSelectionMenuId, selectionText: "  Hello world  " },
      { id: 42 },
    );

    expect(handler).toHaveBeenCalledWith({ tabId: 42, text: "Hello world" });
  });

  it("ignores selection clicks without text or tab id", () => {
    const handler = vi.fn(async () => undefined);

    onTranslateSelectionMenuClick(handler);

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: translateSelectionMenuId, selectionText: "   " }, { id: 42 });
    listener({ menuItemId: translateSelectionMenuId, selectionText: "Hello" }, {});
    listener({ menuItemId: translatePageMenuId, selectionText: "Hello" }, { id: 42 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("routes selection handler failures to the error callback", async () => {
    const error = new Error("selection translation failed");
    const onError = vi.fn();

    onTranslateSelectionMenuClick(
      async () => {
        throw error;
      },
      onError,
    );

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: translateSelectionMenuId, selectionText: "Hello" }, { id: 42 });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(error, { tabId: 42, text: "Hello" });
    });
  });

  it("routes summary page clicks with tab id", () => {
    const handler = vi.fn(async () => undefined);

    onSummarizePageMenuClick(handler);

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: summarizePageMenuId }, { id: 42 });

    expect(handler).toHaveBeenCalledWith(42);
  });

  it("routes summary handler failures to the error callback", async () => {
    const error = new Error("summary failed");
    const onError = vi.fn();

    onSummarizePageMenuClick(
      async () => {
        throw error;
      },
      onError,
    );

    const listener = addListener.mock.calls[0]?.[0];
    listener({ menuItemId: summarizePageMenuId }, { id: 42 });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(error, 42);
    });
  });
});
