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

async function assertOverlayContract(page) {
  const overlay = page.locator(subtitleOverlaySelector);
  // Task 8 verifies the attached overlay contract. The current runtime mounts
  // the overlay before subtitle rendering makes it visible.
  await overlay.waitFor({ state: "attached", timeout: 5000 });

  const overlayState = await overlay.evaluate((element) => ({
    translate: element.getAttribute("translate"),
    className: element.className,
    pointerEvents: getComputedStyle(element).pointerEvents,
  }));

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

    const page = await context.newPage();
    await page.goto(fixtureServer.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(subtitleButtonSelector, { timeout: 10000 });

    const buttonCount = await page.locator(subtitleButtonSelector).count();
    assert(buttonCount === 1, `Expected exactly one subtitle button, got ${buttonCount}.`);

    await waitForBadgeStatus(page, "enabled", "Subtitle button should start enabled.");
    await assertOverlayContract(page);

    await page.locator(subtitleButtonSelector).click();
    await waitForBadgeStatus(page, "disabled", "Subtitle button should switch to disabled.");

    await page.locator(subtitleButtonSelector).click();
    await waitForBadgeStatus(
      page,
      ["enabled", "loading"],
      "Subtitle button should switch back to enabled or loading.",
    );
    await assertOverlayContract(page);
  } finally {
    await context?.close().catch(() => undefined);
    await fixtureServer.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await run();
