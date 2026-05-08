import { notifyBasic } from "@/browser/browserApi";

export async function notifyPageCannotTranslate(message: string): Promise<void> {
  await notifyBasic({
    id: `yoyo-page-error-${Date.now()}`,
    title: "悠悠阅读助手",
    message,
  });
}

export async function notifyProviderMissing(): Promise<void> {
  await notifyBasic({
    id: `yoyo-provider-missing-${Date.now()}`,
    title: "请先配置翻译服务",
    message: "打开设置页，添加 OpenAI-compatible provider 后再翻译当前页面。",
  });
}
