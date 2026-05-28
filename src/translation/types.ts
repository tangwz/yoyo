export type TranslationTaskState =
  | "queued"
  | "collecting"
  | "translating"
  | "waitingForViewport"
  | "completed"
  | "completedWithErrors"
  | "cancelled"
  | "failed";

export type CancelReason =
  | "userCancelled"
  | "tabClosed"
  | "pageReloaded"
  | "superseded";

export type PageSegmentKind = "paragraph" | "heading" | "listItem";
export type SegmentPriority = "viewport" | "nearViewport" | "normal";
export type TranslationMode = "lazyViewport" | "fullPage";
export const supportedTargetLanguages = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
export type TargetLanguage = (typeof supportedTargetLanguages)[number];

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return supportedTargetLanguages.some((language) => language === value);
}

export type PageSegment = {
  id: string;
  order: number;
  sourceText: string;
  kind: PageSegmentKind;
  priority: SegmentPriority;
  pathHint: string;
  textHash: string;
  preserveWhitespace?: boolean;
};

export type TranslationPreferences = {
  mode: TranslationMode;
  targetLanguage: TargetLanguage;
};

export type TranslationResultItem = {
  segmentId: string;
  translatedText: string;
};

export type TranslationBatchResult = {
  items: TranslationResultItem[];
};

export type TranslationCacheKey = {
  normalizedTextHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerId: string;
  textModel: string;
  translationStyle: string;
  promptVersion: string;
};

export type TranslationProgress = {
  taskId: string;
  state: TranslationTaskState;
  total: number;
  translated: number;
  failed: number;
  errorMessage?: string;
};

export const terminalStates: ReadonlySet<TranslationTaskState> = new Set([
  "completed",
  "completedWithErrors",
  "cancelled",
  "failed",
]);

export function isTerminalTaskState(state: TranslationTaskState): boolean {
  return terminalStates.has(state);
}
