export function createValidManifest(overrides = {}) {
  return {
    manifest_version: 3,
    name: "Yoyo",
    description: "A privacy-conscious LLM reading and translation assistant.",
    version: "0.3.0",
    icons: {
      128: "icon/128.png",
    },
    permissions: ["storage", "contextMenus", "notifications"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Yoyo",
      default_popup: "popup.html",
    },
    background: {
      service_worker: "background.js",
    },
    options_ui: {
      open_in_tab: true,
      page: "options.html",
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content-scripts/content.js"],
      },
    ],
    ...overrides,
  };
}

export const validZipEntries = [
  "background.js",
  "manifest.json",
  "options.html",
  "popup.html",
  "content-scripts/",
  "content-scripts/content.js",
  "icon/",
  "icon/128.png",
];

export const reachableNotificationSourceFiles = new Map([
  [
    "entrypoints/background.ts",
    `
import { onTranslatePageMenuClick } from "@/background/contextMenu";
import { notifyPageCannotTranslate, notifyProviderMissing } from "@/background/notifications";

onTranslatePageMenuClick(async () => {
  await notifyProviderMissing();
}, (error) => {
  void notifyPageCannotTranslate(error instanceof Error ? error.message : "Failed.");
});
`,
  ],
  [
    "src/background/contextMenu.ts",
    `
export function registerContextMenus(): void {
  browser.contextMenus.create({ id: "yoyo.translatePage", contexts: ["page"] });
}

export function onTranslatePageMenuClick(handler) {
  browser.contextMenus.onClicked.addListener(() => void handler());
}
`,
  ],
  [
    "src/background/notifications.ts",
    `
import { notifyBasic } from "@/browser/browserApi";

export async function notifyProviderMissing(): Promise<void> {
  await notifyBasic({ id: "provider", title: "Provider", message: "Missing" });
}

export async function notifyPageCannotTranslate(message: string): Promise<void> {
  await notifyBasic({ id: "page", title: "Page", message });
}
`,
  ],
  [
    "src/browser/browserApi.ts",
    `
export async function notifyBasic(input) {
  await browser.notifications.create(input.id, {
    type: "basic",
    iconUrl: browser.runtime.getURL("/icon/128.png"),
    title: input.title,
    message: input.message,
  });
}
`,
  ],
]);

export const providerTestSourceFiles = new Map([
  [
    "src/provider/openAiCompatible.ts",
    `
export class OpenAiCompatibleProvider {
  async testConnection(profile) {
    return this.generateText({
      profile,
      prompt: "Reply with exactly: ok",
    });
  }

  async generateText(request) {
    return request;
  }
}
`,
  ],
]);

export const packagedTextByEntry = new Map([
  ["background.js", "browser.notifications.create('id', {});"],
  ["content-scripts/content.js", "browser.runtime.sendMessage({ type: 'extractPage' });"],
]);
