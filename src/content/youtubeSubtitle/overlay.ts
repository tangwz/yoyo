export type YoutubeSubtitleOverlayOptions = {
  player: HTMLElement;
};

export type YoutubeSubtitleOverlayRenderState =
  | {
      state: "translated";
      sourceText: string;
      translatedText: string;
    }
  | {
      state: "loading";
      sourceText: string;
    }
  | {
      state: "failed";
      sourceText: string;
      errorText?: string;
    };

export type YoutubeSubtitleOverlay = {
  element: HTMLElement;
  render: (state: YoutubeSubtitleOverlayRenderState) => void;
  hide: () => void;
  destroy: () => void;
};

const mountedOverlays = new WeakMap<HTMLElement, YoutubeSubtitleOverlay>();

class YoutubeSubtitleOverlayHandle implements YoutubeSubtitleOverlay {
  readonly element: HTMLElement;

  private readonly player: HTMLElement;
  private readonly originalInlinePosition: string;
  private readonly ownsPlayerPosition: boolean;

  constructor(options: YoutubeSubtitleOverlayOptions) {
    this.player = options.player;
    this.originalInlinePosition = options.player.style.position;
    this.ownsPlayerPosition = ensurePositionedPlayer(options.player);
    this.element = document.createElement("div");
    this.element.dataset.yoyoYoutubeSubtitleOverlay = "true";
    this.element.className = "yoyo-youtube-subtitle-overlay notranslate";
    this.element.setAttribute("translate", "no");
    this.element.hidden = true;

    Object.assign(this.element.style, {
      position: "absolute",
      left: "50%",
      bottom: "calc(10% + env(safe-area-inset-bottom, 0px))",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      maxWidth: "min(82%, 920px)",
      minWidth: "120px",
      padding: "7px 12px 8px",
      borderRadius: "7px",
      background: "rgba(0, 0, 0, 0.58)",
      boxShadow: "0 2px 12px rgba(0, 0, 0, 0.28)",
      color: "#ffffff",
      fontFamily:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: "15px",
      lineHeight: "1.35",
      textAlign: "center",
      textShadow: "0 1px 1px rgba(0, 0, 0, 0.8)",
      pointerEvents: "none",
      boxSizing: "border-box",
      overflow: "hidden",
    });
  }

  render(state: YoutubeSubtitleOverlayRenderState): void {
    this.element.replaceChildren();
    this.element.append(createLine("source", state.sourceText));

    if (state.state === "translated") {
      this.element.append(createLine("translation", state.translatedText));
    } else if (state.state === "loading") {
      this.element.append(createLoadingLine());
    } else {
      this.element.append(
        createLine("translation", state.errorText ?? "Translation unavailable"),
      );
    }

    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  destroy(): void {
    this.element.remove();
    if (
      this.ownsPlayerPosition &&
      this.player.style.position === "relative" &&
      this.player.dataset.yoyoYoutubeSubtitlePositioned === "true"
    ) {
      this.player.style.position = this.originalInlinePosition;
      delete this.player.dataset.yoyoYoutubeSubtitlePositioned;
    }
  }
}

export function mountYoutubeSubtitleOverlay(
  options: YoutubeSubtitleOverlayOptions,
): YoutubeSubtitleOverlay {
  const existing = mountedOverlays.get(options.player);
  if (existing && existing.element.parentElement === options.player) {
    return existing;
  }

  const overlay = new YoutubeSubtitleOverlayHandle(options);
  const mountedOverlay = createMountedOverlay(options.player, overlay);
  options.player.append(overlay.element);
  mountedOverlays.set(options.player, mountedOverlay);

  return mountedOverlay;
}

function createMountedOverlay(
  player: HTMLElement,
  overlay: YoutubeSubtitleOverlayHandle,
): YoutubeSubtitleOverlay {
  const mountedOverlay: YoutubeSubtitleOverlay = {
    element: overlay.element,
    render: overlay.render.bind(overlay),
    hide: overlay.hide.bind(overlay),
    destroy: () => {
      overlay.destroy();
      if (mountedOverlays.get(player) === mountedOverlay) {
        mountedOverlays.delete(player);
      }
    },
  };

  return mountedOverlay;
}

function ensurePositionedPlayer(player: HTMLElement): boolean {
  const computedPosition = getComputedStyle(player).position;
  const needsPosition =
    player.style.position === "" &&
    (computedPosition === "" || computedPosition === "static");

  if (!needsPosition) {
    return false;
  }

  player.style.position = "relative";
  player.dataset.yoyoYoutubeSubtitlePositioned = "true";
  return true;
}

function createLine(
  kind: "source" | "translation",
  text: string,
): HTMLDivElement {
  const line = document.createElement("div");
  line.textContent = text;
  line.dataset[
    kind === "source"
      ? "yoyoYoutubeSubtitleSource"
      : "yoyoYoutubeSubtitleTranslation"
  ] = "true";

  Object.assign(line.style, {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
    whiteSpace: "normal",
    wordBreak: "break-word",
  });

  if (kind === "source") {
    Object.assign(line.style, {
      color: "#ffffff",
      fontWeight: "600",
    });
  } else {
    Object.assign(line.style, {
      marginTop: "2px",
      color: "#bbf7d0",
      fontWeight: "500",
    });
  }

  return line;
}

function createLoadingLine(): HTMLDivElement {
  const line = createLine("translation", "\u2026");
  line.dataset.yoyoYoutubeSubtitleLoading = "true";
  Object.assign(line.style, {
    color: "rgba(229, 231, 235, 0.72)",
    fontWeight: "500",
  });
  return line;
}
