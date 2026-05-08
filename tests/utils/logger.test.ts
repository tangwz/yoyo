import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@/utils/logger";

function renderedConsoleArgs(call: unknown[]): string {
  return call
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

describe("createLogger", () => {
  it("prefixes messages and calls the matching console method", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const logger = createLogger("provider");

    logger.info("ready");
    logger.warn("retrying");
    logger.error("failed");

    expect(infoSpy).toHaveBeenCalledWith("[yoyo:provider] ready");
    expect(warnSpy).toHaveBeenCalledWith("[yoyo:provider] retrying");
    expect(errorSpy).toHaveBeenCalledWith("[yoyo:provider] failed");
  });

  it("redacts sensitive nested metadata without mutating the input", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const metadata = {
      provider: {
        apiKey: "sk-secret",
        requests: [{ prompt: "Translate the private text." }],
      },
      sourceText: "The original source text.",
      visible: "safe value",
    };

    createLogger("translation").info("request created", metadata);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("[yoyo:translation] request created");
    expect(output).toContain("safe value");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("Translate the private text.");
    expect(output).not.toContain("The original source text.");
    expect(metadata.provider.apiKey).toBe("sk-secret");
    expect(metadata.provider.requests[0].prompt).toBe("Translate the private text.");
    expect(metadata.sourceText).toBe("The original source text.");
  });

  it("redacts long strings so complete page text is not emitted", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const longText = `start-${"x".repeat(220)}-end`;

    createLogger("content").warn("extracted", {
      page: {
        title: "Example",
        text: longText,
      },
    });

    const output = renderedConsoleArgs(warnSpy.mock.calls[0]);
    expect(output).toContain("Example");
    expect(output).not.toContain(longText);
    expect(output).not.toContain("-end");
  });
});
