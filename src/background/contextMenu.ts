import { browser } from "wxt/browser";

export const translatePageMenuId = "yoyo.translatePage";

export function registerContextMenus(): void {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: translatePageMenuId,
      title: "Translate this page",
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
