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

async function openRoutedOptionsPage(url: string): Promise<void> {
  const [existingTab] = await browser.tabs.query({
    url: browser.runtime.getURL("/options.html*" as never),
  });

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

  if (params.size > 0) {
    await openRoutedOptionsPage(
      browser.runtime.getURL(`/options.html?${params.toString()}` as never),
    );
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
