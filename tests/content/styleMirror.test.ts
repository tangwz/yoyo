import { beforeEach, describe, expect, it } from "vitest";
import { applyMirroredStyle, createMirroredStyle } from "@/content/styleMirror";

describe("style mirroring", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("copies key computed styles without extension brand colors or opacity", () => {
    document.body.innerHTML = `
      <p
        id="source"
        style="
          color: rgb(20, 30, 40);
          font-family: Georgia, serif;
          font-size: 18px;
          font-weight: 700;
          font-style: italic;
          line-height: 28px;
          letter-spacing: 1px;
          text-align: justify;
          background-color: rgb(1, 2, 3);
          border-radius: 6px;
          padding: 8px 10px 12px 14px;
          margin-bottom: 20px;
        "
      >Text</p>
    `;
    const source = document.querySelector("#source") as HTMLElement;

    const style = createMirroredStyle(source);

    expect(style.color).toBe("rgb(20, 30, 40)");
    expect(style.fontSize).toBe("18px");
    expect(style.fontWeight).toBe("700");
    expect(style.fontStyle).toBe("italic");
    expect(style.lineHeight).toBe("28px");
    expect(style.letterSpacing).toBe("1px");
    expect(style.textAlign).toBe("justify");
    expect(style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(style.borderRadius).toBe("6px");
    expect(style.paddingTop).toBe("8px");
    expect(style.paddingRight).toBe("10px");
    expect(style.paddingBottom).toBe("12px");
    expect(style.paddingLeft).toBe("14px");
    expect(style.whiteSpace).toBe("pre-wrap");
    expect(style.marginTop).toBe("0.25em");
    expect(style.marginBottom).toBe("20px");
    expect(style.opacity).toBeUndefined();
    expect(Object.values(style)).not.toContain("#7c3aed");
    expect(Object.values(style)).not.toContain("rgb(124, 58, 237)");
  });

  it("applies mirrored style values to a target element", () => {
    document.body.innerHTML = `
      <p id="source" style="color: rgb(11, 22, 33); font-size: 17px; padding: 5px;">Text</p>
      <div id="target"></div>
    `;
    const source = document.querySelector("#source") as HTMLElement;
    const target = document.querySelector("#target") as HTMLElement;

    applyMirroredStyle(target, source);

    expect(target.style.color).toBe("rgb(11, 22, 33)");
    expect(target.style.fontSize).toBe("17px");
    expect(target.style.paddingTop).toBe("5px");
    expect(target.style.whiteSpace).toBe("pre-wrap");
    expect(target.style.opacity).toBe("");
  });
});
