import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOptionsPage } from "@/browser/browserApi";

const { createTab, getURL, runtimeOpenOptionsPage } = vi.hoisted(() => ({
  createTab: vi.fn(),
  getURL: vi.fn((path: string) => `chrome-extension://id${path}`),
  runtimeOpenOptionsPage: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL,
      openOptionsPage: runtimeOpenOptionsPage,
    },
    tabs: {
      create: createTab,
    },
  },
}));

describe("browserApi", () => {
  beforeEach(() => {
    createTab.mockClear();
    getURL.mockClear();
    runtimeOpenOptionsPage.mockClear();
  });

  it("opens the default options page when no routing input is provided", async () => {
    await openOptionsPage();

    expect(runtimeOpenOptionsPage).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
    expect(getURL).not.toHaveBeenCalled();
  });

  it("opens routed options in a new tab when routing input is provided", async () => {
    await openOptionsPage({ section: "provider", source: "first-run" });

    expect(runtimeOpenOptionsPage).not.toHaveBeenCalled();
    expect(getURL).toHaveBeenCalledWith(
      "/options.html?section=provider&source=first-run",
    );
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://id/options.html?section=provider&source=first-run",
    });
  });
});
