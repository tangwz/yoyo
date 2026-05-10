import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOptionsPage } from "@/browser/browserApi";

const { createTab, getURL, queryTabs, runtimeOpenOptionsPage, updateTab, updateWindow } =
  vi.hoisted(() => ({
  createTab: vi.fn(),
  getURL: vi.fn((path: string) => `chrome-extension://id${path}`),
  queryTabs: vi.fn(),
  runtimeOpenOptionsPage: vi.fn(),
  updateTab: vi.fn(),
  updateWindow: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL,
      openOptionsPage: runtimeOpenOptionsPage,
    },
    tabs: {
      create: createTab,
      query: queryTabs,
      update: updateTab,
    },
    windows: {
      update: updateWindow,
    },
  },
}));

describe("browserApi", () => {
  beforeEach(() => {
    createTab.mockClear();
    getURL.mockClear();
    queryTabs.mockReset();
    runtimeOpenOptionsPage.mockClear();
    updateTab.mockClear();
    updateWindow.mockClear();
  });

  it("opens the default options page when no routing input is provided", async () => {
    await openOptionsPage();

    expect(runtimeOpenOptionsPage).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
    expect(getURL).not.toHaveBeenCalled();
  });

  it("opens routed options in a new tab when no options tab exists", async () => {
    queryTabs.mockResolvedValue([]);

    await openOptionsPage({ section: "provider", source: "first-run" });

    expect(runtimeOpenOptionsPage).not.toHaveBeenCalled();
    expect(getURL).toHaveBeenCalledWith(
      "/options.html?section=provider&source=first-run",
    );
    expect(queryTabs).toHaveBeenCalledWith({
      url: "chrome-extension://id/options.html*",
    });
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://id/options.html?section=provider&source=first-run",
    });
    expect(updateTab).not.toHaveBeenCalled();
  });

  it("keeps routed options metadata when URLSearchParams.size is unavailable", async () => {
    queryTabs.mockResolvedValue([]);
    const sizeSpy = vi
      .spyOn(URLSearchParams.prototype, "size", "get")
      .mockReturnValue(undefined as unknown as number);

    try {
      await openOptionsPage({ section: "provider", source: "first-run" });
    } finally {
      sizeSpy.mockRestore();
    }

    expect(runtimeOpenOptionsPage).not.toHaveBeenCalled();
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://id/options.html?section=provider&source=first-run",
    });
  });

  it("reuses an existing options tab when routing input is provided", async () => {
    queryTabs.mockResolvedValue([{ id: 42, windowId: 7 }]);

    await openOptionsPage({ section: "provider", source: "first-run" });

    expect(createTab).not.toHaveBeenCalled();
    expect(updateTab).toHaveBeenCalledWith(42, {
      active: true,
      url: "chrome-extension://id/options.html?section=provider&source=first-run",
    });
    expect(updateWindow).toHaveBeenCalledWith(7, { focused: true });
  });
});
