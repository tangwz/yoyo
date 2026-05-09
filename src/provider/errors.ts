export type ProviderErrorCode =
  | "unauthorized"
  | "rateLimited"
  | "quotaExceeded"
  | "timeout"
  | "networkError"
  | "invalidRequest"
  | "invalidResponse"
  | "serverError"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function mapHttpStatusToProviderError(status: number, bodyText: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("unauthorized", "API key is invalid or unauthorized.", status);
  }
  if (status === 408) {
    return new ProviderError("timeout", "Provider request timed out.", status);
  }
  if (status === 429) {
    return new ProviderError("rateLimited", "Provider rate limit exceeded.", status);
  }
  if (status === 402) {
    return new ProviderError("quotaExceeded", "Provider quota is exhausted.", status);
  }
  if (status >= 500) {
    return new ProviderError("serverError", "Provider server returned an error.", status);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError("invalidRequest", "Provider rejected the request.", status);
  }
  return new ProviderError("unknown", bodyText || "Provider returned an unexpected error.", status);
}
