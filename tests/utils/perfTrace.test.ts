import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measurePerf,
  tracePerf,
  type PerfTraceMetadata,
} from "@/utils/perfTrace";

function renderedConsoleArgs(call: unknown[]): string {
  return call
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

describe("perfTrace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not log outside development builds", () => {
    vi.stubEnv("DEV", false);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      taskId: "task-1",
      sourceText: "private text",
    } as PerfTraceMetadata & { sourceText: string });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs allowlisted metadata in development builds", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      taskId: "task-1",
      batchId: "batch-1",
      providerType: "openai-compatible",
      model: "gpt-4.1-mini",
      segmentCount: 2,
      sourceCharCount: 25,
      durationMs: 12.345,
    });

    expect(infoSpy).toHaveBeenCalledWith("[yoyo:perf] llm.request.start", {
      taskId: "task-1",
      batchId: "batch-1",
      providerType: "openai-compatible",
      model: "gpt-4.1-mini",
      segmentCount: 2,
      sourceCharCount: 25,
      durationMs: 12.35,
    });
  });

  it("redacts non-allowlisted and sensitive fields", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf("llm.request.start", {
      prompt: "private prompt",
      sourceText: "private source",
      translatedText: "private translation",
      apiKey: "sk-secret",
      authorization: "Bearer secret",
      safe: "not allowlisted",
      outputCharCount: 100,
    } as PerfTraceMetadata & Record<string, unknown>);

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("outputCharCount");
    expect(output).toContain("100");
    expect(output).not.toContain("private prompt");
    expect(output).not.toContain("private source");
    expect(output).not.toContain("private translation");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("not allowlisted");
  });

  it("drops non-primitive allowlisted metadata values", () => {
    vi.stubEnv("DEV", true);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    tracePerf(
      "llm.request.start",
      {
        model: { apiKey: "sk-secret" },
        status: Number.NaN,
        reason: ["private reason"],
        taskId: () => "task-1",
        outputCharCount: 100,
      } as unknown as PerfTraceMetadata & Record<string, unknown>,
    );

    const output = renderedConsoleArgs(infoSpy.mock.calls[0]);
    expect(output).toContain("outputCharCount");
    expect(output).toContain("100");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("private reason");
    expect(output).not.toContain("task-1");
    expect(output).not.toContain("NaN");
  });

  it("records success and duration for measured operations", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125.678);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      measurePerf(
        "content.applyTranslations.done",
        { itemCount: 3 },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    expect(infoSpy).toHaveBeenCalledWith(
      "[yoyo:perf] content.applyTranslations.done",
      {
        itemCount: 3,
        durationMs: 25.68,
        success: true,
      },
    );
  });

  it("records normalized error metadata and rethrows measured failures", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(performance, "now").mockReturnValueOnce(200).mockReturnValueOnce(250);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = new Error("failed") as Error & { code?: string; status?: number };
    error.name = "ProviderError";
    error.code = "rateLimited";
    error.status = 429;

    await expect(
      measurePerf("llm.request.error", { model: "gpt-4.1-mini" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(infoSpy).toHaveBeenCalledWith("[yoyo:perf] llm.request.error", {
      model: "gpt-4.1-mini",
      durationMs: 50,
      success: false,
      errorName: "ProviderError",
      errorCode: "rateLimited",
      status: 429,
    });
  });
});
