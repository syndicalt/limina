// design-markdown.js — pure string→string port of the Design Space markdown dialect
// (from the retired Atlas SPA's app.js: renderMd + inline + wl + frontmatter; escaping as in
// util.js). Lifted so the studio Docs panel owns the renderer after the SPA copy was
// deleted (studio-unification U1). Zero globals: wiki-link existence, which the
// original reads from mutable S.state, arrives through the resolveWikiLink option.
// Behavioral parity with the original is required — including its quirks (wiki targets and
// aliases are escaped a second time inside wl; the *em* pass can match inside an already
// substituted code span). The ONE deliberate divergence: markdown-link hrefs are
// scheme-checked (see markdownLink).

// Escape-first is the dialect's security invariant: every byte of source text is HTML-escaped
// before any markup substitution runs, so no source input can inject tags. Substitution
// outputs are built only from already-escaped fragments.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const props = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      // The /^\s/ guard is redundant with the anchored key pattern but kept for parity.
      if (mm && !/^\s/.test(line)) props[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
    }
  }
  return { props, body: m ? content.slice(m[0].length) : content };
}

export function docKind(content) {
  return parseFrontmatter(content).props.kind || "doc";
}

function wikiLink(target, alias, resolveWikiLink) {
  const doc = target.split("#")[0].trim();
  const file = /\.md$/.test(doc) ? doc : doc + ".md";
  // Original default with no vault state loaded: everything renders "missing".
  const exists = typeof resolveWikiLink === "function" ? Boolean(resolveWikiLink(file)) : false;
  return '<a class="wl' + (exists ? "" : " missing") + '" data-doc="' + esc(file) + '">'
    + esc(alias.replace(/\\\|/g, "|")) + "</a>";
}

// HARDENING — the one deliberate divergence from the original: it interpolated any href
// verbatim. Escape-first already makes attribute breakout impossible, but the browser would
// still navigate to javascript:/data: URLs on click. Only http:, https:, mailto:, fragment
// (#) and root-relative (/) hrefs keep their anchor; anything else degrades to the link text.
// Leading C0/whitespace is stripped before the check because browsers strip it too.
function markdownLink(_, text, href) {
  const probe = href.replace(/^[\s\x00-\x1f]+/, "").toLowerCase();
  const allowed = probe.startsWith("http:") || probe.startsWith("https:")
    || probe.startsWith("mailto:") || probe.startsWith("#") || probe.startsWith("/");
  if (!allowed) return text;
  return '<a href="' + href + '" target="_blank" rel="noopener">' + text + "</a>";
}

function inline(s, resolveWikiLink) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, t, a) => wikiLink(t, a, resolveWikiLink));
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => wikiLink(t, t, resolveWikiLink));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, markdownLink);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return s;
}

export function renderDesignMarkdown(src, { resolveWikiLink } = {}) {
  const lines = src.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").split("\n");
  let html = "";
  let i = 0;
  let list = null;
  const closeList = () => {
    if (list) {
      html += "</" + list + ">";
      list = null;
    }
  };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      closeList();
      let code = "";
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code += esc(lines[i]) + "\n";
        i++;
      }
      html += "<pre><code>" + code + "</code></pre>";
      i++;
      continue;
    }
    if (/^\s*$/.test(ln)) {
      closeList();
      i++;
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      html += "<h" + h[1].length + ">" + inline(h[2], resolveWikiLink) + "</h" + h[1].length + ">";
      i++;
      continue;
    }
    if (/^>\s?/.test(ln)) {
      closeList();
      let q = "";
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q += lines[i].replace(/^>\s?/, "") + " ";
        i++;
      }
      html += "<blockquote>" + inline(q.trim(), resolveWikiLink) + "</blockquote>";
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(ln)) {
      closeList();
      html += "<hr>";
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(ln);
      i += 2;
      let body = "";
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        body += "<tr>" + row(lines[i]).map((c) => "<td>" + inline(c, resolveWikiLink) + "</td>").join("") + "</tr>";
        i++;
      }
      html += "<table><thead><tr>"
        + head.map((c) => "<th>" + inline(c, resolveWikiLink) + "</th>").join("")
        + "</tr></thead><tbody>" + body + "</tbody></table>";
      continue;
    }
    const ul = ln.match(/^\s*[-*]\s+(.*)$/);
    const ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) {
      // Indentation does NOT nest — an indented item just continues the current list. The
      // vault's docs are written against this flat behavior, so parity forbids "fixing" it.
      if (list !== "ul") {
        closeList();
        html += "<ul>";
        list = "ul";
      }
      html += "<li>" + inline(ul[1], resolveWikiLink) + "</li>";
      i++;
      continue;
    }
    if (ol) {
      if (list !== "ol") {
        closeList();
        html += "<ol>";
        list = "ol";
      }
      html += "<li>" + inline(ol[1], resolveWikiLink) + "</li>";
      i++;
      continue;
    }
    closeList();
    html += "<p>" + inline(ln, resolveWikiLink) + "</p>";
    i++;
  }
  closeList();
  return html;
}
