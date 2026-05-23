import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPageSegments } from "@/content/domExtraction";
import { isPageUrlSupported } from "@/content/domEligibility";

describe("collectPageSegments", () => {
  const originalInnerHeight = window.innerHeight;
  const originalDocumentLanguage = document.documentElement.getAttribute("lang");
  const originalBodyLanguage = document.body.getAttribute("lang");

  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    if (originalDocumentLanguage === null) {
      document.documentElement.removeAttribute("lang");
    } else {
      document.documentElement.setAttribute("lang", originalDocumentLanguage);
    }
    if (originalBodyLanguage === null) {
      document.body.removeAttribute("lang");
    } else {
      document.body.setAttribute("lang", originalBodyLanguage);
    }
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

  it("marks segment priority from viewport proximity", async () => {
    document.body.innerHTML = `
      <article>
        <p id="visible">Visible paragraph.</p>
        <p id="near">Near paragraph.</p>
        <p id="far">Far paragraph.</p>
      </article>
    `;

    const rects: Record<string, Partial<DOMRect>> = {
      visible: { top: 10, bottom: 30 },
      near: { top: 180, bottom: 210 },
      far: { top: 420, bottom: 450 },
    };

    for (const [id, rect] of Object.entries(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rect.top ?? 0,
          top: rect.top ?? 0,
          bottom: rect.bottom ?? 0,
          left: 0,
          right: 100,
          width: 100,
          height: (rect.bottom ?? 0) - (rect.top ?? 0),
          toJSON: () => ({}),
        }) as DOMRect;
    }

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => [segment.id, segment.priority])).toEqual([
      ["seg_1", "viewport"],
      ["seg_2", "nearViewport"],
      ["seg_3", "normal"],
    ]);
  });

  it("can collect only viewport and near-viewport segments", async () => {
    document.body.innerHTML = `
      <article>
        <p id="visible">Visible paragraph.</p>
        <p id="near">Near paragraph.</p>
        <p id="far">Far paragraph.</p>
      </article>
    `;

    const rects: Record<string, Partial<DOMRect>> = {
      visible: { top: 10, bottom: 30 },
      near: { top: 180, bottom: 210 },
      far: { top: 420, bottom: 450 },
    };

    for (const [id, rect] of Object.entries(rects)) {
      const element = document.querySelector(`#${id}`) as HTMLElement;
      element.getBoundingClientRect = () =>
        ({
          x: 0,
          y: rect.top ?? 0,
          top: rect.top ?? 0,
          bottom: rect.bottom ?? 0,
          left: 0,
          right: 100,
          width: 100,
          height: (rect.bottom ?? 0) - (rect.top ?? 0),
          toJSON: () => ({}),
        }) as DOMRect;
    }

    const result = await collectPageSegments("task-1", { visibleRangeOnly: true });

    expect(result.segments.map((segment) => [segment.id, segment.priority])).toEqual([
      ["seg_1", "viewport"],
      ["seg_2", "nearViewport"],
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

  it("keeps normal article inline numeric spans", async () => {
    document.body.innerHTML = `
      <article>
        <p>Revenue in <span>2024</span> grew.</p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Revenue in 2024 grew.",
    ]);
  });

  it("keeps normal article generic numeric spans", async () => {
    const sourceText =
      "Revenue in 2024 grew because the platform reduced operational complexity across multiple product teams.";
    document.body.innerHTML = `
      <article>
        <section>
          Revenue in <span>2024</span> grew because the platform reduced operational complexity across multiple product teams.
        </section>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      sourceText,
    ]);
  });

  it("keeps article header headings and body text", async () => {
    document.body.innerHTML = `
      <article>
        <header><h1>Article title</h1></header>
        <p>Article body.</p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(
      result.segments.map(({ sourceText, kind }) => ({ sourceText, kind })),
    ).toEqual([
      { sourceText: "Article title", kind: "heading" },
      { sourceText: "Article body.", kind: "paragraph" },
    ]);
  });

  it("keeps meaningful article footer and nav text", async () => {
    document.body.innerHTML = `
      <article>
        <p>Article body.</p>
        <footer>
          <p>Article footer note.</p>
        </footer>
        <nav>
          <p>Article source index.</p>
        </nav>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
      "Article footer note.",
      "Article source index.",
    ]);
  });

  it("does not extract weak language roots from navigation outside an article", async () => {
    document.body.innerHTML = `
      <nav><span lang="en">Home</span></nav>
      <article><p>Article body.</p></article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
    ]);
  });

  it("does not extract weak direction roots from sidebars outside an article", async () => {
    document.body.innerHTML = `
      <article><p>Article body.</p></article>
      <aside><span dir="auto">Related</span></aside>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
    ]);
  });

  it("does not extract nested weak language roots from article navigation", async () => {
    document.body.innerHTML = `
      <article>
        <nav><span lang="en">Home</span></nav>
        <p>Article body.</p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
    ]);
  });

  it("does not extract nested weak direction roots from article footer chrome", async () => {
    document.body.innerHTML = `
      <article>
        <p>Article body.</p>
        <footer><span dir="auto">Related</span></footer>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
    ]);
  });

  it("does not extract long nested weak language roots from article header chrome", async () => {
    const headerChrome =
      "This language-marked header chrome is intentionally long enough to pass the generic threshold, but it should not be extracted as article content.";
    document.body.innerHTML = `
      <article>
        <header>
          <div lang="en">${headerChrome}</div>
        </header>
        <p>Article body.</p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Article body.",
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
      "Parent item",
      "Nested child item.",
      "Sibling item.",
    ]);
    expect(result.segments.map((segment) => segment.kind)).toEqual([
      "listItem",
      "listItem",
      "listItem",
    ]);
    expect(result.anchors.get("seg_1")?.sourceNode.tagName).toBe("LI");
  });

  it("does not duplicate nested list parent text wrapped in a readable child", async () => {
    document.body.innerHTML = `
      <article>
        <ul>
          <li>
            <p>Parent paragraph.</p>
            <ul>
              <li>Nested child item.</li>
            </ul>
          </li>
        </ul>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Parent paragraph.",
      "Nested child item.",
    ]);
    expect(result.anchors.get("seg_1")?.sourceNode.tagName).toBe("LI");
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
        <aside data-yoyo-extension="summary-panel">Summary panel text</aside>
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

  it("prefers article roots over enclosing main on ordinary article pages", async () => {
    document.body.innerHTML = `
      <main>
        <article><p>Primary article body.</p></article>
        <aside><p>Related card should not be extracted.</p></aside>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Primary article body.",
    ]);
  });

  it("falls back to body when only weak language roots are discovered", async () => {
    const bodyText =
      "This normal body section should still be discovered even when a small language marked sidebar appears first.";
    document.body.innerHTML = `
      <aside lang="en">Tiny label</aside>
      <section>${bodyText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toContain(
      bodyText,
    );
  });

  it("preserves body reading order when weak page chrome roots need fallback", async () => {
    const bodyText =
      "This normal body section is long enough to pass generic extraction and appears first in DOM.";
    document.body.innerHTML = `
      <section>${bodyText}</section>
      <aside lang="en">Tiny label</aside>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("falls back to body when only weak path and editable hints are discovered", async () => {
    const bodyText =
      "This normal body section should still be discovered even when path and editable hints appear first.";
    document.body.innerHTML = `
      <div data-path="/compose/thread">Thread label</div>
      <div contenteditable="true">Draft composer text.</div>
      <section>${bodyText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("uses editable hints to discover surrounding readable content", async () => {
    const bodyText =
      "Readable content near an editor should be discovered without extracting active draft text.";
    document.body.innerHTML = `
      <main>
        <p>Main article text.</p>
      </main>
      <section>
        <div contenteditable="true">Draft composer text.</div>
        <p>${bodyText}</p>
      </section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Main article text.",
      bodyText,
    ]);
  });

  it("keeps promoted editable hint roots weak for body fallback", async () => {
    const bodyText =
      "Sibling body content should still be discovered when an editable composer is nested inside a sidebar.";
    document.body.innerHTML = `
      <aside>
        <div contenteditable="true">Draft composer text.</div>
      </aside>
      <section>${bodyText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("keeps editable-only article roots weak for body fallback", async () => {
    const bodyText =
      "Sibling body content should still be discovered when an editable composer is inside an article wrapper.";
    document.body.innerHTML = `
      <article>
        <div contenteditable="true">Draft composer text.</div>
      </article>
      <section>${bodyText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("keeps nested editable-only article roots weak for body fallback", async () => {
    const bodyText =
      "Sibling body content should still be discovered when an editable composer is nested inside an article wrapper.";
    document.body.innerHTML = `
      <article>
        <div>
          <div contenteditable="true">Draft composer text.</div>
        </div>
      </article>
      <section>${bodyText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
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
          <span data-yoyo-extension="summary-panel">${skippedLongText}</span>
        </section>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      visibleText,
    ]);
  });

  it("extracts X-like tweet text from information-feed roots", async () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="tweet">
          <div>
            <a href="/author">Terence</a>
            <span>@terence</span>
            <time>1h</time>
          </div>
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Shipping reliable software is mostly about</span>
            <span> reducing accidental complexity.</span>
          </div>
          <div role="group" aria-label="Post actions">
            <button>Reply</button>
            <button>Repost</button>
            <button>Like</button>
          </div>
        </article>
        <article data-testid="tweet">
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Short tweet text should still translate.</span>
          </div>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Shipping reliable software is mostly about reducing accidental complexity.",
      "Short tweet text should still translate.",
    ]);
    expect(result.segments.map((segment) => segment.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("keeps numeric spans inside tweet text", async () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="tweet">
          <div data-testid="tweetText">
            <span>Revenue in </span>
            <span>2024</span>
            <span> grew.</span>
          </div>
          <span>42</span>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Revenue in 2024 grew.",
    ]);
  });

  it("skips dir-auto header chrome when tweet text exists", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div>
          <span dir="auto">Terence</span>
          <span dir="auto">@handle</span>
        </div>
        <div data-testid="tweetText">Actual tweet body.</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("skips long dir-auto header chrome when tweet text exists", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div>
          <span dir="auto">
            This display name is intentionally long enough to pass the generic text threshold and should still be treated as feed chrome.
          </span>
        </div>
        <div data-testid="tweetText">Actual tweet body.</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("skips direct readable header chrome when tweet text exists", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <p>Terence <span>@terence</span> <span>1h</span></p>
        <div data-testid="tweetText">Actual tweet body.</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("skips bare direct readable display name when tweet text exists", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <p>Terence</p>
        <div data-testid="tweetText">Actual tweet body.</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("keeps numeric spans inside fallback dir-auto tweet body", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div dir="auto">
          Revenue in <span>2024</span> grew.
        </div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Revenue in 2024 grew.",
    ]);
  });

  it("keeps body mentions inside fallback tweet body", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div dir="auto">
          Thanks <a href="/alice">@alice</a> for the review.
        </div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Thanks @alice for the review.",
    ]);
  });

  it("preserves spacing around X tweet inline links and mentions", async () => {
    const tweetTextHtml = [
      "<span>If a fix on main lands, </span>",
      '<div><span><a href="/clawsweeper">@clawsweeper</a></span></div>',
      "<span> will eventually find the issue. We build </span>",
      '<a href="https://t.co/example"><span aria-hidden="true">http://</span>clawpatch.ai</a>',
      "<span> to split projects into functional units.</span>",
    ].join("");

    document.body.innerHTML = `
      <article data-testid="tweet">
        <div data-testid="tweetText" lang="en" dir="auto">${tweetTextHtml}</div>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "If a fix on main lands, @clawsweeper will eventually find the issue. We build clawpatch.ai to split projects into functional units.",
    ]);
  });

  it("skips X related user sidebar chrome outside the tweet article", async () => {
    document.body.innerHTML = `
      <main>
        <section>
          <div data-testid="cellInnerDiv">
            <article data-testid="tweet">
              <div data-testid="tweetText" lang="en" dir="auto">
                <span>Actual tweet body.</span>
              </div>
            </article>
          </div>
        </section>
        <aside>
          <ul>
            <li>
              <div dir="auto">Peter Steinberger</div>
              <div dir="auto">@steipete</div>
            </li>
          </ul>
        </aside>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("skips X trends rail chrome outside the tweet article", async () => {
    document.body.innerHTML = `
      <main>
        <section>
          <div data-testid="cellInnerDiv">
            <article data-testid="tweet">
              <div data-testid="tweetText" lang="en" dir="auto">
                <span>Actual tweet body.</span>
              </div>
            </article>
          </div>
        </section>
        <div aria-label="当前趋势">
          <section role="region" aria-labelledby="trends-title">
            <h1 id="trends-title" dir="auto" role="heading">当前趋势</h1>
            <div aria-label="时间线：当前趋势">Middle East</div>
          </section>
        </div>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body.",
    ]);
  });

  it("skips sidebar list items outside article content", async () => {
    const bodyText =
      "Primary page content should be extracted without pulling in recommendation sidebar entries.";
    document.body.innerHTML = `
      <main>
        <section>${bodyText}</section>
        <aside>
          <ul>
            <li>Peter Steinberger @steipete</li>
          </ul>
        </aside>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("skips feed timestamps outside body text", async () => {
    const bodyText =
      "Feed body text should not include the absolute timestamp while still being long enough for generic feed extraction.";
    document.body.innerHTML = `
      <article data-testid="tweet">
        <time>May 16, 2026</time>
        <section>
          ${bodyText}
        </section>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
    ]);
  });

  it("skips feed chrome inside direct readable body text", async () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <p>
          Body text
          <span aria-label="Post metadata">
            <time>May 16, 2026</time>
            <span>@handle</span>
            <span>42</span>
          </span>
        </p>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Body text",
    ]);
  });

  it("skips common feed chrome while keeping body text", async () => {
    document.body.innerHTML = `
      <main>
        <nav>Home Search Notifications Messages</nav>
        <article>
          <div lang="en" dir="auto">Actual comment text.</div>
          <div aria-label="Timeline controls">Show more</div>
          <button>Like</button>
          <a href="/user">@handle</a>
          <span>42</span>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual comment text.",
    ]);
  });

  it("skips feed header chrome while keeping post body text", async () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="tweet">
          <header>
            <h1>Terence</h1>
            <span>@terence</span>
            <time>1h</time>
          </header>
          <p>Feed body text remains extractable.</p>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Feed body text remains extractable.",
    ]);
  });

  it("extracts short cellInnerDiv post text without tweetText markup", async () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="cellInnerDiv">
          <div>Short cell post text.</div>
        </div>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Short cell post text.",
    ]);
  });

  it("extracts nested tweet text instead of the cell wrapper", async () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="cellInnerDiv">
          <article data-testid="tweet">
            <div>
              <a href="/terence">Terence</a>
              <span>@terence</span>
            </div>
            <header>
              <h1>Terence</h1>
              <span>@terence</span>
              <time>1h</time>
            </header>
            <div data-testid="tweetText">
              <span>Actual tweet body only.</span>
            </div>
            <div role="group" aria-label="Post actions">
              <button>Reply</button>
              <button>Like</button>
            </div>
          </article>
        </div>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Actual tweet body only.",
    ]);
    expect(result.anchors.get("seg_1")?.sourceNode).toBe(
      document.querySelector('[data-testid="tweetText"]'),
    );
  });

  it("skips role-based feed header chrome while keeping body text", async () => {
    document.body.innerHTML = `
      <section role="feed">
        <div role="listitem">
          <div role="article">
            <header>
              <h1>Display Name</h1>
              <span>@display</span>
              <time>2h</time>
            </header>
            <div>Role feed body text.</div>
          </div>
        </div>
      </section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Role feed body text.",
    ]);
  });

  it("skips navigation listitem chrome while keeping feed listitem posts", async () => {
    document.body.innerHTML = `
      <nav>
        <div role="listitem">Navigation item</div>
      </nav>
      <section role="feed">
        <div role="listitem">
          <div>Role listitem post text.</div>
        </div>
      </section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Role listitem post text.",
    ]);
  });

  it("does not treat ordinary aria listitems as feed roots", async () => {
    const sectionText =
      "This independent body section should still be discovered after a normal ARIA list item card.";
    document.body.innerHTML = `
      <div role="listitem">
        <header><h2>Ordinary result title</h2></header>
        <div>Ordinary result summary.</div>
      </div>
      <section>${sectionText}</section>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Ordinary result title",
      sectionText,
    ]);
  });

  it("does not treat ordinary listitem articles as feed context", async () => {
    document.body.innerHTML = `
      <div role="listitem">
        <div role="article">
          <header><h2>Ordinary result title</h2></header>
          <p>Ordinary result body.</p>
        </div>
      </div>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Ordinary result title",
      "Ordinary result body.",
    ]);
  });

  it("deduplicates nested multi-root discoveries", async () => {
    document.body.innerHTML = `
      <main>
        <article>
          <div data-testid="tweetText" lang="en" dir="auto">
            <span>Nested root text should appear once.</span>
          </div>
        </article>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Nested root text should appear once.",
    ]);
  });

  it("preserves sibling feed roots and independent text roots", async () => {
    document.body.innerHTML = `
      <article>
        <div data-testid="tweetText" lang="en" dir="auto">
          <span>First sibling article text.</span>
        </div>
      </article>
      <article>
        <div data-testid="tweetText" lang="en" dir="auto">
          <span>Second sibling article text.</span>
        </div>
      </article>
      <main>
        <p>Normal page section.</p>
      </main>
      <div lang="en" dir="auto">Standalone short feed text.</div>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "First sibling article text.",
      "Second sibling article text.",
      "Normal page section.",
      "Standalone short feed text.",
    ]);
  });

  it("ignores html language when discovering specific roots", async () => {
    document.documentElement.setAttribute("lang", "en");
    document.body.innerHTML = `
      <article>
        <div data-testid="tweetText" lang="en" dir="auto">
          <span>First html language article text.</span>
        </div>
      </article>
      <main>
        <p>Normal html language page section.</p>
      </main>
      <div lang="en" dir="auto">Standalone html language feed text.</div>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "First html language article text.",
      "Normal html language page section.",
      "Standalone html language feed text.",
    ]);
  });

  it("does not treat body language as high-confidence fallback text", async () => {
    document.body.setAttribute("lang", "en");
    document.body.innerHTML = `
      <div>Short body fallback text.</div>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments).toEqual([]);
  });

  it("keeps repeated independent text nodes as separate anchors", async () => {
    document.body.innerHTML = `
      <main>
        <p>Repeated visible text.</p>
        <p>Repeated visible text.</p>
      </main>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      "Repeated visible text.",
      "Repeated visible text.",
    ]);
    expect(result.anchors.get("seg_1")?.sourceNode).toBe(
      document.querySelectorAll("p")[0],
    );
    expect(result.anchors.get("seg_2")?.sourceNode).toBe(
      document.querySelectorAll("p")[1],
    );
  });

  it("excludes low-value feed descendants from generic source text", async () => {
    const bodyText =
      "This generic feed item contains enough meaningful text for translation extraction without including controls.";
    document.body.innerHTML = `
      <article data-testid="tweet">
        <section>
          ${bodyText}
          <div aria-label="Post actions">
            <button>Like</button>
            <button>Reply</button>
          </div>
          <span>42</span>
        </section>
      </article>
    `;

    const result = await collectPageSegments("task-1");

    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      bodyText,
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
