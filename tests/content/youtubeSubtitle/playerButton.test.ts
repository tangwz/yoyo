import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mountYoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButtonStatus,
} from "@/content/youtubeSubtitle/playerButton";

function createControls(): HTMLElement {
  const controls = document.createElement("div");
  controls.className = "ytp-right-controls";
  document.body.append(controls);
  return controls;
}

function mountedButton(controls: HTMLElement): HTMLButtonElement {
  const button = controls.querySelector<HTMLButtonElement>(
    '[data-yoyo-youtube-subtitle-button="true"]',
  );
  if (!button) {
    throw new Error("Expected subtitle button to be mounted.");
  }
  return button;
}

describe("mountYoutubeSubtitlePlayerButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts one compact accessible button per controls container", () => {
    const controls = createControls();
    const first = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "disabled",
      onToggle: vi.fn(),
    });
    const second = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: vi.fn(),
    });

    expect(first.element).toBe(second.element);
    expect(
      controls.querySelectorAll('[data-yoyo-youtube-subtitle-button="true"]'),
    ).toHaveLength(1);
    expect(first.element.type).toBe("button");
    expect(first.element.textContent).toContain("\u6587");
    expect(first.element.getAttribute("aria-label")).toContain("enabled");
    expect(first.element.title).toContain("enabled");
  });

  it.each([
    ["enabled", "\u2713", "enabled"],
    ["disabled", "x", "disabled"],
    ["warning", "!", "warning"],
    ["loading", "\u2022", "loading"],
  ] satisfies Array<[YoutubeSubtitlePlayerButtonStatus, string, string]>)(
    "updates the %s status badge",
    (status, symbol, labelText) => {
      const controls = createControls();
      const button = mountYoutubeSubtitlePlayerButton({
        controls,
        status: "disabled",
        onToggle: vi.fn(),
      });

      button.update({ status });

      const badge = button.element.querySelector<HTMLElement>(
        '[data-yoyo-youtube-subtitle-badge="true"]',
      );
      expect(badge?.textContent).toBe(symbol);
      expect(badge?.dataset.status).toBe(status);
      expect(button.element.getAttribute("aria-label")).toContain(labelText);
      expect(button.element.title).toContain(labelText);
    },
  );

  it("updates the click handler without duplicating listeners", () => {
    const controls = createControls();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const button = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "disabled",
      onToggle: firstHandler,
    });

    button.update({ onToggle: secondHandler });
    button.element.click();

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);

    mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: firstHandler,
    });
    mountedButton(controls).click();

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(
      controls.querySelectorAll('[data-yoyo-youtube-subtitle-button="true"]'),
    ).toHaveLength(1);
  });

  it("destroys only its mounted button and allows remounting", () => {
    const controls = createControls();
    const mounted = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: vi.fn(),
    });

    mounted.destroy();

    expect(
      controls.querySelector('[data-yoyo-youtube-subtitle-button="true"]'),
    ).toBeNull();

    const remounted = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "disabled",
      onToggle: vi.fn(),
    });
    expect(remounted.element).not.toBe(mounted.element);
    expect(mountedButton(controls)).toBe(remounted.element);
  });
});
