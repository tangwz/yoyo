const mirroredProperties = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "color",
  "textAlign",
  "writingMode",
  "backgroundColor",
  "borderRadius",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const satisfies readonly (keyof CSSStyleDeclaration)[];

function toKebabCase(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function createMirroredStyle(
  sourceNode: Element,
): Partial<CSSStyleDeclaration> {
  const computed = window.getComputedStyle(sourceNode);
  const style: Partial<CSSStyleDeclaration> = {};

  for (const property of mirroredProperties) {
    style[property] = computed[property];
  }

  style.whiteSpace = "pre-wrap";
  style.marginTop = "0.25em";
  style.marginBottom = computed.marginBottom;

  return style;
}

export function applyMirroredStyle(
  target: HTMLElement,
  sourceNode: Element,
): void {
  const mirroredStyle = createMirroredStyle(sourceNode);

  for (const [property, value] of Object.entries(mirroredStyle)) {
    if (typeof value === "string" && value.length > 0) {
      target.style.setProperty(toKebabCase(property), value);
    }
  }
}
