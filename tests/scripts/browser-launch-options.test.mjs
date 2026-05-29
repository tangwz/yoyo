import { describe, expect, it } from "vitest";

import {
  getBrowserExecutableCandidates,
  normalizeBrowserTarget,
} from "../../scripts/browser-launch-options.mjs";

describe("browser launch options", () => {
  it("defaults to Chrome target", () => {
    expect(normalizeBrowserTarget(undefined)).toBe("chrome");
    expect(normalizeBrowserTarget("")).toBe("chrome");
    expect(normalizeBrowserTarget("chrome")).toBe("chrome");
  });

  it("supports Edge target aliases", () => {
    expect(normalizeBrowserTarget("edge")).toBe("edge");
    expect(normalizeBrowserTarget("msedge")).toBe("edge");
    expect(normalizeBrowserTarget("microsoft-edge")).toBe("edge");
  });

  it("prefers Edge before Chrome when Edge is requested", () => {
    expect(
      getBrowserExecutableCandidates({
        target: "edge",
        homeDir: "/Users/example",
      }),
    ).toEqual([
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/example/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ]);
  });
});
