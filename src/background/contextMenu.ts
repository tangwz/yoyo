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
): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== translatePageMenuId || tab?.id === undefined) {
      return;
    }

    void handler(tab.id);
  });
}
