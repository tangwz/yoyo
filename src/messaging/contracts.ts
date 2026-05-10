import type {
  CancelReason,
  PageSegment,
  TranslationProgress,
  TranslationResultItem,
} from "@/translation/types";

export type PageTranslationEstimate = {
  canTranslate: boolean;
  estimatedSegments: number;
  estimatedChars: number;
  reason?: string;
};

export type ContentRequest =
  | { type: "estimatePage" }
  | { type: "collectSegments"; taskId: string }
  | { type: "applyTranslations"; taskId: string; items: TranslationResultItem[] }
  | { type: "hideTranslations"; taskId?: string }
  | { type: "showTranslations"; taskId?: string }
  | { type: "removeTranslations"; taskId?: string }
  | { type: "getPageRuntimeState" };

export type ContentResponse =
  | { type: "estimatePageResult"; estimate: PageTranslationEstimate }
  | { type: "collectSegmentsResult"; taskId: string; segments: PageSegment[] }
  | {
      type: "contentActionResult";
      success: boolean;
      appliedSegmentIds?: string[];
      failedSegmentIds?: string[];
      message?: string;
    }
  | { type: "pageRuntimeState"; hasTranslations: boolean; taskId?: string }
  | { type: "contentError"; message: string };

export type BackgroundRequest =
  | {
      type: "translatePage";
      tabId: number;
      sourceLanguage: string;
      targetLanguage: string;
    }
  | { type: "cancelTask"; taskId: string; reason: CancelReason }
  | { type: "getTaskForTab"; tabId: number }
  | { type: "getProviderStatus" }
  | { type: "openOptions" };

export type BackgroundResponse =
  | { type: "taskProgress"; progress: TranslationProgress }
  | { type: "providerStatus"; configured: boolean; providerLabel: string }
  | { type: "backgroundActionResult"; success: true }
  | { type: "backgroundError"; message: string };
