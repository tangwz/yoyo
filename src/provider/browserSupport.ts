export const minimumChromeBuiltInAiVersion = 138;

export type ChromeBuiltInAiBrowserSupportReason =
  | "supported"
  | "browserUnsupported"
  | "chromeVersionTooOld"
  | "unknownChromeVersion";

export type ChromeBuiltInAiBrowserSupport = {
  supported: boolean;
  reason: ChromeBuiltInAiBrowserSupportReason;
  minimumChromeVersion: number;
  detectedChromeVersion?: number;
};

function isUnsupportedBrowserOrMobile(userAgent: string): boolean {
  return /\b(?:Edg|OPR|Firefox|Android|CriOS|FxiOS|Mobile)\b/i.test(userAgent);
}

export function parseChromeMajorVersion(userAgent: string): number | undefined {
  if (isUnsupportedBrowserOrMobile(userAgent)) {
    return undefined;
  }

  const match = /\bChrome\/(\d+)/.exec(userAgent);
  if (!match?.[1]) {
    return undefined;
  }

  const version = Number.parseInt(match[1], 10);
  return Number.isFinite(version) ? version : undefined;
}

export function getChromeBuiltInAiBrowserSupport(
  input: { userAgent?: string } = {},
): ChromeBuiltInAiBrowserSupport {
  const userAgent = input.userAgent ?? globalThis.navigator?.userAgent ?? "";
  const detectedChromeVersion = parseChromeMajorVersion(userAgent);

  if (isUnsupportedBrowserOrMobile(userAgent) || !/\bChrome\//.test(userAgent)) {
    return {
      supported: false,
      reason: "browserUnsupported",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
      detectedChromeVersion,
    };
  }

  if (detectedChromeVersion === undefined) {
    return {
      supported: false,
      reason: "unknownChromeVersion",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
    };
  }

  if (detectedChromeVersion < minimumChromeBuiltInAiVersion) {
    return {
      supported: false,
      reason: "chromeVersionTooOld",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
      detectedChromeVersion,
    };
  }

  return {
    supported: true,
    reason: "supported",
    minimumChromeVersion: minimumChromeBuiltInAiVersion,
    detectedChromeVersion,
  };
}
