const REDACTED_KEYS = new Set([
  "apikey",
  "sourcetext",
  "prompt",
  "authorization",
  "token",
  "secret",
  "password",
  "cookie",
  "accesstoken",
  "refreshtoken",
]);
const MAX_STRING_LENGTH = 200;
const REDACTED_VALUE = "[REDACTED]";
const CIRCULAR_VALUE = "[circular]";

type LogMethod = (message: string, ...metadata: unknown[]) => void;
type ConsoleMethod = "info" | "warn" | "error";

export interface Logger {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

export function createLogger(scope: string): Logger {
  return {
    info: createLogMethod("info", scope),
    warn: createLogMethod("warn", scope),
    error: createLogMethod("error", scope),
  };
}

function createLogMethod(method: ConsoleMethod, scope: string): LogMethod {
  return (message, ...metadata) => {
    const prefix = `[yoyo:${scope}] ${message}`;
    if (metadata.length === 0) {
      console[method](prefix);
      return;
    }

    console[method](prefix, ...metadata.map((value) => redactValue(value)));
  };
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (value instanceof Error) {
    return redactError(value);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? REDACTED_VALUE : redactValue(entry, seen),
    ]),
  );
}

function redactError(error: Error): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };

  const errorWithDiagnostics = error as Error & {
    code?: unknown;
    status?: unknown;
  };

  if (isSafeDiagnosticValue(errorWithDiagnostics.code)) {
    output.code = redactValue(errorWithDiagnostics.code);
  }

  if (isSafeDiagnosticValue(errorWithDiagnostics.status)) {
    output.status = redactValue(errorWithDiagnostics.status);
  }

  return output;
}

function redactString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `[REDACTED_LONG_STRING length=${value.length}]`;
}

function isSensitiveKey(key: string): boolean {
  return REDACTED_KEYS.has(normalizeKey(key));
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSafeDiagnosticValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
