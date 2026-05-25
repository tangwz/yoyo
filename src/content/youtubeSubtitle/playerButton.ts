export type YoutubeSubtitlePlayerButtonStatus =
  | "enabled"
  | "disabled"
  | "warning"
  | "loading";

export type YoutubeSubtitlePlayerButtonOptions = {
  controls: HTMLElement;
  status: YoutubeSubtitlePlayerButtonStatus;
  onToggle: () => void;
};

export type YoutubeSubtitlePlayerButtonUpdate = Partial<
  Pick<YoutubeSubtitlePlayerButtonOptions, "status" | "onToggle">
>;

export type YoutubeSubtitlePlayerButton = {
  element: HTMLButtonElement;
  update: (update: YoutubeSubtitlePlayerButtonUpdate) => void;
  destroy: () => void;
};

const mountedButtons = new WeakMap<HTMLElement, YoutubeSubtitlePlayerButton>();

class YoutubeSubtitlePlayerButtonHandle implements YoutubeSubtitlePlayerButton {
  readonly element: HTMLButtonElement;

  private readonly badge: HTMLSpanElement;
  private onToggle: () => void;
  private status: YoutubeSubtitlePlayerButtonStatus;

  constructor(options: YoutubeSubtitlePlayerButtonOptions) {
    this.onToggle = options.onToggle;
    this.status = options.status;
    this.element = document.createElement("button");
    this.badge = document.createElement("span");

    this.element.type = "button";
    this.element.dataset.yoyoYoutubeSubtitleButton = "true";
    this.element.className = "yoyo-youtube-subtitle-button notranslate";
    this.element.setAttribute("translate", "no");
    this.element.addEventListener("click", this.handleClick);
    Object.assign(this.element.style, {
      position: "relative",
      width: "28px",
      height: "28px",
      minWidth: "28px",
      margin: "0 4px",
      padding: "0",
      border: "1px solid rgba(255, 255, 255, 0.34)",
      borderRadius: "6px",
      background: "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)",
      color: "#f8fff9",
      fontSize: "16px",
      fontWeight: "700",
      lineHeight: "26px",
      textAlign: "center",
      cursor: "pointer",
      boxSizing: "border-box",
      verticalAlign: "middle",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 28px",
    });

    const glyph = document.createElement("span");
    glyph.textContent = "\u6587";
    glyph.setAttribute("aria-hidden", "true");
    Object.assign(glyph.style, {
      display: "block",
      transform: "translateY(-1px)",
      pointerEvents: "none",
    });

    this.badge.dataset.yoyoYoutubeSubtitleBadge = "true";
    this.badge.setAttribute("aria-hidden", "true");
    Object.assign(this.badge.style, {
      position: "absolute",
      top: "-3px",
      right: "-3px",
      width: "12px",
      height: "12px",
      borderRadius: "999px",
      border: "1px solid rgba(0, 0, 0, 0.55)",
      color: "#ffffff",
      fontSize: "9px",
      fontWeight: "800",
      lineHeight: "10px",
      textAlign: "center",
      boxSizing: "border-box",
      pointerEvents: "none",
    });

    this.element.append(glyph, this.badge);
    this.applyStatus();
  }

  update(update: YoutubeSubtitlePlayerButtonUpdate): void {
    if (update.onToggle) {
      this.onToggle = update.onToggle;
    }
    if (update.status) {
      this.status = update.status;
      this.applyStatus();
    }
  }

  destroy(): void {
    this.element.removeEventListener("click", this.handleClick);
    this.element.remove();
  }

  private readonly handleClick = (): void => {
    this.onToggle();
  };

  private applyStatus(): void {
    const presentation = statusPresentation[this.status];
    this.badge.textContent = presentation.symbol;
    this.badge.dataset.status = this.status;
    this.badge.style.background = presentation.badgeBackground;
    this.badge.style.color = presentation.badgeColor;
    this.element.title = `Yoyo subtitle translation: ${presentation.label}`;
    this.element.setAttribute(
      "aria-label",
      `Yoyo subtitle translation: ${presentation.label}`,
    );
  }
}

const statusPresentation: Record<
  YoutubeSubtitlePlayerButtonStatus,
  {
    label: string;
    symbol: string;
    badgeBackground: string;
    badgeColor: string;
  }
> = {
  enabled: {
    label: "enabled",
    symbol: "\u2713",
    badgeBackground: "#16a34a",
    badgeColor: "#ffffff",
  },
  disabled: {
    label: "disabled",
    symbol: "x",
    badgeBackground: "#dc2626",
    badgeColor: "#ffffff",
  },
  warning: {
    label: "warning",
    symbol: "!",
    badgeBackground: "#facc15",
    badgeColor: "#111827",
  },
  loading: {
    label: "loading",
    symbol: "\u2022",
    badgeBackground: "#6b7280",
    badgeColor: "#ffffff",
  },
};

export function mountYoutubeSubtitlePlayerButton(
  options: YoutubeSubtitlePlayerButtonOptions,
): YoutubeSubtitlePlayerButton {
  const existing = mountedButtons.get(options.controls);
  if (existing && existing.element.parentElement === options.controls) {
    existing.update({
      status: options.status,
      onToggle: options.onToggle,
    });
    return existing;
  }
  existing?.destroy();

  const button = new YoutubeSubtitlePlayerButtonHandle(options);
  const mountedButton = createMountedButton(options.controls, button);
  options.controls.append(button.element);
  mountedButtons.set(options.controls, mountedButton);

  return mountedButton;
}

function createMountedButton(
  controls: HTMLElement,
  button: YoutubeSubtitlePlayerButtonHandle,
): YoutubeSubtitlePlayerButton {
  const mountedButton: YoutubeSubtitlePlayerButton = {
    element: button.element,
    update: button.update.bind(button),
    destroy: () => {
      button.destroy();
      if (mountedButtons.get(controls) === mountedButton) {
        mountedButtons.delete(controls);
      }
    },
  };

  return mountedButton;
}
