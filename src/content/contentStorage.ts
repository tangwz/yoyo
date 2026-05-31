import { browser } from "wxt/browser";
import { defaultSiteRules, type SiteRules } from "@/storage/defaults";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";

export const contentStorageKeys = {
  siteRules: "yoyo.siteRules",
  subtitlePreferences: "yoyo.subtitlePreferences",
  translationPreferences: "yoyo.translationPreferences",
} as const;

type ContentStorageAreaName = "local" | "sync";

type ContentStorageArea = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

function getStorageArea(areaName: ContentStorageAreaName): ContentStorageArea {
  return browser.storage[areaName] as ContentStorageArea;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePatternList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value.flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }

    const pattern = item.trim();
    return pattern ? [pattern] : [];
  });

  return [...new Set(normalized)];
}

function normalizeContentSiteRules(value: unknown): SiteRules {
  if (!isRecord(value)) {
    return defaultSiteRules;
  }

  return {
    blacklist: normalizePatternList(value.blacklist),
    autoTranslateAllowlist: normalizePatternList(value.autoTranslateAllowlist),
  };
}

export function createContentStorageRepositories() {
  return {
    siteRules: {
      async get(): Promise<SiteRules> {
        const result = await getStorageArea("local").get({
          [contentStorageKeys.siteRules]: defaultSiteRules,
        });
        return normalizeContentSiteRules(result[contentStorageKeys.siteRules]);
      },
    },
    subtitlePreferences: {
      async get(): Promise<SubtitlePreferences> {
        const result = await getStorageArea("sync").get({
          [contentStorageKeys.subtitlePreferences]: defaultSubtitlePreferences,
        });
        return normalizeSubtitlePreferences(
          result[contentStorageKeys.subtitlePreferences],
        );
      },
      async save(preferences: SubtitlePreferences): Promise<void> {
        await getStorageArea("sync").set({
          [contentStorageKeys.subtitlePreferences]:
            normalizeSubtitlePreferences(preferences),
        });
      },
    },
  };
}
