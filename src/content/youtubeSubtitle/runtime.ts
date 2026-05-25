import {
  mountYoutubeSubtitleOverlay,
  type YoutubeSubtitleOverlay,
} from "@/content/youtubeSubtitle/overlay";
import {
  mountYoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButtonStatus,
} from "@/content/youtubeSubtitle/playerButton";
import { parseYouTubeJson3Cues } from "@/content/youtubeSubtitle/captionParser";
import {
  defaultSubtitleSchedulerOptions,
  SubtitleScheduler,
} from "@/content/youtubeSubtitle/scheduler";
import { segmentSubtitleCues } from "@/content/youtubeSubtitle/segmentation";
import {
  createSubtitleSessionCacheKey,
  SubtitleSessionCache,
} from "@/content/youtubeSubtitle/sessionCache";
import {
  buildTrackKey,
  type YouTubeCaptionTrack,
} from "@/content/youtubeSubtitle/trackSelection";
import type {
  BackgroundRequest,
  BackgroundResponse,
} from "@/messaging/contracts";
import type {
  SubtitlePreferences,
  SubtitleSegment,
  SubtitleSourceLanguage,
} from "@/subtitle/types";

export type YouTubeSubtitleStopReason = Extract<
  BackgroundRequest,
  { type: "cancelSubtitleRequests" }
>["reason"];

export type YouTubeSubtitleRuntimeState = {
  started: boolean;
  enabled: boolean;
  runtimeSessionId: string;
  configVersion: number;
  videoKey: string;
};

export type YouTubeCaptionPayloadRequest = {
  runtimeSessionId: string;
  configVersion: number;
  videoKey: string;
};

export type YouTubeCaptionPayloadResult = {
  payload: unknown;
  track: YouTubeCaptionTrack;
  sourceLanguage?: SubtitleSourceLanguage;
};

export type YouTubeSubtitleRuntimeDependencies = {
  subtitlePreferences: {
    get: () => Promise<SubtitlePreferences>;
    save: (preferences: SubtitlePreferences) => Promise<void>;
  };
  sendBackgroundMessage: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  fetchCaptionPayload?: (
    request: YouTubeCaptionPayloadRequest,
  ) => Promise<YouTubeCaptionPayloadResult | undefined>;
  getCaptionTrackKey?: (
    request: YouTubeCaptionPayloadRequest,
  ) => Promise<string | undefined>;
  createRuntimeSessionIdBase?: () => string;
  document?: Document;
  getCurrentUrl?: () => string;
  createMutationObserver?: (callback: MutationCallback) => MutationObserver;
};

export type YouTubeSubtitleRuntime = {
  start: () => Promise<void>;
  stop: (reason: YouTubeSubtitleStopReason) => Promise<void>;
  handleConfigChanged: () => Promise<void>;
  destroy: () => Promise<void>;
  getState: () => YouTubeSubtitleRuntimeState;
};

const PLAYER_SELECTOR = "#movie_player";
const CONTROLS_SELECTOR = ".ytp-right-controls";
const SESSION_ID_PREFIX = "youtube-subtitle-session";
const SUBTITLE_PROMPT_VERSION = "subtitle-translation-v1";
const BUILTIN_SEGMENTATION_VERSION = "builtin-v1";
const AI_SEGMENTATION_VERSION = "ai-v1";
const AI_SEGMENTATION_PROMPT_VERSION = "subtitle-segmentation-v1";
const SUBTITLE_TRANSLATION_MODE = "youtubeSubtitleRealtime";

type ActivePipeline = {
  runtimeSessionId: string;
  configVersion: number;
  videoKey: string;
  video: HTMLVideoElement | undefined;
  trackKey: string;
  sourceLanguage: SubtitleSourceLanguage;
  targetLanguage: string;
  providerId: string;
  modelKey: string;
  segmentationVersion: string;
  segments: SubtitleSegment[];
  translations: Map<string, string>;
  failedSegmentIds: Set<string>;
  onTimeChange: () => void;
};

export function createYouTubeSubtitleRuntime(
  dependencies: YouTubeSubtitleRuntimeDependencies,
): YouTubeSubtitleRuntime {
  const rootDocument = dependencies.document ?? document;
  const createObserver =
    dependencies.createMutationObserver ??
    ((callback: MutationCallback) => new MutationObserver(callback));
  const getCurrentUrl =
    dependencies.getCurrentUrl ?? (() => rootDocument.location.href);

  let preferences: SubtitlePreferences | undefined;
  let started = false;
  let cancellableSession = false;
  let destroyed = false;
  let stopped = false;
  let startPromise: Promise<void> | undefined;
  let observer: MutationObserver | undefined;
  let reconcileQueued = false;
  let button: YoutubeSubtitlePlayerButton | undefined;
  let buttonStatus: YoutubeSubtitlePlayerButtonStatus | undefined;
  let overlay: YoutubeSubtitleOverlay | undefined;
  const runtimeSessionIdBase =
    dependencies.createRuntimeSessionIdBase?.() ??
    `${SESSION_ID_PREFIX}-${crypto.randomUUID()}`;
  let sessionIndex = 1;
  let configVersion = 1;
  let videoKey = readVideoKey(getCurrentUrl());
  let scheduler = createScheduler(preferences);
  let sessionCache = new SubtitleSessionCache();
  let pipeline: ActivePipeline | undefined;
  let initializingPipeline: Promise<void> | undefined;
  let requestIndex = 1;
  let operationQueue = Promise.resolve();

  async function start(): Promise<void> {
    if (destroyed) {
      return;
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      preferences = await dependencies.subtitlePreferences.get();
      if (destroyed) {
        return;
      }
      scheduler = createScheduler(preferences);
      sessionCache = new SubtitleSessionCache();
      videoKey = readVideoKey(getCurrentUrl());
      started = true;
      cancellableSession = true;
      stopped = false;
      ensureObserver();
      await reconcile();
    })();

    return startPromise;
  }

  async function stop(reason: YouTubeSubtitleStopReason): Promise<void> {
    if (destroyed) {
      return;
    }
    await stopSession(reason, true);
  }

  async function handleConfigChanged(): Promise<void> {
    await enqueueOperation(async () => {
      if (!started || destroyed) {
        return;
      }

      preferences = await dependencies.subtitlePreferences.get();
      if (destroyed) {
        return;
      }

      stopped = false;
      if (cancellableSession) {
        await stopSession("configChanged", false);
      } else {
        advanceSession();
        cancellableSession = true;
      }
      await reconcile();
    });
  }

  async function stopSession(
    reason: YouTubeSubtitleStopReason,
    suspendRuntime: boolean,
  ): Promise<void> {
    if (!cancellableSession) {
      return;
    }

    if (suspendRuntime) {
      stopped = true;
    }
    overlay?.destroy();
    overlay = undefined;
    detachPipeline();
    scheduler.clearInFlight();
    sessionCache.clear();

    const cancelledRuntimeSessionId = currentRuntimeSessionId();
    cancellableSession = false;
    advanceSession();

    try {
      await dependencies.sendBackgroundMessage({
        type: "cancelSubtitleRequests",
        runtimeSessionId: cancelledRuntimeSessionId,
        reason,
      });
    } catch (error) {
      console.warn("[yoyo] failed to cancel YouTube subtitle requests", {
        error,
        reason,
        runtimeSessionId: cancelledRuntimeSessionId,
      });
    } finally {
      if (!suspendRuntime && !destroyed) {
        cancellableSession = true;
      }
    }
  }

  async function destroy(): Promise<void> {
    if (destroyed) {
      return;
    }
    destroyed = true;
    observer?.disconnect();
    observer = undefined;
    await stopSession("pageUnloaded", true);
    button?.destroy();
    button = undefined;
    buttonStatus = undefined;
    overlay?.destroy();
    overlay = undefined;
    detachPipeline();
    started = false;
    cancellableSession = false;
  }

  async function reconcile(): Promise<void> {
    if (!started || destroyed) {
      return;
    }

    const nextVideoKey = readVideoKey(getCurrentUrl());
    if (videoKey && nextVideoKey !== videoKey) {
      await stopSession("videoChanged", false);
      stopped = false;
    }
    videoKey = nextVideoKey;

    const player = findPlayer(rootDocument);
    const controls = findControls(player);
    const enabled = (preferences?.youtubeEnabled ?? false) && !stopped;

    if (button && button.element.parentElement !== controls) {
      button.destroy();
      button = undefined;
      buttonStatus = undefined;
    }

    if (controls) {
      const nextButtonStatus = statusFor(enabled, player);
      if (button) {
        updateButtonStatus(nextButtonStatus);
      } else {
        button = mountYoutubeSubtitlePlayerButton({
          controls,
          status: nextButtonStatus,
          onToggle: () => {
            void enqueueOperation(toggleEnabled);
          },
        });
        buttonStatus = nextButtonStatus;
      }
    } else if (button) {
      button.destroy();
      button = undefined;
      buttonStatus = undefined;
    }

    if (overlay && overlay.element.parentElement !== player) {
      overlay.destroy();
      overlay = undefined;
    }

    if (enabled && player) {
      overlay = mountYoutubeSubtitleOverlay({ player });
      void ensurePipeline(player);
    } else {
      overlay?.destroy();
      overlay = undefined;
      detachPipeline();
      updateButtonStatus(statusFor(enabled, player));
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (!preferences) {
      return;
    }

    if (preferences.youtubeEnabled) {
      preferences = { ...preferences, youtubeEnabled: false };
      await dependencies.subtitlePreferences.save(preferences);
      await stop("userDisabled");
      await reconcile();
      return;
    }

    preferences = { ...preferences, youtubeEnabled: true };
    await dependencies.subtitlePreferences.save(preferences);
    stopped = false;
    advanceSession();
    cancellableSession = true;
    await reconcile();
  }

  function ensureObserver(): void {
    if (observer || destroyed) {
      return;
    }

    observer = createObserver(() => {
      queueReconcile();
    });
    observer.observe(rootDocument.body ?? rootDocument.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function queueReconcile(): void {
    if (reconcileQueued || destroyed) {
      return;
    }
    reconcileQueued = true;
    queueMicrotask(() => {
      reconcileQueued = false;
      void enqueueOperation(reconcile);
    });
  }

  function enqueueOperation(operation: () => Promise<void>): Promise<void> {
    operationQueue = operationQueue.then(operation, operation);
    return operationQueue;
  }

  function advanceSession(): void {
    sessionIndex += 1;
    configVersion += 1;
    requestIndex = 1;
    detachPipeline();
    scheduler = createScheduler(preferences);
    sessionCache = new SubtitleSessionCache();
  }

  function updateButtonStatus(status: YoutubeSubtitlePlayerButtonStatus): void {
    if (!button || buttonStatus === status) {
      return;
    }
    button.update({ status });
    buttonStatus = status;
  }

  return {
    start,
    stop,
    handleConfigChanged,
    destroy,
    getState: () => ({
      started,
      enabled: (preferences?.youtubeEnabled ?? false) && !stopped,
      runtimeSessionId: currentRuntimeSessionId(),
      configVersion,
      videoKey,
    }),
  };

  function currentRuntimeSessionId(): string {
    return `${runtimeSessionIdBase}-${sessionIndex}`;
  }

  async function ensurePipeline(player: HTMLElement): Promise<void> {
    if (!preferences?.youtubeEnabled || stopped || destroyed) {
      return;
    }
    if (
      pipeline &&
      pipeline.runtimeSessionId === currentRuntimeSessionId() &&
      pipeline.configVersion === configVersion &&
      pipeline.videoKey === videoKey
    ) {
      const activePipeline = pipeline;
      const currentTrackKey = await dependencies.getCaptionTrackKey?.({
        runtimeSessionId: activePipeline.runtimeSessionId,
        configVersion: activePipeline.configVersion,
        videoKey: activePipeline.videoKey,
      });
      if (currentTrackKey && currentTrackKey !== activePipeline.trackKey) {
        const cancelledRuntimeSessionId = currentRuntimeSessionId();
        advanceSession();
        void dependencies.sendBackgroundMessage({
          type: "cancelSubtitleRequests",
          runtimeSessionId: cancelledRuntimeSessionId,
          reason: "configChanged",
        }).catch(() => undefined);
        return ensurePipeline(player);
      }
      bindPipelineVideo(player, activePipeline);
      renderActiveSubtitle();
      scheduleTranslations();
      return;
    }
    if (initializingPipeline) {
      return initializingPipeline;
    }

    initializingPipeline = initializePipeline(player)
      .catch((error) => {
        if (!destroyed && !stopped) {
          console.warn("[yoyo] failed to initialize YouTube subtitle pipeline", {
            error,
            runtimeSessionId: currentRuntimeSessionId(),
          });
          updateButtonStatus("warning");
        }
      })
      .finally(() => {
        initializingPipeline = undefined;
      });
    return initializingPipeline;
  }

  async function initializePipeline(player: HTMLElement): Promise<void> {
    const runtimeSessionId = currentRuntimeSessionId();
    const pipelineConfigVersion = configVersion;
    const pipelineVideoKey = videoKey;
    updateButtonStatus("loading");

    const configResponse = await dependencies.sendBackgroundMessage({
      type: "getSubtitleRuntimeConfig",
    });
    if (
      !isCurrentPipeline(
        runtimeSessionId,
        pipelineConfigVersion,
        pipelineVideoKey,
      )
    ) {
      return;
    }
    if (
      configResponse.type !== "subtitleRuntimeConfig" ||
      !configResponse.configured
    ) {
      updateButtonStatus("warning");
      return;
    }

    const captionPayload = await dependencies.fetchCaptionPayload?.({
      runtimeSessionId,
      configVersion: pipelineConfigVersion,
      videoKey: pipelineVideoKey,
    });
    if (
      !captionPayload ||
      !isCurrentPipeline(runtimeSessionId, pipelineConfigVersion, pipelineVideoKey)
    ) {
      updateButtonStatus("warning");
      return;
    }

    const cues = parseYouTubeJson3Cues(captionPayload.payload);
    if (cues.length === 0) {
      updateButtonStatus("warning");
      return;
    }

    const sourceLanguage =
      captionPayload.sourceLanguage ??
      sourceLanguageFromTrack(captionPayload.track);
    const segmentation = await segmentCues(runtimeSessionId, {
      configVersion: pipelineConfigVersion,
      videoKey: pipelineVideoKey,
      cues,
      trackKey: buildTrackKey(pipelineVideoKey, captionPayload.track),
      sourceLanguage,
      targetLanguage: configResponse.targetLanguage,
      providerId: configResponse.providerId,
      modelKey: configResponse.modelKey,
    });
    if (
      !isCurrentPipeline(
        runtimeSessionId,
        pipelineConfigVersion,
        pipelineVideoKey,
      )
    ) {
      return;
    }
    const { segments, segmentationVersion, trackKey } = segmentation;
    if (segments.length === 0) {
      updateButtonStatus("warning");
      return;
    }

    scheduler.replaceTimeline(segments);
    const onTimeChange = (): void => {
      renderActiveSubtitle();
      scheduleTranslations();
    };

    pipeline = {
      runtimeSessionId,
      configVersion: pipelineConfigVersion,
      videoKey: pipelineVideoKey,
      video: undefined,
      trackKey,
      sourceLanguage,
      targetLanguage: configResponse.targetLanguage,
      providerId: configResponse.providerId,
      modelKey: configResponse.modelKey,
      segmentationVersion,
      segments,
      translations: new Map(),
      failedSegmentIds: new Set(),
      onTimeChange,
    };
    bindPipelineVideo(player, pipeline);

    updateButtonStatus("enabled");
    renderActiveSubtitle();
    scheduleTranslations();
  }

  function detachPipeline(): void {
    if (pipeline?.video) {
      pipeline.video.removeEventListener("timeupdate", pipeline.onTimeChange);
      pipeline.video.removeEventListener("seeked", pipeline.onTimeChange);
    }
    pipeline = undefined;
    initializingPipeline = undefined;
  }

  function renderActiveSubtitle(): void {
    if (!pipeline || !overlay) {
      return;
    }

    const currentTimeMs = currentVideoTimeMs(pipeline);
    const activeSegment = pipeline.segments.find(
      (segment) =>
        segment.startMs <= currentTimeMs && segment.endMs >= currentTimeMs,
    );
    if (!activeSegment) {
      overlay.hide();
      return;
    }

    const translatedText = pipeline.translations.get(activeSegment.segmentId);
    if (translatedText !== undefined) {
      overlay.render({
        state: "translated",
        sourceText: activeSegment.sourceText,
        translatedText,
      });
      return;
    }

    if (pipeline.failedSegmentIds.has(activeSegment.segmentId)) {
      overlay.render({ state: "failed", sourceText: activeSegment.sourceText });
      return;
    }

    overlay.render({ state: "loading", sourceText: activeSegment.sourceText });
  }

  function bindPipelineVideo(player: HTMLElement, active: ActivePipeline): void {
    const nextVideo = findVideo(player);
    if (active.video === nextVideo) {
      return;
    }

    active.video?.removeEventListener("timeupdate", active.onTimeChange);
    active.video?.removeEventListener("seeked", active.onTimeChange);
    active.video = nextVideo;
    active.video?.addEventListener("timeupdate", active.onTimeChange);
    active.video?.addEventListener("seeked", active.onTimeChange);
  }

  function scheduleTranslations(): void {
    const active = pipeline;
    if (!active || destroyed || stopped) {
      return;
    }

    scheduler.scanWindow(currentVideoTimeMs(active));
    const requestId = `${active.runtimeSessionId}-request-${requestIndex}`;
    const batch = scheduler.takeBatch(requestId);
    if (batch.length === 0) {
      return;
    }
    requestIndex += 1;

    const missingSegments: SubtitleSegment[] = [];
    const cachedSegmentIds: string[] = [];
    for (const segment of batch) {
      const translatedText = sessionCache.get(cacheKey(active, segment));
      if (translatedText === undefined) {
        missingSegments.push(segment);
      } else {
        active.translations.set(segment.segmentId, translatedText);
        cachedSegmentIds.push(segment.segmentId);
      }
    }
    if (cachedSegmentIds.length > 0) {
      scheduler.markTranslated(requestId, cachedSegmentIds);
      renderActiveSubtitle();
    }
    if (missingSegments.length === 0) {
      return;
    }

    if (sourceMatchesTarget(active)) {
      for (const segment of missingSegments) {
        active.translations.set(segment.segmentId, segment.sourceText);
        sessionCache.set(cacheKey(active, segment), segment.sourceText);
      }
      scheduler.markTranslated(
        requestId,
        missingSegments.map((segment) => segment.segmentId),
      );
      renderActiveSubtitle();
      return;
    }

    void dependencies
      .sendBackgroundMessage({
        type: "translateSubtitleBatch",
        runtimeSessionId: active.runtimeSessionId,
        configVersion: active.configVersion,
        requestId,
        videoId: active.videoKey,
        trackKey: active.trackKey,
        sourceLanguage: active.sourceLanguage,
        targetLanguage: active.targetLanguage,
        providerId: active.providerId,
        modelKey: active.modelKey,
        promptVersion: SUBTITLE_PROMPT_VERSION,
        segmentationVersion: active.segmentationVersion,
        translationMode: SUBTITLE_TRANSLATION_MODE,
        segments: missingSegments,
      })
      .then((response) => {
        if (
          !isCurrentPipeline(
            active.runtimeSessionId,
            active.configVersion,
            active.videoKey,
          )
        ) {
          return;
        }
        if (
          response.type === "subtitleTranslateBatchResult" &&
          response.runtimeSessionId === active.runtimeSessionId &&
          response.configVersion === active.configVersion &&
          response.requestId === requestId
        ) {
          const translatedSegmentIds: string[] = [];
          for (const item of response.items) {
            const segment = missingSegments.find(
              (candidate) => candidate.segmentId === item.segmentId,
            );
            if (!segment) {
              continue;
            }
            active.translations.set(item.segmentId, item.translatedText);
            sessionCache.set(cacheKey(active, segment), item.translatedText);
            active.failedSegmentIds.delete(item.segmentId);
            translatedSegmentIds.push(item.segmentId);
          }
          scheduler.markTranslated(requestId, translatedSegmentIds);
          const failedIds = missingSegments
            .map((segment) => segment.segmentId)
            .filter((segmentId) => !translatedSegmentIds.includes(segmentId));
          if (failedIds.length > 0) {
            scheduler.markFailed(requestId, failedIds);
            failedIds.forEach((segmentId) =>
              active.failedSegmentIds.add(segmentId),
            );
          }
          renderActiveSubtitle();
          return;
        }

        if (
          response.type === "subtitleTranslateBatchError" &&
          response.runtimeSessionId === active.runtimeSessionId &&
          response.configVersion === active.configVersion &&
          response.requestId === requestId
        ) {
          const failedIds = missingSegments.map((segment) => segment.segmentId);
          scheduler.markFailed(requestId, failedIds);
          failedIds.forEach((segmentId) =>
            active.failedSegmentIds.add(segmentId),
          );
          renderActiveSubtitle();
        }
      })
      .catch(() => {
        if (
          !isCurrentPipeline(
            active.runtimeSessionId,
            active.configVersion,
            active.videoKey,
          )
        ) {
          return;
        }
        const failedIds = missingSegments.map((segment) => segment.segmentId);
        scheduler.markFailed(requestId, failedIds);
        failedIds.forEach((segmentId) =>
          active.failedSegmentIds.add(segmentId),
        );
        renderActiveSubtitle();
      });
  }

  function isCurrentPipeline(
    runtimeSessionId: string,
    expectedConfigVersion: number,
    expectedVideoKey: string,
  ): boolean {
    return (
      !destroyed &&
      !stopped &&
      runtimeSessionId === currentRuntimeSessionId() &&
      expectedConfigVersion === configVersion &&
      expectedVideoKey === videoKey
    );
  }

  async function segmentCues(
    runtimeSessionId: string,
    input: {
      configVersion: number;
      videoKey: string;
      cues: ReturnType<typeof parseYouTubeJson3Cues>;
      trackKey: string;
      sourceLanguage: SubtitleSourceLanguage;
      targetLanguage: string;
      providerId: string;
      modelKey: string;
    },
  ): Promise<{
    segments: SubtitleSegment[];
    segmentationVersion: string;
    trackKey: string;
  }> {
    if (preferences?.aiSegmentationEnabled) {
      const requestId = `${runtimeSessionId}-segmentation-${input.configVersion}`;
      try {
        const response = await dependencies.sendBackgroundMessage({
          type: "segmentSubtitleChunk",
          runtimeSessionId,
          configVersion: input.configVersion,
          requestId,
          videoId: input.videoKey,
          trackKey: input.trackKey,
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          providerId: input.providerId,
          modelKey: input.modelKey,
          segmentationPromptVersion: AI_SEGMENTATION_PROMPT_VERSION,
          segmentationVersion: AI_SEGMENTATION_VERSION,
          sourceCues: input.cues,
        });

        if (
          response.type === "segmentSubtitleChunkResult" &&
          response.runtimeSessionId === runtimeSessionId &&
          response.configVersion === input.configVersion &&
          response.requestId === requestId
        ) {
          return {
            segments: response.segments,
            segmentationVersion: AI_SEGMENTATION_VERSION,
            trackKey: input.trackKey,
          };
        }
      } catch {
        // AI segmentation is an optional quality pass; fall back to built-in segmentation.
      }
    }

    return {
      segments: segmentSubtitleCues(input.cues, {
        sourceLanguage: input.sourceLanguage,
      }),
      segmentationVersion: BUILTIN_SEGMENTATION_VERSION,
      trackKey: input.trackKey,
    };
  }
}

function createScheduler(
  preferences: SubtitlePreferences | undefined,
): SubtitleScheduler {
  return new SubtitleScheduler({
    ...defaultSubtitleSchedulerOptions,
    prefetchBeforeMs:
      preferences?.prefetchBeforeMs ?? defaultSubtitleSchedulerOptions.prefetchBeforeMs,
    prefetchAfterMs:
      preferences?.prefetchAfterMs ?? defaultSubtitleSchedulerOptions.prefetchAfterMs,
    maxRetryCount:
      preferences?.maxRetryCount ?? defaultSubtitleSchedulerOptions.maxRetryCount,
  });
}

function findPlayer(rootDocument: Document): HTMLElement | null {
  return rootDocument.querySelector<HTMLElement>(PLAYER_SELECTOR);
}

function findControls(player: HTMLElement | null): HTMLElement | null {
  return player?.querySelector<HTMLElement>(CONTROLS_SELECTOR) ?? null;
}

function findVideo(player: HTMLElement): HTMLVideoElement | undefined {
  return player.querySelector<HTMLVideoElement>("video") ?? undefined;
}

function statusFor(
  enabled: boolean,
  player: HTMLElement | null,
): YoutubeSubtitlePlayerButtonStatus {
  if (!enabled) {
    return "disabled";
  }
  return player ? "enabled" : "warning";
}

function readVideoKey(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.endsWith("youtube.com")) {
      const watchVideoId = parsedUrl.searchParams.get("v");
      if (watchVideoId) {
        return watchVideoId;
      }
      const pathVideoId = parsedUrl.pathname.match(
        /^\/(?:shorts|embed)\/([^/?#]+)/,
      )?.[1];
      return pathVideoId ?? parsedUrl.pathname;
    }
    return `${parsedUrl.hostname}${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return url;
  }
}

function sourceLanguageFromTrack(track: YouTubeCaptionTrack): SubtitleSourceLanguage {
  return track.languageCode
    ? { kind: "known", code: track.languageCode }
    : { kind: "unknown" };
}

function currentVideoTimeMs(pipeline: ActivePipeline): number {
  return Math.max(0, Math.round((pipeline.video?.currentTime ?? 0) * 1000));
}

function sourceMatchesTarget(pipeline: ActivePipeline): boolean {
  return (
    pipeline.sourceLanguage.kind === "known" &&
    normalizeLanguageCode(pipeline.sourceLanguage.code) ===
      normalizeLanguageCode(pipeline.targetLanguage)
  );
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().replace(/_/g, "-").toLowerCase();
}

function cacheKey(pipeline: ActivePipeline, segment: SubtitleSegment): string {
  return createSubtitleSessionCacheKey({
    videoId: pipeline.videoKey,
    trackKey: pipeline.trackKey,
    sourceLanguage: pipeline.sourceLanguage,
    targetLanguage: pipeline.targetLanguage,
    providerId: pipeline.providerId,
    modelKey: pipeline.modelKey,
    segmentTextHash: segment.textHash,
    segmentationVersion: pipeline.segmentationVersion,
    translationMode: SUBTITLE_TRANSLATION_MODE,
    promptVersion: SUBTITLE_PROMPT_VERSION,
  });
}
