import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
} from "@/messaging/contracts";

describe("messaging contracts", () => {
  it("supports collecting page segments from the content entrypoint", () => {
    const request = {
      type: "collectSegments",
      taskId: "task-1",
    } satisfies ContentRequest;

    expect(request).toEqual({
      type: "collectSegments",
      taskId: "task-1",
    });
  });

  it("covers content entrypoint request variants", () => {
    const requests = [
      { type: "estimatePage" },
      { type: "collectSegments", taskId: "task-1" },
      { type: "applyTranslations", taskId: "task-1", items: [] },
      { type: "hideTranslations", taskId: "task-1" },
      { type: "showTranslations", taskId: "task-1" },
      { type: "removeTranslations", taskId: "task-1" },
      { type: "getPageRuntimeState" },
    ] satisfies ContentRequest[];

    expect(requests.map((request) => request.type)).toEqual([
      "estimatePage",
      "collectSegments",
      "applyTranslations",
      "hideTranslations",
      "showTranslations",
      "removeTranslations",
      "getPageRuntimeState",
    ]);
  });

  it("keeps content error responses available to runtime handlers", () => {
    const response = {
      type: "contentError",
      message: "Failed to handle message.",
    } satisfies ContentResponse;

    expectTypeOf(response).toMatchTypeOf<ContentResponse>();
    expect(response.message).toBe("Failed to handle message.");
  });

  it("supports querying provider configuration state from the popup", () => {
    const request = { type: "getProviderStatus" } satisfies BackgroundRequest;
    const response = {
      type: "providerStatus",
      configured: false,
      providerLabel: "未配置翻译服务",
    } satisfies BackgroundResponse;

    expect(request.type).toBe("getProviderStatus");
    expect(response.configured).toBe(false);
  });
});
