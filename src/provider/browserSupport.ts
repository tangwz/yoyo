export const minimumChromeBuiltInAiVersion = 138;

export type ChromeBuiltInAiBrowserSupportReason =
  | "supported"
  | "browserUnsupported"
  | "chromeVersionTooOld"
  | "unknownChromeVersion"
  | "apiUnavailable";

export type ChromeBuiltInAiRuntimeFeatureScope = {
  LanguageDetector?: unknown;
  Translator?: unknown;
  document?: unknown;
};

export type ChromeBuiltInAiBrowserSupport = {
  supported: boolean;
  reason: ChromeBuiltInAiBrowserSupportReason;
  minimumChromeVersion: number;
  detectedChromeVersion?: number;
};

export type ChromeBuiltInAiBrowserSupportInput = {
  userAgent?: string;
  runtimeFeatureScope?: ChromeBuiltInAiRuntimeFeatureScope;
  requireRuntimeFeatures?: boolean;
};

function isUnsupportedBrowserOrMobile(userAgent: string): boolean {
  return /\b(?:Edg|OPR|Firefox|Android|CriOS|FxiOS|Mobile)\b/i.test(userAgent);
}

function hasChromeBuiltInAiRuntimeFeatures(
  scope: ChromeBuiltInAiRuntimeFeatureScope,
): boolean {
  return (
    "Translator" in scope &&
    scope.Translator !== undefined &&
    "LanguageDetector" in scope &&
    scope.LanguageDetector !== undefined
  );
}

function shouldRequireRuntimeFeatures(
  input: ChromeBuiltInAiBrowserSupportInput,
  scope: ChromeBuiltInAiRuntimeFeatureScope,
): boolean {
  if (input.requireRuntimeFeatures !== undefined) {
    return input.requireRuntimeFeatures;
  }

  if (input.runtimeFeatureScope) {
    return true;
  }

  return scope.document !== undefined;
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
  input: ChromeBuiltInAiBrowserSupportInput = {},
): ChromeBuiltInAiBrowserSupport {
  const userAgent = input.userAgent ?? globalThis.navigator?.userAgent ?? "";
  const runtimeFeatureScope = input.runtimeFeatureScope ?? globalThis;
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

  if (
    shouldRequireRuntimeFeatures(input, runtimeFeatureScope) &&
    !hasChromeBuiltInAiRuntimeFeatures(runtimeFeatureScope)
  ) {
    return {
      supported: false,
      reason: "apiUnavailable",
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
