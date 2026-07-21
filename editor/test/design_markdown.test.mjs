// design-markdown dialect (studio-unification U1). Proves: frontmatter parsing
// variants, every dialect feature, escape-first safety, wiki-link exists/missing
// classes via the injected resolver, and the one deliberate hardening (markdown
// href scheme allowlist). Parity with the original renderer was verified by a
// 12-case byte-identical differential (2026-07-19); the falsifiability here is
// that unescaped input (a script tag) must come out inert and a javascript: href
// must lose its anchor.

import assert from "node:assert/strict";
import test from "node:test";

import { docKind, parseFrontmatter, renderDesignMarkdown } from "../src/design-markdown.js";

test("parseFrontmatter: fence variants, quotes, non-prop lines", () => {
  assert.deepEqual(parseFrontmatter("no fence"), { props: {}, body: "no fence" });
  const { props, body } = parseFrontmatter('---\nkind: world-bible\ntitle: "The Vale"\nnote: keep\n---\nbody text');
  assert.equal(props.kind, "world-bible");
  assert.equal(props.title, "The Vale");
  assert.equal(props.note, "keep");
  assert.equal(body, "\nbody text");
  const crlf = parseFrontmatter("---\r\nkind: cast\r\n---\r\nx");
  assert.equal(crlf.props.kind, "cast");
  const indented = parseFrontmatter("---\n  kind: nope\n---\nx");
  assert.equal(indented.props.kind, undefined, "whitespace-prefixed lines are not props");
});

test("docKind defaults to doc", () => {
  assert.equal(docKind("plain"), "doc");
  assert.equal(docKind("---\nkind: storyboard\n---\nx"), "storyboard");
});

test("headings, lists, quote, hr, code fence, table", () => {
  assert.equal(renderDesignMarkdown("# A"), "<h1>A</h1>");
  assert.equal(renderDesignMarkdown("#### D"), "<h4>D</h4>");
  assert.equal(renderDesignMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(renderDesignMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderDesignMarkdown("  - indented\n- flat"), "<ul><li>indented</li><li>flat</li></ul>", "indented items stay flat (dialect parity)");
  assert.equal(renderDesignMarkdown("> q\n> r"), "<blockquote>q r</blockquote>");
  assert.equal(renderDesignMarkdown("***"), "<hr>");
  assert.equal(renderDesignMarkdown("```\n<b>\n```"), "<pre><code>&lt;b&gt;\n</code></pre>");
  assert.equal(
    renderDesignMarkdown("| A | B |\n|---|---|\n| 1 | 2 |"),
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("inline: code, bold, em, escaping is escape-first", () => {
  assert.equal(renderDesignMarkdown("`x<y` and **b** and *e*"), "<p><code>x&lt;y</code> and <strong>b</strong> and <em>e</em></p>");
  const out = renderDesignMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"), "source tags must be inert");
  assert.ok(out.includes("&lt;script&gt;"));
});

test("wiki links: .md appending, exists/missing classes, alias, pipe escape", () => {
  const resolveWikiLink = (file) => file === "cast.md";
  assert.equal(
    renderDesignMarkdown("[[cast]]", { resolveWikiLink }),
    '<p><a class="wl" data-doc="cast.md">cast</a></p>',
  );
  assert.equal(
    renderDesignMarkdown("[[cast|The Cast]]", { resolveWikiLink }),
    '<p><a class="wl" data-doc="cast.md">The Cast</a></p>',
  );
  assert.equal(
    renderDesignMarkdown("[[nowhere]]", { resolveWikiLink }),
    '<p><a class="wl missing" data-doc="nowhere.md">nowhere</a></p>',
  );
  assert.equal(
    renderDesignMarkdown("[[cast]]", {}),
    '<p><a class="wl missing" data-doc="cast.md">cast</a></p>',
    "no resolver renders missing (original empty-vault behavior)",
  );
});

test("markdown links: scheme allowlist (the deliberate hardening)", () => {
  assert.equal(renderDesignMarkdown("[ok](https://x.com)"), '<p><a href="https://x.com" target="_blank" rel="noopener">ok</a></p>');
  assert.equal(renderDesignMarkdown("[f](#anchor)"), '<p><a href="#anchor" target="_blank" rel="noopener">f</a></p>');
  assert.equal(renderDesignMarkdown("[r](/path)"), '<p><a href="/path" target="_blank" rel="noopener">r</a></p>');
  assert.equal(renderDesignMarkdown("[m](mailto:a@b.c)"), '<p><a href="mailto:a@b.c" target="_blank" rel="noopener">m</a></p>');
  // A blocked scheme degrades to the link text; the dialect's [^)]+ href regex
  // truncates at the first inner paren (pre-existing quirk), leaving an inert
  // trailing ")" as escaped text. What matters: no anchor survives with a
  // navigable javascript:/data: href.
  assert.equal(renderDesignMarkdown("[x](javascript:alert(1))"), "<p>x)</p>", "javascript: loses its anchor");
  assert.equal(renderDesignMarkdown("[x](data:text/html,<b>)"), "<p>x</p>", "data: loses its anchor");
  assert.equal(renderDesignMarkdown("[x](javascript:throw%201)"), "<p>x</p>", "paren-free javascript: is blocked too");
});

test("frontmatter is stripped before rendering", () => {
  assert.equal(renderDesignMarkdown("---\nkind: home\n---\n# Hi"), "<h1>Hi</h1>");
});
