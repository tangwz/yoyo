import { describe, expect, it } from "vitest";
import {
  verifyContentScriptPrivacyBoundary,
  verifyNotificationPermissionReachability,
  verifyPackagedNotificationPermissionReachability,
  verifyProviderTestPrivacy,
  verifyRuntimePackageEntries,
  verifySourceMapPolicy,
} from "../../scripts/verify-release-package.mjs";
import {
  createValidManifest,
  packagedTextByEntry,
  providerTestSourceFiles,
  reachableNotificationSourceFiles,
  validZipEntries,
} from "./fixtures/releasePackageFixtures.mjs";

describe("release package verification", () => {
  it("blocks source maps unless the release policy explicitly allows them", () => {
    expect(() =>
      verifySourceMapPolicy([...validZipEntries, "background.js.map"], "release.zip"),
    ).toThrow('release.zip contains source map artifacts: background.js.map');

    expect(() =>
      verifySourceMapPolicy([...validZipEntries, "background.js.map"], "release.zip", {
        allowSourceMaps: true,
      }),
    ).not.toThrow();
  });

  it("blocks source map references embedded in packaged text assets", () => {
    expect(() =>
      verifySourceMapPolicy(validZipEntries, "release.zip", {
        packagedTextByEntry: new Map([["background.js", "//# sourceMappingURL=background.js.map"]]),
      }),
    ).toThrow("release.zip contains source map artifacts: background.js");
  });

  it("blocks packaged runtime entries and icons missing from manifest paths", () => {
    const entriesWithoutIcon = validZipEntries.filter((entry) => entry !== "icon/128.png");

    expect(() =>
      verifyRuntimePackageEntries(createValidManifest(), entriesWithoutIcon, "release.zip"),
    ).toThrow('release.zip is missing manifest icon "icon/128.png".');
  });

  it("requires the beta manifest to declare all key runtime entries and a 128 icon", () => {
    expect(() =>
      verifyRuntimePackageEntries(
        createValidManifest({ background: undefined }),
        validZipEntries,
        "release.zip",
      ),
    ).toThrow("release.zip manifest must declare a background service worker.");

    expect(() =>
      verifyRuntimePackageEntries(
        createValidManifest({ icons: { 48: "icon/48.png" } }),
        validZipEntries,
        "release.zip",
      ),
    ).toThrow("release.zip manifest must declare icons.128.");
  });

  it("accepts the minimal beta runtime package fixture", () => {
    expect(() =>
      verifyRuntimePackageEntries(createValidManifest(), validZipEntries, "release.zip"),
    ).not.toThrow();
  });

  it("requires notifications permission to have a reachable context-menu failure notification path", () => {
    const sourceFilesWithoutNotificationApi = new Map(reachableNotificationSourceFiles);
    sourceFilesWithoutNotificationApi.set(
      "src/browser/browserApi.ts",
      "export async function notifyBasic() {}",
    );

    expect(() =>
      verifyNotificationPermissionReachability(
        createValidManifest(),
        sourceFilesWithoutNotificationApi,
      ),
    ).toThrow(
      "manifest.permissions includes \"notifications\" but no browser.notifications.create call was found.",
    );
  });

  it("allows notifications permission when the context-menu failure notification path is present", () => {
    expect(() =>
      verifyNotificationPermissionReachability(
        createValidManifest(),
        reachableNotificationSourceFiles,
      ),
    ).not.toThrow();
  });

  it("blocks private provider data markers in packaged content scripts", () => {
    expect(() =>
      verifyContentScriptPrivacyBoundary(
        createValidManifest(),
        new Map([["content-scripts/content.js", "const apiKey = 'secret';"]]),
        "release.zip",
      ),
    ).toThrow(
      'release.zip content script "content-scripts/content.js" contains private-provider marker "apiKey".',
    );

    expect(() =>
      verifyContentScriptPrivacyBoundary(createValidManifest(), packagedTextByEntry, "release.zip"),
    ).not.toThrow();
  });

  it("normalizes packaged text entry keys before content script privacy checks", () => {
    expect(() =>
      verifyContentScriptPrivacyBoundary(
        createValidManifest(),
        new Map([["./content-scripts/content.js", "browser.runtime.sendMessage({ type: 'extractPage' });"]]),
        "release.zip",
      ),
    ).not.toThrow();
  });

  it("checks notification permission reachability against the packaged manifest and code", () => {
    expect(() =>
      verifyPackagedNotificationPermissionReachability(
        createValidManifest({ permissions: ["storage", "contextMenus"] }),
        new Map([["background.js", "browser.notifications.create('id', {});"]]),
      ),
    ).toThrow(
      'browser.notifications.create is present but manifest.permissions does not include "notifications".',
    );

    expect(() =>
      verifyPackagedNotificationPermissionReachability(
        createValidManifest(),
        new Map([["background.js", "t.notifications.create('id', {});"]]),
      ),
    ).not.toThrow();
  });

  it("requires provider connection tests to use only the fixed smoke-test prompt", () => {
    const sourceFilesReadingPageText = new Map(providerTestSourceFiles);
    sourceFilesReadingPageText.set(
      "src/provider/openAiCompatible.ts",
      `
export class OpenAiCompatibleProvider {
  async testConnection(profile, sourceText) {
    return this.generateText({ profile, prompt: sourceText });
  }

  async generateText(request) {
    return request;
  }
}
`,
    );

    expect(() => verifyProviderTestPrivacy(sourceFilesReadingPageText)).toThrow(
      "Provider connection test must send only the fixed smoke-test prompt.",
    );

    expect(() => verifyProviderTestPrivacy(providerTestSourceFiles)).not.toThrow();
  });
});
