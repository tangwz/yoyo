import type {
  CancelReason,
  PageSegment,
  TranslationProgress,
  TranslationResultItem,
  TranslationMode,
} from "@/translation/types";
import type { ProviderReadiness } from "@/provider/readiness";
import type { SummarySourceResult } from "@/summary/types";
import type {
  SubtitleCue,
  SubtitleSegment,
  SubtitleSourceLanguage,
  SubtitleTranslationItem,
  SubtitleTranslationMode,
} from "@/subtitle/types";

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
      deferLazyCollection?: boolean;
      targetLanguage: string;
      providerId?: string;
      textModel?: string;
    }
  | {
      type: "finalizeLazyRecoverySourceLanguage";
      taskId: string;
      sourceLanguage: string;
    }
  | { type: "applyTranslations"; taskId: string; items: TranslationResultItem[] }
  | { type: "taskProgress"; progress: TranslationProgress }
  | { type: "hideTranslations"; taskId?: string }
  | { type: "showTranslations"; taskId?: string }
  | { type: "removeTranslations"; taskId?: string }
  | { type: "getPageRuntimeState" }
  | { type: "collectSummarySource" }
  | {
      type: "showPageSummary";
      targetLanguage: string;
      summaryText: string;
      errorMessage?: never;
    }
  | {
      type: "showPageSummary";
      targetLanguage: string;
      errorMessage: string;
      summaryText?: never;
    }
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
  | ({ type: "summarySourceResult" } & SummarySourceResult)
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
  | {
      type: "summarizePage";
      tabId: number;
      targetLanguage: string;
    }
  | { type: "getTaskForTab"; tabId: number }
  | { type: "getProviderStatus" }
  | { type: "getSubtitleRuntimeConfig" }
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
    }
  | {
      type: "enqueueTranslationBatch";
      taskId: string;
      sourceLanguage: string;
      targetLanguage: string;
      translationMode: TranslationMode;
      segments: PageSegment[];
      collectionComplete?: boolean;
      failedSegmentIds?: string[];
      recovery?: LazySegmentRecoverySnapshot;
    }
  | {
      type: "translateSubtitleBatch";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      videoId: string;
      trackKey: string;
      sourceLanguage: SubtitleSourceLanguage;
      targetLanguage: string;
      providerId: string;
      modelKey: string;
      promptVersion: string;
      segmentationVersion: string;
      translationMode: SubtitleTranslationMode;
      segments: SubtitleSegment[];
    }
  | {
      type: "cancelSubtitleRequests";
      runtimeSessionId: string;
      reason: "userDisabled" | "videoChanged" | "configChanged" | "pageUnloaded";
    }
  | {
      type: "segmentSubtitleChunk";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      videoId: string;
      trackKey: string;
      sourceLanguage: SubtitleSourceLanguage;
      targetLanguage: string;
      providerId: string;
      modelKey: string;
      segmentationPromptVersion: string;
      segmentationVersion: string;
      sourceCues: SubtitleCue[];
      previousContext?: string;
      nextContext?: string;
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
  | { type: "backgroundError"; message: string }
  | {
      type: "subtitleTranslateBatchResult";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      items: SubtitleTranslationItem[];
    }
  | {
      type: "subtitleTranslateBatchError";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      message: string;
      retryable: boolean;
    }
  | {
      type: "subtitleRuntimeConfig";
      configured: true;
      providerId: string;
      modelKey: string;
      targetLanguage: string;
    }
  | {
      type: "subtitleRuntimeConfig";
      configured: false;
      targetLanguage: string;
      message: string;
    }
  | {
      type: "segmentSubtitleChunkResult";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      segments: Array<SubtitleSegment & { translatedText?: string }>;
    }
  | {
      type: "segmentSubtitleChunkError";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      message: string;
      fallbackRequired: true;
    };
