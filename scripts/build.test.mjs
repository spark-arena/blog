import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./build.mjs";

test("wrapped protocol steps stay in one numbered list", () => {
  const html = renderMarkdown(`1. **Identify the image.** Read metadata.
   Check the local image before requesting layers.
2. **Negotiate.** Report locally available content.
   Request only missing layers.

The next paragraph.`);
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.match(html, /metadata\. Check the local image before requesting layers\.<\/li>/);
  assert.match(html, /content\. Request only missing layers\.<\/li>/);
  assert.match(html, /<p>The next paragraph\.<\/p>/);
});

test("wrapped bullet lists keep their text and explicit numbering is preserved", () => {
  assert.equal(renderMarkdown("- A cached layer\n  avoids transfer.\n- A missing layer is requested."),
    "<ul><li>A cached layer avoids transfer.</li><li>A missing layer is requested.</li></ul>");
  assert.equal(renderMarkdown("3. Third step\n   continued.\n4. Fourth step"),
    '<ol start="3"><li>Third step continued.</li><li>Fourth step</li></ol>');
});

test("HTML comment blocks stay hidden, including a preserved copyright notice", () => {
  const html = renderMarkdown("<!--\nSPDX-FileCopyrightText: Example\n-->\n\n# Article\n\nVisible text.");
  assert.equal(html, "<h1>Article</h1>\n<p>Visible text.</p>");
  assert.equal(renderMarkdown("<!-- Hidden -->\nVisible."), "<p>Visible.</p>");
  assert.match(renderMarkdown("```html\n<!-- Code example -->\n```"), /&lt;!-- Code example --&gt;/);
});
