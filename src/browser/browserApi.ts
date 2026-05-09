import { browser } from "wxt/browser";

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

export async function openOptionsPage(): Promise<void> {
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
