export type LocalAiErrorCode =
  | "browserUnsupported"
  | "apiUnavailable"
  | "languagePairUnavailable"
  | "modelDownloadRequired"
  | "modelDownloadFailed"
  | "textTooLong"
  | "aborted"
  | "unknown";

export class LocalAiError extends Error {
  constructor(
    readonly code: LocalAiErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalAiError";
  }
}

export function formatLocalAiErrorMessage(code: LocalAiErrorCode): string {
  switch (code) {
    case "browserUnsupported":
      return "Chrome Built-in AI requires desktop Chrome 138 or later. No remote provider was used.";
    case "apiUnavailable":
      return "Chrome Built-in AI is not available in this browser. No remote provider was used.";
    case "languagePairUnavailable":
      return "Chrome Built-in AI is not available for this language pair. No remote provider was used.";
    case "modelDownloadRequired":
      return "Chrome needs to download a local translation model before translating this language pair. No remote provider was used.";
    case "modelDownloadFailed":
      return "Chrome could not download the local translation model. No remote provider was used.";
    case "textTooLong":
      return "The selected text is too long for Chrome Built-in AI. Select a shorter passage. No remote provider was used.";
    case "aborted":
      return "Chrome Built-in AI translation was cancelled. No remote provider was used.";
    case "unknown":
      return "Chrome Built-in AI translation failed. No remote provider was used.";
  }
}
