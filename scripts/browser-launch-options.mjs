const chromeForTestingPath =
  "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const edgePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

export function normalizeBrowserTarget(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (normalized === "edge" || normalized === "msedge" || normalized === "microsoft-edge") {
    return "edge";
  }

  return "chrome";
}

export function getBrowserExecutableCandidates({ target, envExecutable, homeDir }) {
  const browserTarget = normalizeBrowserTarget(target);
  const chromeForTesting = `${homeDir}/${chromeForTestingPath}`;
  const browserCandidates =
    browserTarget === "edge"
      ? [edgePath, chromePath, chromeForTesting]
      : [chromeForTesting, chromePath, edgePath];

  return [envExecutable, ...browserCandidates].filter(Boolean);
}
