import type { TranslationPreferences } from "@/translation/types";

export {
  defaultSubtitlePreferences,
  type SubtitlePreferences,
} from "@/subtitle/types";

export type UiPreferences = {
  theme: "light";
  uiLanguage: "zh-CN" | "en-US";
};

export type ExperimentalFlags = {
  translateMoreVisibleText: boolean;
};

export type SelectionTranslationPreferences = {
  providerId?: string;
};

export const defaultUiPreferences: UiPreferences = {
  theme: "light",
  uiLanguage: "zh-CN",
};

export function isUiLanguage(value: unknown): value is UiPreferences["uiLanguage"] {
  return value === "zh-CN" || value === "en-US";
}

export const defaultExperimentalFlags: ExperimentalFlags = {
  translateMoreVisibleText: false,
};

export const defaultSelectionTranslationPreferences: SelectionTranslationPreferences = {};

export const defaultTranslationPreferences: TranslationPreferences = {
  mode: "lazyViewport",
  targetLanguage: "zh-CN",
};
