import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mountYoutubeSubtitlePlayerButton,
  type YoutubeSubtitlePlayerButtonStatus,
} from "@/content/youtubeSubtitle/playerButton";

function createControls(): HTMLElement {
  const controls = document.createElement("div");
  controls.className = "ytp-right-controls";

  const settings = document.createElement("button");
  settings.className = "ytp-settings-button";
  settings.type = "button";

  const fullscreen = document.createElement("button");
  fullscreen.className = "ytp-fullscreen-button";
  fullscreen.type = "button";

  controls.append(settings, fullscreen);
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

  it("mounts after native controls so it does not displace other extensions", () => {
    const controls = createControls();
    const nativeLastControl = controls.lastElementChild;

    const button = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: vi.fn(),
    });

    expect(button.element.previousElementSibling).toBe(nativeLastControl);
    expect(controls.lastElementChild).toBe(button.element);
  });

  it("does not displace buttons injected by other extensions", () => {
    const controls = createControls();

    // Simulate another extension (e.g. immersive-translate) injecting a button
    const otherExtButton = document.createElement("button");
    otherExtButton.className = "immersive-translate-button";
    otherExtButton.type = "button";
    controls.append(otherExtButton);

    const nativeFirst = controls.firstElementChild;

    const button = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: vi.fn(),
    });

    // Other extension button should remain in place
    expect(controls.querySelector(".immersive-translate-button")).toBe(otherExtButton);
    // Native controls should still come first
    expect(controls.firstElementChild).toBe(nativeFirst);
    // Yoyo button should be appended after everything else
    expect(controls.lastElementChild).toBe(button.element);
  });

  it("uses a YouTube-sized control shell with centered logo artwork", () => {
    const controls = createControls();

    const button = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: vi.fn(),
    });

    const logo = button.element.querySelector<HTMLElement>(
      '[data-yoyo-youtube-subtitle-logo="true"]',
    );

    expect(button.element.classList.contains("ytp-button")).toBe(true);
    expect(button.element.style.width).toBe("48px");
    expect(button.element.style.height).toBe("48px");
    expect(button.element.style.margin).toBe("0px");
    expect(button.element.style.border).toBe("0px");
    expect(button.element.style.background).toBe("transparent");
    expect(logo).not.toBeNull();
    expect(logo?.style.width).toBe("28px");
    expect(logo?.style.height).toBe("28px");
    expect(logo?.style.margin).toBe("auto");
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

  it("destroys stale button handles before remounting on the same controls", () => {
    const controls = createControls();
    const staleHost = document.createElement("div");
    document.body.append(staleHost);
    const staleHandler = vi.fn();
    const nextHandler = vi.fn();
    const first = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "enabled",
      onToggle: staleHandler,
    });

    staleHost.append(first.element);
    const second = mountYoutubeSubtitlePlayerButton({
      controls,
      status: "disabled",
      onToggle: nextHandler,
    });

    expect(second.element).not.toBe(first.element);
    expect(mountedButton(controls)).toBe(second.element);
    first.element.click();
    second.element.click();

    expect(staleHandler).not.toHaveBeenCalled();
    expect(nextHandler).toHaveBeenCalledTimes(1);
  });
});
