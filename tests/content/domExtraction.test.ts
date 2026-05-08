import { beforeEach, describe, expect, it } from "vitest";
import { collectPageSegments } from "@/content/domExtraction";
import { isPageUrlSupported } from "@/content/domEligibility";

describe("collectPageSegments", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts leaf readable blocks without parent duplicates", async () => {
    document.body.innerHTML = `
      <main>
        <div>
          <p>First paragraph.</p>
          <p>Second paragraph.</p>
        </div>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(result.segments.map((segment) => segment.pathHint)).toEqual([
      "main:nth-child(1) > div:nth-child(1) > p:nth-child(1)",
      "main:nth-child(1) > div:nth-child(1) > p:nth-child(2)",
    ]);
    expect(result.anchors.get("seg_1")?.sourceNode).toBe(
      document.querySelector("p"),
    );
  });

  it("orders segments from 1 in DOM reading order", async () => {
    document.body.innerHTML = `
      <article>
        <h1>Page title</h1>
        <p>First paragraph.</p>
        <ul>
          <li>First item.</li>
          <li>Second item.</li>
        </ul>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(
      result.segments.map(({ id, order, sourceText, kind }) => ({
        id,
        order,
        sourceText,
        kind,
      })),
    ).toEqual([
      { id: "seg_1", order: 1, sourceText: "Page title", kind: "heading" },
      {
        id: "seg_2",
        order: 2,
        sourceText: "First paragraph.",
        kind: "paragraph",
      },
      { id: "seg_3", order: 3, sourceText: "First item.", kind: "listItem" },
      { id: "seg_4", order: 4, sourceText: "Second item.", kind: "listItem" },
    ]);
  });

  it("preserves inline child punctuation spacing", async () => {
    document.body.innerHTML = `
      <article>
        <p>Hello <strong>world</strong>.</p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Hello world.",
    ]);
  });

  it("does not merge nested list items into a parent list item segment", async () => {
    document.body.innerHTML = `
      <article>
        <ul>
          <li>
            Parent item
            <ul>
              <li>Nested child item.</li>
            </ul>
          </li>
          <li>Sibling item.</li>
        </ul>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Nested child item.",
      "Sibling item.",
    ]);
  });

  it("skips non-readable and extension-owned nodes", async () => {
    document.body.innerHTML = `
      <article>
        <p>Readable paragraph.</p>
        <pre>const x = 1;</pre>
        <code>inlineCode()</code>
        <table><tr><td>Table text</td></tr></table>
        <form><textarea>Form text</textarea><button>Button text</button></form>
        <svg><text>SVG text</text></svg>
        <iframe></iframe>
        <p hidden>Hidden text</p>
        <p aria-hidden="true">Aria hidden text</p>
        <p style="display: none;">Display hidden text</p>
        <p style="visibility: hidden;">Visibility hidden text</p>
        <p contenteditable="true">Editable text</p>
        <div data-yoyo-translation>Injected text</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Readable paragraph.",
    ]);
  });

  it("extracts generic readable blocks only when they have no readable child", async () => {
    const longText =
      "This standalone block has enough normalized text to be useful for translation extraction.";
    document.body.innerHTML = `
      <main>
        <section>${longText}</section>
        <section>
          <p>Child paragraph should win.</p>
        </section>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      longText,
      "Child paragraph should win.",
    ]);
  });

  it("does not extract a generic parent from skipped subtree text", async () => {
    const skippedLongText =
      "This skipped subtree contains enough text to pass the generic block extraction threshold, but it must not create a parent segment.";
    document.body.innerHTML = `
      <article>
        <table><tr><td>${skippedLongText}</td></tr></table>
        <code>${skippedLongText}</code>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments).toEqual([]);
  });

  it("does not extract form text as a generic segment", async () => {
    const formText =
      "This form label contains enough readable prose to pass the generic extraction threshold, but forms must be skipped.";
    document.body.innerHTML = `
      <article>
        <form>
          <label>${formText}</label>
        </form>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments).toEqual([]);
  });

  it("does not include hidden or extension-owned text in generic source text", async () => {
    const visibleText =
      "This visible generic block text is long enough to be translated without relying on skipped descendant content.";
    const skippedLongText =
      "This hidden extension translation text is much longer and should never appear in extracted source text.";
    document.body.innerHTML = `
      <article>
        <section>
          ${visibleText}
          <span hidden>${skippedLongText}</span>
          <span data-yoyo-translation>${skippedLongText}</span>
        </section>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      visibleText,
    ]);
  });
});

describe("isPageUrlSupported", () => {
  it("rejects browser and local schemes while allowing web pages", () => {
    expect(isPageUrlSupported("chrome://extensions")).toBe(false);
    expect(isPageUrlSupported("edge://settings")).toBe(false);
    expect(isPageUrlSupported("about:blank")).toBe(false);
    expect(isPageUrlSupported("chrome-extension://abc/page.html")).toBe(false);
    expect(isPageUrlSupported("file:///tmp/page.html")).toBe(false);
    expect(isPageUrlSupported("https://example.com/article")).toBe(true);
    expect(isPageUrlSupported("not a url")).toBe(false);
  });
});
