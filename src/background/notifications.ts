import { notifyBasic } from "@/browser/browserApi";

let notificationSequence = 0;

function nextNotificationId(prefix: string): string {
  notificationSequence = (notificationSequence + 1) % Number.MAX_SAFE_INTEGER;

  return `${prefix}-${Date.now()}-${notificationSequence}`;
}

export async function notifyPageCannotTranslate(message: string): Promise<void> {
  await notifyBasic({
    id: nextNotificationId("yoyo-page-error"),
    title: "悠悠阅读助手",
    message,
  });
}

export async function notifyProviderMissing(): Promise<void> {
  await notifyBasic({
    id: nextNotificationId("yoyo-provider-missing"),
    title: "请先配置翻译服务",
    message: "打开设置页，添加 OpenAI-compatible provider 后再翻译当前页面。",
  });
}
