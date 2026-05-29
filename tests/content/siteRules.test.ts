import { describe, expect, it } from "vitest";

import { getSiteRuleBlockReason, isUrlBlockedBySiteRules } from "@/content/siteRules";

describe("content site rules", () => {
  it("blocks host and wildcard blacklist entries", () => {
    const rules = {
      blacklist: ["example.com", "*.internal.test"],
      autoTranslateAllowlist: [],
    };

    expect(isUrlBlockedBySiteRules("https://example.com/article", rules)).toBe(true);
    expect(isUrlBlockedBySiteRules("https://docs.internal.test/page", rules)).toBe(true);
    expect(isUrlBlockedBySiteRules("https://internal.test/page", rules)).toBe(false);
    expect(isUrlBlockedBySiteRules("https://other.example.net/page", rules)).toBe(false);
  });

  it("blocks exact URL prefixes without treating them as unrelated hosts", () => {
    const rules = {
      blacklist: ["https://news.example.com/private"],
      autoTranslateAllowlist: [],
    };

    expect(
      isUrlBlockedBySiteRules("https://news.example.com/private/story", rules),
    ).toBe(true);
    expect(isUrlBlockedBySiteRules("https://news.example.com/public/story", rules)).toBe(
      false,
    );
  });

  it("returns a readable block reason", () => {
    expect(getSiteRuleBlockReason()).toBe(
      "This site is disabled in Yoyo site blacklist.",
    );
  });
});
