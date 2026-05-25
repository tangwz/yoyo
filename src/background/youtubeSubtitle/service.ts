import { SubtitleTranslationCache } from "@/background/youtubeSubtitle/cache";
import {
  createSubtitleSessionCacheKey,
  type SubtitleSessionCacheKeyInput,
} from "@/content/youtubeSubtitle/sessionCache";
import type { BackgroundRequest, BackgroundResponse } from "@/messaging/contracts";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { OpenAiCompatibleProviderProfile, ProviderProfile } from "@/provider/types";
import type { SubtitleSegment, SubtitleTranslationItem } from "@/subtitle/types";
import type { PageSegment } from "@/translation/types";

export type SubtitleTranslationBatchRequest = Extract<
  BackgroundRequest,
  { type: "translateSubtitleBatch" }
>;

export type SubtitleTranslationServiceDependencies = {
  getActiveProfile?: () => Promise<ProviderProfile | undefined>;
  getProviderProfile?: (providerId: string) => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  detectSourceLanguage: (
    text: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  cache?: SubtitleTranslationCache<string>;
};

export type SubtitleTranslationService = {
  translateBatch(request: SubtitleTranslationBatchRequest): Promise<BackgroundResponse>;
  cancel(runtimeSessionId: string): void;
};

export function createSubtitleTranslationService(
  dependencies: SubtitleTranslationServiceDependencies,
): SubtitleTranslationService {
  return new DefaultSubtitleTranslationService(dependencies);
}

class DefaultSubtitleTranslationService implements SubtitleTranslationService {
  private readonly cache: SubtitleTranslationCache<string>;
  private readonly controllersBySession = new Map<string, Map<string, AbortController>>();

  constructor(private readonly dependencies: SubtitleTranslationServiceDependencies) {
    this.cache = dependencies.cache ?? new SubtitleTranslationCache<string>();
  }

  async translateBatch(
    request: SubtitleTranslationBatchRequest,
  ): Promise<BackgroundResponse> {
    if (request.segments.length === 0) {
      return this.resultResponse(request, []);
    }

    const controller = new AbortController();
    this.registerController(request, controller);

    try {
      const profile = await this.getProfile(request);
      if (controller.signal.aborted) {
        return this.cancelledResponse(request);
      }

      if (!profile) {
        return this.errorResponse(
          request,
          "Translation provider is not configured.",
          false,
        );
      }

      const cachedItems = new Map<string, string>();
      const missedSegments: SubtitleSegment[] = [];

      for (const segment of request.segments) {
        const cachedText = this.cache.get(this.cacheKey(request, segment));
        if (cachedText === undefined) {
          missedSegments.push(segment);
        } else {
          cachedItems.set(segment.segmentId, cachedText);
        }
      }

      if (missedSegments.length === 0) {
        return this.resultResponse(request, this.itemsInRequestOrder(request, cachedItems));
      }

      const sourceLanguage = await this.resolveSourceLanguage(request, controller.signal);
      if (controller.signal.aborted) {
        return this.cancelledResponse(request);
      }

      const requestProfile = this.profileForRequestedModel(profile, request.modelKey);
      if (!requestProfile) {
        return this.errorResponse(
          request,
          "Requested subtitle translation model is not available for this provider.",
          false,
        );
      }

      const provider = this.dependencies.getTranslationProvider(requestProfile);
      const response = await provider.translateBatch({
        profile: requestProfile,
        sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: missedSegments.map((segment) =>
          this.toPageSegment(segment, request.segments.indexOf(segment)),
        ),
        traceContext: {
          taskId: request.runtimeSessionId,
          batchId: request.requestId,
          stage: "subtitle",
          providerType: requestProfile.type,
          segmentCount: missedSegments.length,
          sourceCharCount: this.sourceCharCount(missedSegments),
        },
        abortSignal: controller.signal,
      });
      if (controller.signal.aborted) {
        return this.cancelledResponse(request);
      }

      const missedById = new Map(
        missedSegments.map((segment) => [segment.segmentId, segment]),
      );
      for (const item of response.items) {
        const sourceSegment = missedById.get(item.segmentId);
        if (!sourceSegment) {
          continue;
        }

        cachedItems.set(item.segmentId, item.translatedText);
        this.cache.set(this.cacheKey(request, sourceSegment), item.translatedText);
      }

      return this.resultResponse(request, this.itemsInRequestOrder(request, cachedItems));
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return this.cancelledResponse(request);
      }

      return this.errorResponse(request, errorMessage(error), true);
    } finally {
      this.unregisterController(request);
    }
  }

  cancel(runtimeSessionId: string): void {
    const controllers = this.controllersBySession.get(runtimeSessionId);
    if (!controllers) {
      return;
    }

    for (const controller of controllers.values()) {
      controller.abort();
    }

    this.controllersBySession.delete(runtimeSessionId);
  }

  private async getProfile(
    request: SubtitleTranslationBatchRequest,
  ): Promise<ProviderProfile | undefined> {
    if (this.dependencies.getProviderProfile) {
      return this.dependencies.getProviderProfile(request.providerId);
    }

    return this.dependencies.getActiveProfile?.();
  }

  private profileForRequestedModel(
    profile: ProviderProfile,
    modelKey: string,
  ): ProviderProfile | undefined {
    if (profile.type === "openai-compatible") {
      return {
        ...profile,
        textModel: modelKey,
      } satisfies OpenAiCompatibleProviderProfile;
    }

    return modelKey === profile.id ? profile : undefined;
  }

  private async resolveSourceLanguage(
    request: SubtitleTranslationBatchRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.sourceLanguage.kind === "known") {
      return request.sourceLanguage.code;
    }

    try {
      const detectedLanguage = await this.dependencies.detectSourceLanguage(
        request.segments.map((segment) => segment.sourceText).join("\n"),
        signal,
      );
      return detectedLanguage || "auto";
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw error;
      }

      return "auto";
    }
  }

  private registerController(
    request: SubtitleTranslationBatchRequest,
    controller: AbortController,
  ): void {
    const controllers =
      this.controllersBySession.get(request.runtimeSessionId) ?? new Map();
    controllers.set(request.requestId, controller);
    this.controllersBySession.set(request.runtimeSessionId, controllers);
  }

  private unregisterController(request: SubtitleTranslationBatchRequest): void {
    const controllers = this.controllersBySession.get(request.runtimeSessionId);
    if (!controllers) {
      return;
    }

    controllers.delete(request.requestId);
    if (controllers.size === 0) {
      this.controllersBySession.delete(request.runtimeSessionId);
    }
  }

  private toPageSegment(segment: SubtitleSegment, order: number): PageSegment {
    return {
      id: segment.segmentId,
      order,
      sourceText: segment.sourceText,
      kind: "paragraph",
      priority: "viewport",
      pathHint: `youtube.subtitle.${segment.segmentId}`,
      textHash: segment.textHash,
    };
  }

  private cacheKey(
    request: SubtitleTranslationBatchRequest,
    segment: SubtitleSegment,
  ): string {
    const keyInput: SubtitleSessionCacheKeyInput = {
      videoId: request.videoId,
      trackKey: request.trackKey,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      providerId: request.providerId,
      modelKey: request.modelKey,
      segmentTextHash: segment.textHash,
      segmentationVersion: request.segmentationVersion,
      translationMode: request.translationMode,
      promptVersion: request.promptVersion,
    };

    return createSubtitleSessionCacheKey(keyInput);
  }

  private sourceCharCount(segments: SubtitleSegment[]): number {
    return segments.reduce((total, segment) => total + segment.sourceText.length, 0);
  }

  private itemsInRequestOrder(
    request: SubtitleTranslationBatchRequest,
    translatedItems: Map<string, string>,
  ): SubtitleTranslationItem[] {
    return request.segments.flatMap((segment) => {
      const translatedText = translatedItems.get(segment.segmentId);
      return translatedText === undefined
        ? []
        : [{ segmentId: segment.segmentId, translatedText }];
    });
  }

  private resultResponse(
    request: SubtitleTranslationBatchRequest,
    items: SubtitleTranslationItem[],
  ): BackgroundResponse {
    return {
      type: "subtitleTranslateBatchResult",
      runtimeSessionId: request.runtimeSessionId,
      configVersion: request.configVersion,
      requestId: request.requestId,
      items,
    };
  }

  private errorResponse(
    request: SubtitleTranslationBatchRequest,
    message: string,
    retryable: boolean,
  ): BackgroundResponse {
    return {
      type: "subtitleTranslateBatchError",
      runtimeSessionId: request.runtimeSessionId,
      configVersion: request.configVersion,
      requestId: request.requestId,
      message,
      retryable,
    };
  }

  private cancelledResponse(request: SubtitleTranslationBatchRequest): BackgroundResponse {
    return this.errorResponse(
      request,
      "Subtitle translation request was cancelled.",
      false,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Subtitle translation failed.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
