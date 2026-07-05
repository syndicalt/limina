// reference-library — RETRIEVAL over the art-direction reference library (art-direction/library/**),
// the "art-knowledge layer" the build agent RAGs before authoring/sourcing an asset. Each leaf folder
// holds a `card.md` (YAML frontmatter + prose: What it is / References to drop / Likely build path) plus
// reference images. This resolves a brief's DOTTED ID (e.g. "characters.npc.grundir-veteran",
// "buildings.medieval.dwelling.cottage") to that leaf — the visual target (images) + the build recipe
// (card) — so the pipeline can attach them to the build agent's prompt instead of the agent guessing.
//
//   import { resolveReference, searchByTag } from "./reference-library.mjs";
//   const ref = resolveReference("characters.npc.grundir-veteran");
//   // ref = { id, dir, card:{title,tags,engineGaps,status,body,sections}, images:[abs paths] }
//
// Node fs (build-orchestration/agent-time helper, not an in-engine runtime module). Pure read-only.

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LIB = join(ROOT, "art-direction/library");
const IMG = /\.(jpe?g|png|webp)$/i;

/** Parse a card.md's YAML-ish frontmatter (--- … ---) + prose body. Handles `key: scalar`,
 *  `key: [a, b, c]` arrays, and `## Section` headers in the body. No YAML dependency. */
function parseCard(md) {
  const out = { title: "", tags: [], engineGaps: [], status: "", body: "", sections: {} };
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const fm = m ? m[1] : "";
  const body = m ? m[2] : md;
  for (const line of fm.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, raw] = kv;
    let v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    if (k === "title") out.title = String(v);
    else if (k === "tags") out.tags = Array.isArray(v) ? v : [String(v)];
    else if (k === "engine_gaps") out.engineGaps = Array.isArray(v) ? v : [String(v)];
    else if (k === "status") out.status = String(v);
    else out[k] = v;
  }
  out.body = body.trim();
  // split "## Header" prose sections into a map for structured access
  const parts = body.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    if (nl < 0) continue;
    out.sections[p.slice(0, nl).trim().toLowerCase()] = p.slice(nl + 1).trim();
  }
  return out;
}

/** Resolve a dotted library id to its leaf folder: primary is the tree path (id.split('.')→dirs);
 *  falls back to a recursive scan matching a card's frontmatter `id`. */
function dirForId(id) {
  const direct = join(LIB, ...id.split("."));
  if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
  let found;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "card.md") {
        const c = parseCard(readFileSync(p, "utf8"));
        if (c.id === id) found = dirname(p);
      }
    }
  };
  if (existsSync(LIB)) walk(LIB);
  return found;
}

/** Retrieve the reference for a dotted id: its card + reference image paths. Returns null if absent
 *  (the build path degrades to card-less/free authoring, same graceful contract as a missing asset). */
export function resolveReference(id) {
  const dir = dirForId(id);
  if (!dir) return null;
  const cardPath = join(dir, "card.md");
  const card = existsSync(cardPath) ? parseCard(readFileSync(cardPath, "utf8")) : { title: "", tags: [], engineGaps: [], status: "", body: "", sections: {} };
  const images = readdirSync(dir).filter((f) => IMG.test(f)).sort().map((f) => join(dir, f));
  return { id: card.id ?? id, dir, card, images };
}

/** SCAFFOLD a reference leaf during PLANNING: create the folder + a `card.md` STUB (frontmatter + the
 *  three prompt sections) so a user or an agent can drop reference images in and refine the card, then a
 *  user reviews. NEVER overwrites an existing card (user edits + dropped references are safe) — re-running
 *  planning only fills the gaps. Returns { created, dir, cardPath, images }. */
export function scaffoldReference(spec) {
  const { id, title = id, tags = [], engineGaps = [], status = "stub", whatItIs = "", references = "", buildPath = "" } = spec;
  const dir = join(LIB, ...id.split("."));
  mkdirSync(dir, { recursive: true });
  const cardPath = join(dir, "card.md");
  const created = !existsSync(cardPath);
  if (created) {
    writeFileSync(cardPath, [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      `tags: [${tags.join(", ")}]`,
      `engine_gaps: [${engineGaps.join(", ")}]`,
      `status: ${status}`,
      "---",
      "",
      "## What it is",
      whatItIs || "(one or two lines: what this asset is)",
      "",
      "## References to drop",
      references || "(drop 2–3 reference images in THIS folder; note the visual target + fidelity bar here)",
      "",
      "## Likely build path",
      buildPath || "(how the engine builds/sources this + what's missing)",
      "",
    ].join("\n"));
  }
  const images = readdirSync(dir).filter((f) => IMG.test(f)).length;
  return { id, dir, cardPath, created, images };
}

/** Every reference leaf with its review state — for a user to see what still needs images. */
export function listLeaves() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "card.md") {
        const c = parseCard(readFileSync(p, "utf8"));
        const images = readdirSync(dirname(p)).filter((f) => IMG.test(f)).length;
        out.push({ id: c.id ?? "", title: c.title, status: c.status, images, needsImages: images === 0 });
      }
    }
  };
  if (existsSync(LIB)) walk(LIB);
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Cross-cutting query: every leaf whose card tags include `tag` (e.g. "material:stone", "condition:blighted",
 *  "role:npc"). Answers the queries the tree can't, per the library schema. */
export function searchByTag(tag) {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "card.md") {
        const c = parseCard(readFileSync(p, "utf8"));
        if (c.tags.includes(tag)) hits.push({ id: c.id ?? "", title: c.title, dir: dirname(p) });
      }
    }
  };
  if (existsSync(LIB)) walk(LIB);
  return hits;
}
