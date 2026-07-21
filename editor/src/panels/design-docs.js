// Design Docs panel (studio-unification U1): the Design Space docs tab ported into
// the editor shell — vault doc nav (kind-ordered), rendered view with frontmatter
// chips, full split editor with live preview, create/delete, save → cascade
// surfacing. Talks to the headless design sidecar through the launcher's
// same-origin /api/* proxy (the browser never holds the design token).
//
// Degradation contract: when the design backend is unreachable (editor opened
// without the launcher proxy), the panel renders a retryable unavailable notice
// instead of a blank rail — the world panels are unaffected by design outages.

import { keyedList } from "../keyed-render.js";
import { docKind, parseFrontmatter, renderDesignMarkdown } from "../design-markdown.js";

const KIND_ICON = { home: "⌂", concept: "◆", "art-direction": "✦", "world-bible": "◈", places: "⚲", cast: "☗", storyboard: "❧", "build-map": "⚑" };
const KIND_LABEL = { home: "Home", concept: "Concept", "art-direction": "Art", "world-bible": "World", places: "Places", cast: "Cast", storyboard: "Beats", "build-map": "Build map" };
const KIND_ORDER = ["home", "concept", "art-direction", "world-bible", "places", "cast", "storyboard", "build-map"];
const NAVIGATION_DOC_KINDS = new Set(["places", "world-bible"]);
const DOC_CREATE_KINDS = ["note", "lore", "faction", "location", "character", "concept", "art-direction", "world-bible", "cast", "storyboard"];

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function titleCaseName(name) {
  return String(name).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function titleOf(doc) {
  const { props } = parseFrontmatter(doc.content);
  return props.title || props.name || titleCaseName(doc.name.replace(/\.md$/, ""));
}

export function createDesignDocsPanel({ mount, api, onOpenChat, onCascade, toast = console.warn, events }) {
  if (!mount || mount.nodeType !== 1) throw new TypeError("design docs panel mount must be an Element");
  if (api === null || typeof api !== "object") throw new TypeError("design docs panel requires a design-api client");

  const root = document.createElement("div");
  root.className = "dd";
  root.innerHTML = '<div class="dd-nav" role="list"></div><div class="dd-main"></div>';
  mount.appendChild(root);
  const navEl = root.querySelector(".dd-nav");
  const mainEl = root.querySelector(".dd-main");

  let state = null;
  let activeDoc = null;
  let unavailable = null;

  const docsSorted = () => [...(state?.docs ?? [])].sort(
    (a, b) => KIND_ORDER.indexOf(docKind(a.content)) - KIND_ORDER.indexOf(docKind(b.content)),
  );

  function renderNav() {
    keyedList(navEl, docsSorted(), {
      key: (d) => d.name,
      render: (d) => {
        const el = document.createElement("div");
        el.className = "dd-navitem";
        el.dataset.doc = d.name;
        const k = docKind(d.content);
        el.innerHTML = `<span class="ic">${KIND_ICON[k] ?? "◦"}</span><span class="t"></span><span class="k">${KIND_LABEL[k] ?? ""}</span>`;
        el.querySelector(".t").textContent = titleOf(d);
        el.onclick = () => openDoc(d.name);
        return el;
      },
      update: (el, d) => {
        el.classList.toggle("active", d.name === activeDoc);
        const k = docKind(d.content);
        const label = el.querySelector(".k");
        if (label !== null && label.textContent !== (KIND_LABEL[k] ?? "")) label.textContent = KIND_LABEL[k] ?? "";
        const title = el.querySelector(".t");
        const next = titleOf(d);
        if (title !== null && title.textContent !== next) title.textContent = next;
      },
    });
    // keyedList reuses nodes; the active marker rides update() only for retained
    // rows, so fresh renders of a changed active doc need one pass here.
    for (const el of navEl.children) el.classList.toggle("active", el.dataset.doc === activeDoc);
  }

  function renderUnavailable(error) {
    navEl.replaceChildren();
    mainEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "dd-unavailable";
    wrap.innerHTML = '<div class="dd-unavailable-msg">Design backend unavailable.</div>'
      + '<div class="dd-unavailable-err"></div>'
      + '<button class="btn dd-retry" type="button">Retry</button>';
    wrap.querySelector(".dd-unavailable-err").textContent = String(error?.message ?? error ?? "");
    wrap.querySelector(".dd-retry").onclick = () => load();
    mainEl.appendChild(wrap);
  }

  function openDoc(name) {
    if (state === null) return;
    events?.emit?.("docs.open", { detail: name });
    const d = state.docs.find((x) => x.name === name) ?? state.docs[0];
    activeDoc = d === undefined ? null : d.name;
    if (d === undefined) {
      mainEl.innerHTML = '<div class="dd-empty">No documents yet — ＋ creates one.</div>';
      renderNav();
      return;
    }
    const { props } = parseFrontmatter(d.content);
    const chips = Object.entries(props).filter(([k]) => k !== "note").slice(0, 6)
      .map(([k, v]) => `<span class="prop"><b>${esc(k)}</b> ${esc(String(v)).slice(0, 42)}</span>`).join("");
    const editable = docKind(d.content) !== "build-map";
    mainEl.innerHTML =
      '<div class="dd-wrap">'
      + (editable
        ? '<div class="dd-edit"><button class="btn" id="dd-edit" type="button">✎ Edit</button> <button class="btn" id="dd-del" type="button" title="Delete document">🗑</button></div>'
        : "")
      + `<div class="props">${chips}</div><div class="doc">${renderDesignMarkdown(d.content, {
        resolveWikiLink: (file) => state.docs.some((x) => x.name === file),
      })}</div></div>`;
    for (const a of mainEl.querySelectorAll(".doc a.wl")) {
      if (a.dataset.doc) a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); };
    }
    const eb = mainEl.querySelector("#dd-edit");
    if (eb) eb.onclick = () => openEditor(d.name);
    const dd = mainEl.querySelector("#dd-del");
    if (dd) dd.onclick = () => deleteDoc(d.name);
    renderNav();
  }

  function openEditor(name) {
    const d = state?.docs.find((x) => x.name === name);
    if (d === undefined) return;
    mainEl.innerHTML =
      `<div class="ed"><div class="ed-bar"><span class="fn">${esc(name)}</span><span class="sp"></span>`
      + '<button class="btn" id="ed-cancel" type="button">Cancel</button><button class="btn ed-save" id="ed-save" type="button">Save</button></div>'
      + '<div class="ed-split"><textarea id="ed-ta" spellcheck="false"></textarea><div class="ed-prev col" id="ed-prev"></div></div></div>';
    const ta = mainEl.querySelector("#ed-ta");
    const prev = mainEl.querySelector("#ed-prev");
    ta.value = d.content;
    const render = () => {
      prev.innerHTML = `<div class="dd-wrap"><div class="doc">${renderDesignMarkdown(ta.value, {
        resolveWikiLink: (file) => state.docs.some((x) => x.name === file),
      })}</div></div>`;
    };
    render();
    ta.addEventListener("input", render);
    mainEl.querySelector("#ed-cancel").onclick = () => openDoc(name);
    mainEl.querySelector("#ed-save").onclick = () => saveEditor(name, ta.value);
  }

  async function saveEditor(name, content) {
    const btn = mainEl.querySelector("#ed-save");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    const previous = state?.docs.find((d) => d.name === name)?.content ?? "";
    const navigationDoc = NAVIGATION_DOC_KINDS.has(docKind(previous)) || NAVIGATION_DOC_KINDS.has(docKind(content));
    try {
      const j = await api.save(name, content);
      const d = state.docs.find((x) => x.name === name);
      if (d) d.content = content;
      await load();
      events?.emit?.("docs.save", { detail: name });
      if (navigationDoc && typeof onCascade === "function") onCascade({ navigationDoc: true });
      openDoc(name);
      if (Array.isArray(j.impacts) && j.impacts.length > 0 && typeof onCascade === "function") onCascade({ impacts: j.impacts });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Save"; }
      toast(`save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function createDoc(title, kind) {
    try {
      const j = await api.docCreate(title, kind);
      await load();
      activeDoc = j.name;
      openDoc(j.name);
      openEditor(j.name);
    } catch (e) {
      toast(`create failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function deleteDoc(name) {
    try {
      await api.docDelete(name);
      activeDoc = null;
      await load();
      const first = state.docs.find((d) => docKind(d.content) === "home") ?? state.docs[0];
      if (first) openDoc(first.name);
    } catch (e) {
      toast(`delete failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  function openCreateDialog() {
    document.getElementById("dd-insp")?.remove();
    const el = document.createElement("div");
    el.className = "insp";
    el.id = "dd-insp";
    el.style.left = "50%";
    el.style.top = "120px";
    el.style.right = "auto";
    el.style.transform = "translateX(-50%)";
    el.innerHTML = '<h4>New document<button class="x" id="dd-insp-x" type="button">×</button></h4>'
      + '<label>Title</label><input id="dd-nd-title" placeholder="e.g. The Wardens">'
      + `<label>Kind</label><select id="dd-nd-kind">${DOC_CREATE_KINDS.map((k) => `<option${k === "note" ? " selected" : ""}>${k}</option>`).join("")}</select>`
      + '<div class="co">A readable, linkable markdown doc. "note" and lore/faction/etc. are free notes; the design kinds feed the build.</div>'
      + '<div class="actions"><button class="save" id="dd-nd-create" type="button">Create</button></div>';
    document.body.appendChild(el);
    el.querySelector("#dd-insp-x").onclick = () => el.remove();
    const titleInput = el.querySelector("#dd-nd-title");
    titleInput.focus();
    const submit = () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      el.remove();
      createDoc(title, el.querySelector("#dd-nd-kind").value);
    };
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    el.querySelector("#dd-nd-create").onclick = submit;
  }

  async function load() {
    try {
      unavailable = null;
      state = await api.state();
    } catch (e) {
      unavailable = e;
      state = null;
      renderUnavailable(e);
      return;
    }
    const home = state.docs.find((d) => docKind(d.content) === "home");
    if (activeDoc === null || !state.docs.some((d) => d.name === activeDoc)) {
      activeDoc = home !== undefined ? home.name : state.docs[0]?.name ?? null;
    }
    renderNav();
    openDoc(activeDoc);
  }

  return Object.freeze({
    load,
    openDoc,
    openCreateDialog,
    get activeDoc() { return activeDoc; },
    get docNames() { return (state?.docs ?? []).map((d) => d.name); },
    get unavailable() { return unavailable; },
    destroy() {
      root.remove();
      document.getElementById("dd-insp")?.remove();
    },
  });
}
