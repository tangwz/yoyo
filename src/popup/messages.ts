import type { UiPreferences } from "@/storage/defaults";

export type PopupUiLanguage = UiPreferences["uiLanguage"];

export const popupMessages = {
  "zh-CN": {
    "button.summarizePage": "一键总结",
    "button.summarizingPage": "总结中...",
  },
  "en-US": {
    "button.summarizePage": "Summarize",
    "button.summarizingPage": "Summarizing...",
  },
} as const satisfies Record<PopupUiLanguage, Record<string, string>>;

export type PopupMessageKey = keyof (typeof popupMessages)["zh-CN"];
