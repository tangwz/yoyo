import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTranslatePageMenuClick,
  registerContextMenus,
  translatePageMenuId,
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

  it("registers a single translate page menu item", () => {
    registerContextMenus();

    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      id: translatePageMenuId,
      title: "Translate this page",
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
});
