import { describe, expect, it } from "vitest";
import { isTerminalTaskState } from "@/translation/types";

describe("translation task types", () => {
  it("classifies terminal task states", () => {
    expect(isTerminalTaskState("completed")).toBe(true);
    expect(isTerminalTaskState("completedWithErrors")).toBe(true);
    expect(isTerminalTaskState("cancelled")).toBe(true);
    expect(isTerminalTaskState("failed")).toBe(true);
    expect(isTerminalTaskState("collecting")).toBe(false);
    expect(isTerminalTaskState("translating")).toBe(false);
  });
});
