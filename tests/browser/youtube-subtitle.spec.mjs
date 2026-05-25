import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { startYouTubeSubtitleFixtureServer } from "./youtube-subtitle-fixture.mjs";

const extensionPath = resolve("build/chrome-mv3");
const subtitleButtonSelector = "[data-yoyo-youtube-subtitle-button]";
const subtitleBadgeSelector = "[data-yoyo-youtube-subtitle-badge]";
const subtitleOverlaySelector = "[data-yoyo-youtube-subtitle-overlay]";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function findChromeExecutable() {
  const candidates = [
    process.env.YOYO_CHROME_EXECUTABLE,
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForCondition(predicate, message, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(intervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${message} Last error: ${lastError.message}`);
  }
  throw new Error(message);
}

async function getExtensionServiceWorker(context) {
  let serviceWorker = context.serviceWorkers().find((worker) =>
    worker.url().endsWith("/background.js"),
  );
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url().endsWith("/background.js"),
      timeout: 10000,
    });
  }

  return serviceWorker;
}

async function configureSubtitleProvider(serviceWorker, providerBaseUrl) {
  await serviceWorker.evaluate(async (baseUrl) => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.local.set({
      "yoyo.providerProfiles": [
        {
          id: "fixture-provider",
          displayName: "Fixture Provider",
          type: "openai-compatible",
          baseURL: baseUrl,
          apiKey: "fixture-key",
          textModel: "fixture-model",
        },
      ],
      "yoyo.activeProviderId": "fixture-provider",
    });
    await chrome.storage.sync.set({
      "yoyo.translationPreferences": {
        mode: "lazyViewport",
        targetLanguage: "zh-CN",
      },
      "yoyo.subtitlePreferences": {
        schemaVersion: 1,
        youtubeEnabled: true,
        aiSegmentationEnabled: false,
        prefetchBeforeMs: 2000,
        prefetchAfterMs: 90000,
        maxRetryCount: 2,
      },
    });
  }, providerBaseUrl);
}

async function updateSubtitleTargetLanguage(serviceWorker, targetLanguage) {
  await serviceWorker.evaluate(async (language) => {
    const result = await chrome.storage.sync.get("yoyo.translationPreferences");
    await chrome.storage.sync.set({
      "yoyo.translationPreferences": {
        mode: result["yoyo.translationPreferences"]?.mode ?? "lazyViewport",
        targetLanguage: language,
      },
    });
  }, targetLanguage);
}

async function waitForBadgeStatus(page, expectedStatuses, message) {
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  await page.waitForFunction(
    ({ badgeSelector, acceptedStatuses }) => {
      const badge = document.querySelector(badgeSelector);
      return badge instanceof HTMLElement && acceptedStatuses.includes(badge.dataset.status);
    },
    {
      badgeSelector: subtitleBadgeSelector,
      acceptedStatuses: statuses,
    },
    { timeout: 5000 },
  );

  const status = await page.locator(subtitleBadgeSelector).getAttribute("data-status");
  assert(statuses.includes(status), `${message} Current status: ${status ?? "<missing>"}.`);
  return status;
}

async function waitForTranslatedOverlay(page, sourceText, translatedText) {
  await page.waitForFunction(
    ({ overlaySelector, source, translation }) => {
      const overlay = document.querySelector(overlaySelector);
      const text = overlay?.textContent ?? "";
      return !overlay?.hasAttribute("hidden") && text.includes(source) && text.includes(translation);
    },
    {
      overlaySelector: subtitleOverlaySelector,
      source: sourceText,
      translation: translatedText,
    },
    { timeout: 10000 },
  );
}

async function assertOverlayContract(page, expectedHidden = false) {
  const overlay = page.locator(subtitleOverlaySelector);
  await overlay.waitFor({ state: "attached", timeout: 5000 });

  const overlayState = await overlay.evaluate((element) => ({
    hidden: element.hasAttribute("hidden"),
    translate: element.getAttribute("translate"),
    className: element.className,
    pointerEvents: getComputedStyle(element).pointerEvents,
  }));

  assert(
    overlayState.hidden === expectedHidden,
    `Subtitle overlay hidden state mismatch. Expected ${expectedHidden}, got ${overlayState.hidden}.`,
  );
  assert(overlayState.translate === "no", "Subtitle overlay must opt out of translation.");
  assert(
    overlayState.className.split(/\s+/).includes("notranslate"),
    `Subtitle overlay must include notranslate class. Classes: ${overlayState.className}`,
  );
  assert(
    overlayState.pointerEvents === "none",
    `Subtitle overlay must not intercept player input. pointer-events: ${overlayState.pointerEvents}`,
  );
}

async function run() {
  assert(existsSync(extensionPath), "Missing build/chrome-mv3. Run pnpm build first.");

  const [fixtureServer, userDataDir] = await Promise.all([
    startYouTubeSubtitleFixtureServer(),
    mkdtemp(join(tmpdir(), "yoyo-youtube-subtitle-browser-")),
  ]);

  let context;
  try {
    const executablePath = findChromeExecutable();
    const launchOptions = executablePath
      ? { executablePath }
      : { channel: process.env.YOYO_CHROME_CHANNEL ?? "chrome" };

    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      headless: false,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const serviceWorker = await getExtensionServiceWorker(context);
    await configureSubtitleProvider(serviceWorker, fixtureServer.providerBaseUrl);

    const page = await context.newPage();
    await page.goto(fixtureServer.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (selector) => document.querySelector(selector) !== null,
      subtitleButtonSelector,
      { timeout: 10000 },
    );

    const buttonCount = await page.locator(subtitleButtonSelector).count();
    assert(buttonCount === 1, `Expected exactly one subtitle button, got ${buttonCount}.`);

    await waitForBadgeStatus(page, "enabled", "Subtitle button should start enabled.");
    await waitForTranslatedOverlay(
      page,
      "Hello from the fixture.",
      "[translated Hello from the fixture.]",
    );
    await assertOverlayContract(page);
    assert(
      fixtureServer.getTimedTextRequestCount() > 0,
      "Subtitle runtime did not request the timed text payload.",
    );
    assert(
      fixtureServer.getProviderRequestCount() > 0,
      "Subtitle runtime did not send a provider translation request.",
    );
    assert(
      fixtureServer
        .getLastProviderRequest()
        ?.prompt.includes("Hello from the fixture."),
      "Subtitle provider request did not include source subtitle text.",
    );

    await page.locator(subtitleButtonSelector).click();
    await waitForBadgeStatus(page, "disabled", "Subtitle button should switch to disabled.");
    await page.locator(subtitleOverlaySelector).waitFor({ state: "detached", timeout: 5000 });
    const disabledProviderRequestCount = fixtureServer.getProviderRequestCount();
    await delay(300);
    assert(
      fixtureServer.getProviderRequestCount() === disabledProviderRequestCount,
      "Subtitle runtime sent provider requests while globally disabled.",
    );

    await page.locator(subtitleButtonSelector).click();
    await waitForBadgeStatus(
      page,
      ["enabled", "loading"],
      "Subtitle button should switch back to enabled or loading.",
    );
    await waitForTranslatedOverlay(
      page,
      "Hello from the fixture.",
      "[translated Hello from the fixture.]",
    );
    await assertOverlayContract(page);

    const beforeNavigationTimedTextCount = fixtureServer.getTimedTextRequestCount();
    const beforeNavigationProviderCount = fixtureServer.getProviderRequestCount();
    await page.evaluate(() => {
      window.history.pushState({}, "", "/watch?v=fixture-next&yoyoSubtitleFixture=1");
      document.body.append(document.createElement("span"));
    });
    await waitForCondition(
      () =>
        fixtureServer.getTimedTextRequestCount() > beforeNavigationTimedTextCount &&
        fixtureServer.getProviderRequestCount() > beforeNavigationProviderCount,
      "Subtitle runtime did not restart after a YouTube SPA video change.",
    );
    await waitForBadgeStatus(page, "enabled", "Subtitle button should recover after SPA navigation.");
    await waitForTranslatedOverlay(
      page,
      "Hello from the fixture.",
      "[translated Hello from the fixture.]",
    );

    const beforeLanguageChangeProviderCount = fixtureServer.getProviderRequestCount();
    await updateSubtitleTargetLanguage(serviceWorker, "ja");
    await waitForCondition(
      () => fixtureServer.getProviderRequestCount() > beforeLanguageChangeProviderCount,
      "Subtitle runtime did not restart after target language changed.",
    );
    assert(
      fixtureServer.getLastProviderRequest()?.prompt.includes("Target language: ja"),
      "Subtitle provider request did not use the updated target language.",
    );

    await waitForTranslatedOverlay(
      page,
      "Hello from the fixture.",
      "[translated Hello from the fixture.]",
    );
  } finally {
    await context?.close().catch(() => undefined);
    await fixtureServer.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await run();
