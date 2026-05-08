export type TranslationTaskState =
  | "queued"
  | "collecting"
  | "translating"
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

export type PageSegment = {
  id: string;
  order: number;
  sourceText: string;
  kind: PageSegmentKind;
  pathHint: string;
  textHash: string;
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

export const terminalStates = new Set<TranslationTaskState>([
  "completed",
  "completedWithErrors",
  "cancelled",
  "failed",
]);

export function isTerminalTaskState(state: TranslationTaskState): boolean {
  return terminalStates.has(state);
}
