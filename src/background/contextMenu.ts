import { browser } from "wxt/browser";
import { getContextMenuMessages } from "@/i18n/contextMenuMessages";
import {
  isOptionsUiLanguage,
  type OptionsUiLanguage,
} from "@/i18n/optionsMessages";
import { defaultUiPreferences } from "@/storage/defaults";

export const translatePageMenuId = "yoyo.translatePage";
export const translateSelectionMenuId = "yoyo.translateSelection";
export const summarizePageMenuId = "yoyo.summarizePage";

export type TranslateSelectionMenuClick = {
  tabId: number;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getContextMenuUiLanguageForPreferenceChange(
  value: unknown,
): OptionsUiLanguage {
  if (!isRecord(value)) {
    return defaultUiPreferences.uiLanguage;
  }

  return isOptionsUiLanguage(value.uiLanguage)
    ? value.uiLanguage
    : defaultUiPreferences.uiLanguage;
}

export function registerContextMenus(uiLanguage?: OptionsUiLanguage): void {
  const messages = getContextMenuMessages(uiLanguage);

  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: translatePageMenuId,
      title: messages.translatePage,
      contexts: ["page"],
    });
    browser.contextMenus.create({
      id: translateSelectionMenuId,
      title: messages.translateSelection,
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: summarizePageMenuId,
      title: messages.summarizePage,
      contexts: ["page"],
    });
  });
}

export function onTranslatePageMenuClick(
  handler: (tabId: number) => Promise<void>,
  onError: (error: unknown, tabId: number) => void = (error, tabId) => {
    console.error("[yoyo] failed to handle translate page menu click", {
      tabId,
      error,
    });
  },
): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== translatePageMenuId || tab?.id === undefined) {
      return;
    }

    const tabId = tab.id;

    void handler(tabId).catch((error: unknown) => {
      onError(error, tabId);
    });
  });
}

export function onTranslateSelectionMenuClick(
  handler: (input: TranslateSelectionMenuClick) => Promise<void>,
  onError: (
    error: unknown,
    input: TranslateSelectionMenuClick,
  ) => void = (error, input) => {
    console.error("[yoyo] failed to handle translate selection menu click", {
      tabId: input.tabId,
      error,
    });
  },
): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const text = info.selectionText?.trim();
    if (
      info.menuItemId !== translateSelectionMenuId ||
      tab?.id === undefined ||
      !text
    ) {
      return;
    }

    const input = { tabId: tab.id, text };

    void handler(input).catch((error: unknown) => {
      onError(error, input);
    });
  });
}

export function onSummarizePageMenuClick(
  handler: (tabId: number) => Promise<void>,
  onError: (error: unknown, tabId: number) => void = (error, tabId) => {
    console.error("[yoyo] failed to handle summarize page menu click", {
      tabId,
      error,
    });
  },
): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== summarizePageMenuId || tab?.id === undefined) {
      return;
    }

    const tabId = tab.id;

    void handler(tabId).catch((error: unknown) => {
      onError(error, tabId);
    });
  });
}
