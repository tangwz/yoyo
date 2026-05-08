export type UiPreferences = {
  theme: "light";
  uiLanguage: "zh-CN" | "en-US";
};

export type ExperimentalFlags = {
  translateMoreVisibleText: boolean;
};

export const defaultUiPreferences: UiPreferences = {
  theme: "light",
  uiLanguage: "zh-CN",
};

export const defaultExperimentalFlags: ExperimentalFlags = {
  translateMoreVisibleText: false,
};
