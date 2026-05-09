import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRuntimeMessageListener } from "@/messaging/runtime";

const { addListener } = vi.hoisted(() => ({
  addListener: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      onMessage: {
        addListener,
      },
    },
  },
}));

type TestRequest = { type: "ping" };
type TestResponse =
  | { type: "pong"; value: string }
  | { type: "testError"; message: string };

describe("runtime messaging", () => {
  beforeEach(() => {
    addListener.mockReset();
  });

  it("keeps the runtime channel open for async responses", () => {
    addRuntimeMessageListener<TestRequest, TestResponse>(
      async () => ({ type: "pong", value: "ok" }),
      {
        createErrorResponse: (error) => ({
          type: "testError",
          message: String(error),
        }),
      },
    );

    const listener = addListener.mock.calls[0]?.[0];
    const keepChannelOpen = listener(
      { type: "ping" },
      {},
      vi.fn(),
    );

    expect(keepChannelOpen).toBe(true);
  });

  it("sends the handler response", async () => {
    const response = { type: "pong", value: "ok" } satisfies TestResponse;
    const sendResponse = vi.fn();

    addRuntimeMessageListener<TestRequest, TestResponse>(
      async () => response,
      {
        createErrorResponse: (error) => ({
          type: "testError",
          message: String(error),
        }),
      },
    );

    const listener = addListener.mock.calls[0]?.[0];
    listener({ type: "ping" }, {}, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(response);
    });
  });

  it("sends caller-provided error responses for rejected handlers", async () => {
    const sendResponse = vi.fn();

    addRuntimeMessageListener<TestRequest, TestResponse>(
      async () => {
        throw new Error("failed");
      },
      {
        createErrorResponse: (error) => ({
          type: "testError",
          message: error instanceof Error ? error.message : String(error),
        }),
      },
    );

    const listener = addListener.mock.calls[0]?.[0];
    listener({ type: "ping" }, {}, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        type: "testError",
        message: "failed",
      });
    });
  });
});
