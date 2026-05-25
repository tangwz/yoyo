import { beforeEach, describe, expect, it } from "vitest";
import { mountYoutubeSubtitleOverlay } from "@/content/youtubeSubtitle/overlay";

function createPlayer(): HTMLElement {
  const player = document.createElement("div");
  player.className = "html5-video-player";
  document.body.append(player);
  return player;
}

function mountedOverlay(player: HTMLElement): HTMLElement {
  const overlay = player.querySelector<HTMLElement>(
    '[data-yoyo-youtube-subtitle-overlay="true"]',
  );
  if (!overlay) {
    throw new Error("Expected subtitle overlay to be mounted.");
  }
  return overlay;
}

describe("mountYoutubeSubtitleOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts a notranslate pointer-transparent overlay inside the player", () => {
    const player = createPlayer();
    const overlay = mountYoutubeSubtitleOverlay({ player });

    expect(overlay.element.parentElement).toBe(player);
    expect(overlay.element.classList.contains("notranslate")).toBe(true);
    expect(overlay.element.getAttribute("translate")).toBe("no");
    expect(overlay.element.style.pointerEvents).toBe("none");
    expect(overlay.element.style.position).toBe("absolute");
  });

  it("renders bilingual subtitles with source above translation", () => {
    const player = createPlayer();
    const overlay = mountYoutubeSubtitleOverlay({ player });

    overlay.render({
      state: "translated",
      sourceText: "Hello world.",
      translatedText: "\u4f60\u597d\uff0c\u4e16\u754c\u3002",
    });

    const source = overlay.element.querySelector<HTMLElement>(
      '[data-yoyo-youtube-subtitle-source="true"]',
    );
    const translation = overlay.element.querySelector<HTMLElement>(
      '[data-yoyo-youtube-subtitle-translation="true"]',
    );

    expect(source?.textContent).toBe("Hello world.");
    expect(translation?.textContent).toBe("\u4f60\u597d\uff0c\u4e16\u754c\u3002");
    expect(source?.compareDocumentPosition(translation ?? source)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(overlay.element.hidden).toBe(false);
  });

  it("renders loading and failed states without hiding the source", () => {
    const player = createPlayer();
    const overlay = mountYoutubeSubtitleOverlay({ player });

    overlay.render({ state: "loading", sourceText: "Loading source." });

    expect(overlay.element.textContent).toContain("Loading source.");
    expect(
      overlay.element.querySelector(
        '[data-yoyo-youtube-subtitle-loading="true"]',
      ),
    ).not.toBeNull();

    overlay.render({
      state: "failed",
      sourceText: "Failed source.",
      errorText: "Translation unavailable",
    });

    expect(overlay.element.textContent).toContain("Failed source.");
    expect(overlay.element.textContent).toContain("Translation unavailable");
  });

  it("hides and destroys the overlay", () => {
    const player = createPlayer();
    const overlay = mountYoutubeSubtitleOverlay({ player });

    overlay.render({
      state: "translated",
      sourceText: "Visible",
      translatedText: "\u53ef\u89c1",
    });
    overlay.hide();

    expect(overlay.element.hidden).toBe(true);

    overlay.destroy();

    expect(
      player.querySelector('[data-yoyo-youtube-subtitle-overlay="true"]'),
    ).toBeNull();
  });

  it("sets relative positioning only when the player needs it", () => {
    const staticPlayer = createPlayer();
    const staticOverlay = mountYoutubeSubtitleOverlay({ player: staticPlayer });

    expect(staticPlayer.style.position).toBe("relative");

    staticOverlay.destroy();

    expect(staticPlayer.style.position).toBe("");

    const positionedPlayer = createPlayer();
    positionedPlayer.style.position = "absolute";

    mountYoutubeSubtitleOverlay({ player: positionedPlayer });

    expect(positionedPlayer.style.position).toBe("absolute");
  });

  it("mounts idempotently for a player instance", () => {
    const player = createPlayer();
    const first = mountYoutubeSubtitleOverlay({ player });
    const second = mountYoutubeSubtitleOverlay({ player });

    expect(first.element).toBe(second.element);
    expect(
      player.querySelectorAll('[data-yoyo-youtube-subtitle-overlay="true"]'),
    ).toHaveLength(1);
    expect(mountedOverlay(player)).toBe(first.element);
  });

  it("destroys stale overlay handles before remounting on the same player", () => {
    const player = createPlayer();
    const first = mountYoutubeSubtitleOverlay({ player });

    first.element.remove();
    const second = mountYoutubeSubtitleOverlay({ player });

    expect(second.element).not.toBe(first.element);
    expect(mountedOverlay(player)).toBe(second.element);

    second.destroy();

    expect(player.style.position).toBe("");
  });
});
