export type PerfTraceMetadata = {
  taskId?: string;
  batchId?: string;
  stage?: string;
  attempt?: number;
  candidateIndex?: number;
  nextCandidateIndex?: number;
  providerType?: "openai-compatible" | "chrome-built-in-ai";
  model?: string;
  stream?: boolean;
  status?: number;
  success?: boolean;
  errorName?: string;
  errorCode?: string;
  requestType?: string;
  availability?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  detectedLanguage?: string;
  translationMode?: string;
  currentConcurrency?: number;
  previousConcurrency?: number;
  nextConcurrency?: number;
  reason?: string;
  createdDocument?: boolean;
  durationMs?: number;
  timeoutMs?: number;
  promptCharCount?: number;
  segmentId?: string;
  segmentOrder?: number;
  segmentCount?: number;
  sourceCharCount?: number;
  outputCharCount?: number;
  chunkCount?: number;
  itemCount?: number;
  pendingCount?: number;
  retryCount?: number;
  failedReportCount?: number;
  appliedCount?: number;
  failedCount?: number;
  returnedCount?: number;
  missingCount?: number;
};

const allowedMetadataKeys = [
  "taskId",
  "batchId",
  "stage",
  "attempt",
  "candidateIndex",
  "nextCandidateIndex",
  "providerType",
  "model",
  "stream",
  "status",
  "success",
  "errorName",
  "errorCode",
  "requestType",
  "availability",
  "sourceLanguage",
  "targetLanguage",
  "detectedLanguage",
  "translationMode",
  "currentConcurrency",
  "previousConcurrency",
  "nextConcurrency",
  "reason",
  "createdDocument",
  "durationMs",
  "timeoutMs",
  "promptCharCount",
  "segmentId",
  "segmentOrder",
  "segmentCount",
  "sourceCharCount",
  "outputCharCount",
  "chunkCount",
  "itemCount",
  "pendingCount",
  "retryCount",
  "failedReportCount",
  "appliedCount",
  "failedCount",
  "returnedCount",
  "missingCount",
] satisfies Array<keyof PerfTraceMetadata>;

const roundedMetadataKeys = new Set<keyof PerfTraceMetadata>(["durationMs"]);

export function isPerfTraceEnabled(): boolean {
  return import.meta.env.DEV === true;
}

export function tracePerf(
  eventName: string,
  metadata: PerfTraceMetadata = {},
): void {
  if (!isPerfTraceEnabled()) {
    return;
  }

  console.info(`[yoyo:perf] ${eventName}`, sanitizePerfMetadata(metadata));
}

export async function measurePerf<T>(
  eventName: string,
  metadata: PerfTraceMetadata,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = nowMs();

  try {
    const result = await operation();
    tracePerf(eventName, {
      ...metadata,
      durationMs: elapsedMs(startedAt),
      success: true,
    });
    return result;
  } catch (error) {
    tracePerf(eventName, {
      ...metadata,
      durationMs: elapsedMs(startedAt),
      success: false,
      ...metadataForError(error),
    });
    throw error;
  }
}

export function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function elapsedMs(startedAt: number): number {
  return roundDurationMs(nowMs() - startedAt);
}

export function metadataForError(error: unknown): PerfTraceMetadata {
  if (!isObject(error)) {
    return {};
  }

  const metadata: PerfTraceMetadata = {};

  if (typeof error.name === "string") {
    metadata.errorName = error.name;
  }

  if (typeof error.code === "string") {
    metadata.errorCode = error.code;
  }

  if (typeof error.status === "number" && Number.isFinite(error.status)) {
    metadata.status = error.status;
  }

  return metadata;
}

function sanitizePerfMetadata(
  metadata: PerfTraceMetadata,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const key of allowedMetadataKeys) {
    const value = metadata[key];
    if (value === undefined) {
      continue;
    }

    sanitized[key] =
      roundedMetadataKeys.has(key) && typeof value === "number"
        ? roundDurationMs(value)
        : value;
  }

  return sanitized;
}

function roundDurationMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
