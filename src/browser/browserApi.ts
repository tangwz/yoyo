import { browser } from "wxt/browser";
import type { OptionsOpenSource, OptionsSection } from "@/messaging/contracts";

export type ActiveTab = {
  id: number;
  url?: string;
  title?: string;
};

export async function getActiveTab(): Promise<ActiveTab | undefined> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (tab?.id === undefined) {
    return undefined;
  }

  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
  };
}

export type OpenOptionsPageInput = {
  section?: OptionsSection;
  source?: OptionsOpenSource;
};

function isExtensionOptionsUrl(url: string | undefined, extensionOrigin: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.origin === extensionOrigin && parsedUrl.pathname === "/options.html";
  } catch {
    return false;
  }
}

async function openRoutedOptionsPage(url: string): Promise<void> {
  const optionsUrlPattern = browser.runtime.getURL("/options.html*" as never);
  const optionsOrigin = new URL(browser.runtime.getURL("/" as never)).origin;
  const tabs = await browser.tabs.query({
    url: optionsUrlPattern,
  });
  const existingTab = tabs.find((tab) => isExtensionOptionsUrl(tab.url, optionsOrigin));

  if (existingTab?.id === undefined) {
    await browser.tabs.create({ url });
    return;
  }

  await browser.tabs.update(existingTab.id, {
    active: true,
    url,
  });

  if (existingTab.windowId !== undefined) {
    await browser.windows.update(existingTab.windowId, { focused: true });
  }
}

export async function openOptionsPage(input: OpenOptionsPageInput = {}): Promise<void> {
  const params = new URLSearchParams();

  if (input.section) {
    params.set("section", input.section);
  }

  if (input.source) {
    params.set("source", input.source);
  }

  const query = params.toString();

  if (query.length > 0) {
    await openRoutedOptionsPage(browser.runtime.getURL(`/options.html?${query}` as never));
    return;
  }

  await browser.runtime.openOptionsPage();
}

export async function notifyBasic(input: {
  id: string;
  title: string;
  message: string;
}): Promise<void> {
  await browser.notifications.create(input.id, {
    type: "basic",
    iconUrl: browser.runtime.getURL("/icon/128.png" as never),
    title: input.title,
    message: input.message,
  });
}
