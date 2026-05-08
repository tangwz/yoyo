import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/utils/logger";

function renderedConsoleArgs(call: unknown[]): string {
  return call
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("serializes circular arrays with a bounded marker", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const metadata: unknown[] = ["visible value"];
    metadata.push(metadata);

    createLogger("cycle").info("array", metadata);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("visible value");
    expect(output).toContain("[circular]");
  });

  it("serializes circular object graphs with a bounded marker", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const metadata: Record<string, unknown> = {
      visible: "safe value",
    };
    metadata.self = metadata;
    metadata.child = { parent: metadata };

    createLogger("cycle").info("object", metadata);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("safe value");
    expect(output).toContain("[circular]");
  });

  it("redacts common sensitive key variants", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const metadata = {
      Authorization: "Bearer private-token",
      token: "raw-token",
      secret: "shared-secret",
      password: "user-password",
      cookie: "session-cookie",
      api_key: "snake-api-key",
      APIKey: "pascal-api-key",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      sourceText: "private source",
      prompt: "private prompt",
      visible: "safe value",
    };

    createLogger("privacy").info("metadata", metadata);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("safe value");
    expect(output).not.toContain("Bearer private-token");
    expect(output).not.toContain("snake-api-key");
    expect(output).not.toContain("pascal-api-key");
    expect(output).not.toContain("access-token");
    expect(output).not.toContain("refresh-token");
    expect(output).not.toContain("private source");
    expect(output).not.toContain("private prompt");
  });

  it("serializes errors with safe diagnostics and redacts custom sensitive props", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("request failed") as Error & {
      apiKey?: string;
      code?: string;
      status?: number;
    };
    error.name = "ProviderError";
    error.code = "UPSTREAM_AUTH_FAILED";
    error.status = 401;
    error.apiKey = "sk-error-secret";

    createLogger("provider").error("failed", error);

    const output = renderedConsoleArgs(errorSpy.mock.calls[0]);
    expect(output).toContain("ProviderError");
    expect(output).toContain("request failed");
    expect(output).toContain("UPSTREAM_AUTH_FAILED");
    expect(output).toContain("401");
    expect(output).not.toContain("sk-error-secret");
    expect(output).not.toContain("stack");
  });
});
