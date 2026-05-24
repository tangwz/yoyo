import type { OptionsUiLanguage } from "@/i18n/optionsMessages";
import { defaultUiPreferences } from "@/storage/defaults";

export type ContextMenuMessageKey =
  | "translatePage"
  | "translateSelection"
  | "summarizePage";

export const contextMenuMessages = {
  "zh-CN": {
    translatePage: "翻译此页面",
    translateSelection: "翻译选中文本",
    summarizePage: "总结此页面",
  },
  "en-US": {
    translatePage: "Translate this page",
    translateSelection: "Translate selection",
    summarizePage: "Summarize this page",
  },
} as const satisfies Record<OptionsUiLanguage, Record<ContextMenuMessageKey, string>>;

export type ContextMenuMessages =
  (typeof contextMenuMessages)[OptionsUiLanguage];

export function getContextMenuMessages(
  uiLanguage: OptionsUiLanguage = defaultUiPreferences.uiLanguage,
): ContextMenuMessages {
  return contextMenuMessages[uiLanguage];
}
