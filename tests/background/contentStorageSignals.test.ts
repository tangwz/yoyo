import { describe, expect, it } from "vitest";
import { buildContentStorageChangeMessages } from "@/background/contentStorageSignals";
import { storageKeys } from "@/storage/storageKeys";

describe("content storage change signals", () => {
  it("broadcasts site rule changes without forwarding storage payloads", () => {
    expect(
      buildContentStorageChangeMessages(
        {
          [storageKeys.siteRules]: {
            newValue: {
              blacklist: ["example.com"],
              autoTranslateAllowlist: [],
            },
          },
        },
        "local",
      ),
    ).toEqual([
      { type: "siteRulesChanged" },
      { type: "youtubeSubtitleConfigChanged" },
    ]);
  });

  it("broadcasts provider config changes as payload-free subtitle config signals", () => {
    expect(
      buildContentStorageChangeMessages(
        {
          [storageKeys.providerProfiles]: {
            newValue: [{ id: "provider-1", apiKey: "secret" }],
          },
        },
        "local",
      ),
    ).toEqual([{ type: "youtubeSubtitleConfigChanged" }]);
  });

  it("ignores unrelated sync changes", () => {
    expect(
      buildContentStorageChangeMessages({ [storageKeys.uiPreferences]: {} }, "sync"),
    ).toEqual([]);
  });
});
