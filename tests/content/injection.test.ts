import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnchorRegistry } from "@/content/anchors";
import {
  applyTranslations,
  hideTranslations,
  removeTranslations,
  showTranslations,
} from "@/content/injection";

describe("translation injection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("injects, hides, shows, and removes translation nodes", () => {
    document.body.innerHTML = `<article><p id="source">Hello</p></article>`;
    const source = document.querySelector("#source") as HTMLElement;
    const anchors = new AnchorRegistry();
    anchors.set({ segmentId: "seg_1", sourceNode: source, taskId: "task-1" });

    applyTranslations(anchors, "task-1", [
      { segmentId: "seg_1", translatedText: "Bonjour" },
    ]);

    const injected = document.querySelector(
      "[data-yoyo-translation]",
    ) as HTMLElement;
    const inner = injected.querySelector(
      "[data-yoyo-translation-inner]",
    ) as HTMLElement;
    expect(injected.previousElementSibling).toBe(source);
    expect(injected.dataset.yoyoSegmentId).toBe("seg_1");
    expect(injected.dataset.yoyoTaskId).toBe("task-1");
    expect(inner.textContent).toBe("Bonjour");

    hideTranslations("task-1");
    expect(injected.dataset.yoyoHidden).toBe("true");
    expect(injected.style.display).toBe("none");

    showTranslations("task-1");
    expect(injected.dataset.yoyoHidden).toBeUndefined();
    expect(injected.style.display).toBe("");

    removeTranslations("task-1");
    expect(document.querySelector("[data-yoyo-translation]")).toBeNull();
  });

  it("replaces an existing inserted node for the same segment", () => {
    document.body.innerHTML = `<article><p id="source">Hello</p></article>`;
    const source = document.querySelector("#source") as HTMLElement;
    const anchors = new AnchorRegistry();
    anchors.set({ segmentId: "seg_1", sourceNode: source, taskId: "task-1" });

    applyTranslations(anchors, "task-1", [
      { segmentId: "seg_1", translatedText: "First" },
    ]);
    const first = document.querySelector("[data-yoyo-translation]");

    applyTranslations(anchors, "task-1", [
      { segmentId: "seg_1", translatedText: "Second" },
    ]);

    const all = document.querySelectorAll("[data-yoyo-translation]");
    expect(all).toHaveLength(1);
    expect(all[0]).not.toBe(first);
    expect(all[0].textContent).toBe("Second");
  });

  it("filters injection and visibility actions by task", () => {
    document.body.innerHTML = `
      <article>
        <p id="source-1">Hello</p>
        <p id="source-2">World</p>
      </article>
    `;
    const anchors = new AnchorRegistry();
    anchors.set({
      segmentId: "seg_1",
      sourceNode: document.querySelector("#source-1") as HTMLElement,
      taskId: "task-1",
    });
    anchors.set({
      segmentId: "seg_2",
      sourceNode: document.querySelector("#source-2") as HTMLElement,
      taskId: "task-2",
    });

    applyTranslations(anchors, "task-1", [
      { segmentId: "seg_1", translatedText: "One" },
      { segmentId: "seg_2", translatedText: "Two" },
    ]);
    applyTranslations(anchors, "task-2", [
      { segmentId: "seg_2", translatedText: "Two" },
    ]);

    expect(document.querySelectorAll("[data-yoyo-translation]")).toHaveLength(2);

    hideTranslations("task-1");
    expect(
      document.querySelector<HTMLElement>(
        '[data-yoyo-translation][data-yoyo-task-id="task-1"]',
      )?.style.display,
    ).toBe("none");
    expect(
      document.querySelector<HTMLElement>(
        '[data-yoyo-translation][data-yoyo-task-id="task-2"]',
      )?.style.display,
    ).toBe("");

    removeTranslations("task-1");
    expect(document.querySelectorAll("[data-yoyo-translation]")).toHaveLength(1);
    expect(
      document.querySelector("[data-yoyo-translation]")?.getAttribute(
        "data-yoyo-task-id",
      ),
    ).toBe("task-2");
  });

  it("uses text content instead of HTML injection", () => {
    document.body.innerHTML = `<article><p id="source">Hello</p></article>`;
    const source = document.querySelector("#source") as HTMLElement;
    const anchors = new AnchorRegistry();
    anchors.set({ segmentId: "seg_1", sourceNode: source, taskId: "task-1" });

    applyTranslations(anchors, "task-1", [
      { segmentId: "seg_1", translatedText: "<img src=x onerror=alert(1)>" },
    ]);

    const inner = document.querySelector(
      "[data-yoyo-translation-inner]",
    ) as HTMLElement;
    expect(inner.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(inner.querySelector("img")).toBeNull();
  });

  it("skips stale anchors without blocking the rest of the batch", () => {
    document.body.innerHTML = `
      <article>
        <p id="valid-source">Valid source</p>
      </article>
    `;
    const staleSource = document.createElement("p");
    staleSource.textContent = "Stale source";
    const staleInsert = vi
      .spyOn(staleSource, "insertAdjacentElement")
      .mockImplementation(() => {
        throw new Error("stale source should not be used for insertion");
      });
    const validSource = document.querySelector("#valid-source") as HTMLElement;
    const anchors = new AnchorRegistry();
    anchors.set({
      segmentId: "seg_1",
      sourceNode: staleSource,
      taskId: "task-1",
    });
    anchors.set({
      segmentId: "seg_2",
      sourceNode: validSource,
      taskId: "task-1",
    });

    expect(() => {
      applyTranslations(anchors, "task-1", [
        { segmentId: "seg_1", translatedText: "Skipped" },
        { segmentId: "seg_2", translatedText: "Injected" },
      ]);
    }).not.toThrow();

    const injected = document.querySelectorAll("[data-yoyo-translation]");
    expect(staleInsert).not.toHaveBeenCalled();
    expect(injected).toHaveLength(1);
    expect(injected[0].textContent).toBe("Injected");
    expect(injected[0].previousElementSibling).toBe(validSource);
  });
});
