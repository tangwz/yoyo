import type { ContentRequest } from "@/messaging/contracts";
import { storageKeys } from "@/storage/storageKeys";

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export function buildContentStorageChangeMessages(
  changes: StorageChanges,
  areaName: string,
): ContentRequest[] {
  if (areaName === "local") {
    const messages: ContentRequest[] = [];

    if (storageKeys.siteRules in changes) {
      messages.push({ type: "siteRulesChanged" });
    }

    if (
      storageKeys.siteRules in changes ||
      storageKeys.providerProfiles in changes ||
      storageKeys.activeProviderId in changes
    ) {
      messages.push({ type: "youtubeSubtitleConfigChanged" });
    }

    return messages;
  }

  if (areaName !== "sync") {
    return [];
  }

  return storageKeys.translationPreferences in changes ||
    storageKeys.subtitlePreferences in changes
    ? [{ type: "youtubeSubtitleConfigChanged" }]
    : [];
}
