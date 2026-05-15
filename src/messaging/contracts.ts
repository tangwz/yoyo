import type {
  CancelReason,
  PageSegment,
  TranslationProgress,
  TranslationResultItem,
  TranslationMode,
} from "@/translation/types";
import type { ProviderReadiness } from "@/provider/readiness";

export type OptionsSection = "provider";

export type OptionsOpenSource = "first-run" | "popup" | "manual";

export type ProviderMode = "remote" | "local-only";

export type PageTranslationEstimate = {
  canTranslate: boolean;
  estimatedSegments: number;
  estimatedChars: number;
  reason?: string;
};

export type LazySegmentRecoverySnapshot = {
  sourceLanguage: string;
  targetLanguage: string;
  translationMode: TranslationMode;
  collectionComplete?: boolean;
  providerId?: string;
  textModel?: string;
  segments: PageSegment[];
  processedSegmentIds: string[];
  failedSegmentIds?: string[];
};

export type ContentRequest =
  | { type: "estimatePage" }
  | {
      type: "collectSegments";
      taskId: string;
      translationMode: TranslationMode;
      sourceLanguage: string;
      targetLanguage: string;
      providerId?: string;
      textModel?: string;
    }
  | { type: "applyTranslations"; taskId: string; items: TranslationResultItem[] }
  | { type: "taskProgress"; progress: TranslationProgress }
  | { type: "hideTranslations"; taskId?: string }
  | { type: "showTranslations"; taskId?: string }
  | { type: "removeTranslations"; taskId?: string }
  | { type: "getPageRuntimeState" }
  | {
      type: "showSelectionTranslation";
      sourceText: string;
      translatedText: string;
      errorMessage?: never;
    }
  | {
      type: "showSelectionTranslation";
      sourceText: string;
      errorMessage: string;
      translatedText?: never;
    };

export type ContentResponse =
  | { type: "estimatePageResult"; estimate: PageTranslationEstimate }
  | {
      type: "collectSegmentsResult";
      taskId: string;
      segments: PageSegment[];
      collectionComplete?: boolean;
    }
  | {
      type: "contentActionResult";
      success: boolean;
      appliedSegmentIds?: string[];
      failedSegmentIds?: string[];
      message?: string;
    }
  | {
      type: "pageRuntimeState";
      hasTranslations: boolean;
      taskId?: string;
      visibility?: "visible" | "hidden";
    }
  | { type: "contentError"; message: string };

export type BackgroundRequest =
  | {
      type: "translatePage";
      tabId: number;
      sourceLanguage: string;
      targetLanguage: string;
    }
  | { type: "cancelTask"; taskId: string; reason: CancelReason }
  | {
      type: "translateSelection";
      tabId: number;
      text: string;
      sourceLanguage: string;
      targetLanguage: string;
    }
  | { type: "getTaskForTab"; tabId: number }
  | { type: "getProviderStatus" }
  | {
      type: "openOptions";
      section?: OptionsSection;
      source?: OptionsOpenSource;
    }
  | {
      type: "enqueueLazySegments";
      taskId: string;
      segmentIds: string[];
      failedSegmentIds?: string[];
      recovery?: LazySegmentRecoverySnapshot;
    };

export type BackgroundResponse =
  | { type: "taskProgress"; progress: TranslationProgress }
  | {
      type: "providerStatus";
      configured: boolean;
      readiness: ProviderReadiness;
      providerLabel: string;
      providerMode: ProviderMode;
    }
  | { type: "backgroundActionResult"; success: true }
  | { type: "backgroundError"; message: string };
