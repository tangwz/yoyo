export type LanguageOption = {
  value: string;
  label: string;
};

export const sourceLanguageOptions: LanguageOption[] = [
  { value: "auto", label: "自动检测" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh-CN", label: "简体中文" },
];

export const targetLanguageOptions: LanguageOption[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];
