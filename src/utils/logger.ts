const REDACTED_KEYS = new Set(["apiKey", "sourceText", "prompt"]);
const MAX_STRING_LENGTH = 200;
const REDACTED_VALUE = "[REDACTED]";

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

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      REDACTED_KEYS.has(key) ? REDACTED_VALUE : redactValue(entry, seen),
    ]),
  );
}

function redactString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `[REDACTED_LONG_STRING length=${value.length}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
