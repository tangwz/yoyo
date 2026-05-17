import { describe, expect, it } from "vitest";
import {
  getChromeBuiltInAiBrowserSupport,
  parseChromeMajorVersion,
} from "@/provider/browserSupport";

describe("browser support", () => {
  it("parses Chrome major versions", () => {
    expect(parseChromeMajorVersion("Mozilla/5.0 Chrome/138.0.7204.0 Safari/537.36")).toBe(138);
    expect(parseChromeMajorVersion("Mozilla/5.0 Edg/138.0.0.0 Safari/537.36")).toBeUndefined();
    expect(parseChromeMajorVersion("Mozilla/5.0 Firefox/126.0")).toBeUndefined();
  });

  it("allows desktop Chrome 138 or later", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/138.0.7204.0 Safari/537.36",
        runtimeFeatureScope: {
          LanguageDetector: {},
          Translator: {},
        },
      }),
    ).toEqual({
      supported: true,
      reason: "supported",
      minimumChromeVersion: 138,
      detectedChromeVersion: 138,
    });
  });

  it("rejects Chrome when the Built-in AI runtime APIs are unavailable", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/138.0.7204.0 Safari/537.36",
        runtimeFeatureScope: {
          LanguageDetector: {},
        },
      }),
    ).toMatchObject({
      supported: false,
      reason: "apiUnavailable",
      detectedChromeVersion: 138,
    });
  });

  it("rejects Chrome versions below 138", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/137.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({
      supported: false,
      reason: "chromeVersionTooOld",
      detectedChromeVersion: 137,
    });
  });

  it("rejects Edge and Firefox", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Edg/138.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 Firefox/126.0",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
  });

  it("rejects mobile Chrome even when the version is 138 or later", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.0 Mobile Safari/537.36",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
  });

  it("rejects iOS Chrome as unsupported", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.0 Mobile/15E148 Safari/604.1",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
  });

  it("reports unknown version for malformed desktop Chrome user agents", () => {
    expect(parseChromeMajorVersion("Mozilla/5.0 (Macintosh) Chrome/ Safari/537.36")).toBeUndefined();
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/ Safari/537.36",
      }),
    ).toMatchObject({
      supported: false,
      reason: "unknownChromeVersion",
    });
  });
});
