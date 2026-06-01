// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  addStorageListener: vi.fn(),
  removeStorageListener: vi.fn(),
}));

const youtubeRuntimeMock = vi.hoisted(() => ({
  createYouTubeSubtitleRuntime: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      onChanged: {
        addListener: browserMock.addStorageListener,
        removeListener: browserMock.removeStorageListener,
      },
    },
  },
}));

vi.mock("@/content/youtubeSubtitle/runtime", () => ({
  createYouTubeSubtitleRuntime: youtubeRuntimeMock.createYouTubeSubtitleRuntime,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("content entrypoint", () => {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("defineContentScript", (definition: unknown) => definition);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        sync: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
    vi.stubGlobal("browser", {
      storage: {
        onChanged: {
          addListener: browserMock.addStorageListener,
          removeListener: browserMock.removeStorageListener,
        },
      },
    });
    browserMock.addStorageListener.mockReset();
    browserMock.removeStorageListener.mockReset();
    youtubeRuntimeMock.createYouTubeSubtitleRuntime.mockReset();
    youtubeRuntimeMock.createYouTubeSubtitleRuntime.mockReturnValue({
      start: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      handleConfigChanged: vi.fn(async () => undefined),
    });
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    (window as unknown as { happyDOM: { setURL: (nextUrl: string) => void } })
      .happyDOM.setURL("https://www.youtube.com/watch?v=abc");
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    vi.unstubAllGlobals();
  });

  it("ignores stale YouTube runtime startup checks after a newer blacklist change", async () => {
    const firstCheck = deferred<boolean>();
    const checks: Promise<boolean>[] = [firstCheck.promise, Promise.resolve(true)];
    const shouldBlockCurrentSite = vi.fn(() => checks.shift() ?? Promise.resolve(false));
    const { installYouTubeSubtitleRuntimeManager } = await import(
      "../../entrypoints/content"
    );

    installYouTubeSubtitleRuntimeManager({ shouldBlockCurrentSite });
    window.dispatchEvent(new Event("yoyo:youtubeSubtitleConfigChanged"));

    await Promise.resolve();
    firstCheck.resolve(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(shouldBlockCurrentSite).toHaveBeenCalledTimes(2);
    expect(youtubeRuntimeMock.createYouTubeSubtitleRuntime).not.toHaveBeenCalled();
    expect(browserMock.addStorageListener).not.toHaveBeenCalled();
  });
});
