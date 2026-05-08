import { registerContextMenus } from "@/background/contextMenu";

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });

  console.info("[yoyo] background ready");
});
