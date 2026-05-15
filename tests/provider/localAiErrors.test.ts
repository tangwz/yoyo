import { describe, expect, it } from "vitest";
import {
  LocalAiError,
  formatLocalAiErrorMessage,
} from "@/provider/localAiErrors";

describe("local AI errors", () => {
  it("preserves local AI error codes", () => {
    const error = new LocalAiError(
      "browserUnsupported",
      "Chrome Built-in AI requires desktop Chrome 138 or later.",
    );

    expect(error.code).toBe("browserUnsupported");
    expect(error.message).toBe(
      "Chrome Built-in AI requires desktop Chrome 138 or later.",
    );
  });

  it("formats local-only user messages", () => {
    expect(formatLocalAiErrorMessage("languagePairUnavailable")).toBe(
      "Chrome Built-in AI is not available for this language pair. No remote provider was used.",
    );
  });
});
