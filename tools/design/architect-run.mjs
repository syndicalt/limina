// architect-run.mjs — the mechanical QC pipeline an architect agent runs AFTER authoring a GLB
// (with Blender / bespoke Three.js — authoring is NOT this script's job). It takes the finished
// assets/<assetId.glb> and pushes it through the four gates that stand between a bake and the
// catalog:
//
//   1. sanity  — transform-aware world-bbox check (tools/qc/asset-sanity.mjs logic); a
//                DEGENERATE / OVERSIZE bake stops the pipeline here.
//   2. card    — measure + write assets/<base>.card.json via tools/asset/make-card.mjs.
//   3. render  — generate a QC scene spec (terrain + the placed asset, camera framed from the
//                measured bounds), shoot assets/qc/<base><sfx>.png on the real GPU through
//                tools/preview/engine-authored.mjs, and fail if the PNG is missing/tiny.
//   3b. turntable (opt-in, --turntable) — reuse the same framed spec but rotate asset.place's
//                yaw by k*45° for k in 0..7, shooting 8 more frames assets/qc/<base><sfx>-a{k}.png.
//                Gives the reviewer a 360° look at the bake instead of one hero angle.
//   4. propose — connect to the live editor host as profile "builder.review" and call
//                catalog.publish. That profile's mutating calls are HELD by the approval queue,
//                so the EXPECTED outcome is a pending_approval rejection: the proposal now sits
//                in the editor's queue for a human to approve. Anything else is a failure.
//
// Stages run in order and stop on the first failure (non-zero exit). Nothing is published
// directly — a human approves the held catalog.publish in the editor.
//
// Usage: node tools/design/architect-run.mjs <assetId.glb> <title> <category> [--out-suffix <sfx>] [--turntable]
//    or: node tools/design/architect-run.mjs --isolated-manifest <manifest.json> --import-review <review.json>
//   category: prop (buildings route through the functional-building pipeline)
//   --out-suffix: appended to the qc-spec + PNG basenames only (e.g. -piperun), so a dry run
//                 never overwrites the asset's real QC render.
//   --turntable: also shoot 8 yaw frames (task #66) and include their paths as qcTurntable on
//                 the proposed catalog entry. Opt-in — adds ~8 renders to the run.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { glbBbox, classifyBounds } from "../qc/asset-sanity.mjs";
import { measureCard, writeCard } from "../asset/make-card.mjs";
import { assertGenericAssetAuthoringCategory } from "../../js/src/assets/generic-asset-authoring-policy.mjs";
import { requireArchitectEditorToken } from "./architect-security.mjs";
import { importReviewedArchitectArtifact } from "./architect-isolation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIN_PNG_BYTES = 20 * 1024; // below this the shot is a blank/failed canvas, not a QC render

// ---- args ----------------------------------------------------------------------------------
const args = process.argv.slice(2);
const positional = [];
let sfx = "";
let authoredBy = "";
let turntable = false;
let isolatedManifest = "";
let importReview = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out-suffix") { sfx = args[++i] ?? ""; continue; }
  if (args[i] === "--authored-by") { authoredBy = args[++i] ?? ""; continue; }
  if (args[i] === "--turntable") { turntable = true; continue; }
  if (args[i] === "--isolated-manifest") { isolatedManifest = args[++i] ?? ""; continue; }
  if (args[i] === "--import-review") { importReview = args[++i] ?? ""; continue; }
  if (args[i].startsWith("--")) { console.error(`unknown option: ${args[i]}`); process.exit(2); }
  positional.push(args[i]);
}
let [assetId, title, category] = positional;
if (Boolean(isolatedManifest) !== Boolean(importReview)) {
  console.error("--isolated-manifest and --import-review are required together");
  process.exit(2);
}
if (!isolatedManifest && (!assetId || !title || !category)) {
  console.error("usage: node tools/design/architect-run.mjs <assetId.glb> <title> <category> [--out-suffix <sfx>] [--authored-by <model>] [--turntable]\n       node tools/design/architect-run.mjs --isolated-manifest <manifest.json> --import-review <review.json> [--turntable]");
  process.exit(2);
}
let TOKEN;
try { TOKEN = requireArchitectEditorToken(process.env, "architect-run"); }
catch (error) { console.error(`✗ [auth] ${error.message}`); process.exit(2); }
if (isolatedManifest) {
  if (positional.length > 0) {
    console.error("positional asset arguments cannot be combined with reviewed isolated import");
    process.exit(2);
  }
  try {
    const imported = importReviewedArchitectArtifact({ projectRoot: ROOT, manifestPath: isolatedManifest, reviewPath: importReview });
    assetId = imported.assetId;
    title = imported.manifest.request.title;
    category = imported.manifest.request.category;
    authoredBy ||= imported.manifest.generation?.model || "isolated-provided-source";
    console.log(`[import] reviewed isolated artifact → assets/${assetId}`);
  } catch (error) {
    console.error(`✗ [import] ${error.message}`);
    process.exit(2);
  }
}
try { assertGenericAssetAuthoringCategory(category, "architect-run"); }
catch (error) { console.error(`✗ [policy] ${error.message}`); process.exit(2); }
const base = basename(assetId, ".glb");

const fail = (stage, msg) => { console.error(`✗ [${stage}] ${msg}`); process.exit(1); };

// ---- 1/4 sanity ----------------------------------------------------------------------------
console.log(`[1/4] sanity — ${assetId}`);
const glbPath = join(ROOT, "assets", assetId);
if (!assetId.endsWith(".glb")) fail("sanity", `assetId must end in .glb: ${assetId}`);
if (!existsSync(glbPath)) fail("sanity", `no such asset: assets/${assetId}`);
let bb;
try { bb = glbBbox(readFileSync(glbPath)); } catch (e) { fail("sanity", `GLB parse error: ${String(e).slice(0, 120)}`); }
if (bb === null) fail("sanity", "NO-BOUNDS — no POSITION min/max in the GLB");
const d = bb.mx.map((v, i) => v - bb.mn[i]);
const flags = classifyBounds(d, bb.mn);
const blocking = flags.filter((f) => f.startsWith("DEGENERATE") || f.startsWith("OVERSIZE"));
console.log(`      bbox ${d.map((v) => v.toFixed(2)).join(" × ")} m${flags.length ? `  [${flags.join(" ")}]` : ""}`);
if (blocking.length > 0) fail("sanity", `${blocking.join(" ")} — broken bake, refusing to continue`);

// ---- 2/4 card ------------------------------------------------------------------------------
console.log(`[2/4] card — assets/${base}.card.json`);
let card;
try {
  card = measureCard(assetId, title, category);
  const cardPath = writeCard(card);
  console.log(`      wrote ${cardPath}  boundsM=[${card.boundsM.join(", ")}]`);
} catch (e) {
  fail("card", e.message);
}

// ---- 3/4 qc render -------------------------------------------------------------------------
// Camera framed from the measured bounds; terrain sized so a big asset never overhangs the edge.
const maxB = Math.max(...card.boundsM);
const r3 = (v) => Math.round(v * 1000) / 1000;
const spec = {
  commands: [
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    { kind: "skill", tool: "terrain.create", input: { size: Math.max(40, Math.ceil(4 * maxB)), resolution: 48, color: 5926970 } },
    { kind: "skill", tool: "asset.place", input: { assetId, position: [0, 0, 0], rotation: [0, 0, 0], ground: true } },
  ],
  camera: { center: [0, r3(card.boundsM[1] / 2), 0], radius: r3(1.6 * maxB), height: r3(0.8 * card.boundsM[1] + 2) },
};
const specRel = `tools/preview/${base}${sfx}-qc.json`;
writeFileSync(join(ROOT, specRel), JSON.stringify(spec) + "\n");
const pngRel = `assets/qc/${base}${sfx}.png`;
const pngPath = join(ROOT, pngRel);
mkdirSync(dirname(pngPath), { recursive: true });
console.log(`[3/4] qc render — ${specRel} → ${pngRel}`);
const shot = spawnSync(process.execPath, [join(ROOT, "tools/preview/engine-authored.mjs"), pngPath, `/${specRel}`], {
  cwd: ROOT, stdio: "inherit", timeout: 120_000,
});
if (shot.status !== 0) fail("qc render", `engine-authored.mjs exited ${shot.status ?? `(signal ${shot.signal})`}`);
if (!existsSync(pngPath)) fail("qc render", `no PNG at ${pngRel}`);
const pngBytes = statSync(pngPath).size;
if (pngBytes < MIN_PNG_BYTES) fail("qc render", `${pngRel} is only ${pngBytes} bytes (<${MIN_PNG_BYTES}) — blank/failed render`);
console.log(`      ${pngRel} (${(pngBytes / 1024).toFixed(0)} KB)`);

// ---- 3b/4 turntable (opt-in) -----------------------------------------------------------------
// Same framed spec, asset.place's yaw rotated by k*45° for k in 0..7 — a 360° look at the bake
// for the reviewer, instead of one hero angle. Each frame goes through the same missing/tiny
// checks as the hero render; any failure stops the pipeline (a partial turntable is not shipped).
let qcTurntable;
if (turntable) {
  console.log("[3b/4] turntable — 8 yaw frames");
  qcTurntable = [];
  for (let k = 0; k < 8; k++) {
    const yaw = r3((k * Math.PI) / 4);
    const tSpec = {
      ...spec,
      commands: spec.commands.map((c) =>
        c.kind === "skill" && c.tool === "asset.place" ? { ...c, input: { ...c.input, rotation: [0, yaw, 0] } } : c,
      ),
    };
    const tSpecRel = `tools/preview/${base}${sfx}-a${k}-qc.json`;
    writeFileSync(join(ROOT, tSpecRel), JSON.stringify(tSpec) + "\n");
    const tPngRel = `assets/qc/${base}${sfx}-a${k}.png`;
    const tPngPath = join(ROOT, tPngRel);
    const tShot = spawnSync(process.execPath, [join(ROOT, "tools/preview/engine-authored.mjs"), tPngPath, `/${tSpecRel}`], {
      cwd: ROOT, stdio: "inherit", timeout: 120_000,
    });
    if (tShot.status !== 0) fail("turntable", `frame a${k}: engine-authored.mjs exited ${tShot.status ?? `(signal ${tShot.signal})`}`);
    if (!existsSync(tPngPath)) fail("turntable", `frame a${k}: no PNG at ${tPngRel}`);
    const tBytes = statSync(tPngPath).size;
    if (tBytes < MIN_PNG_BYTES) fail("turntable", `frame a${k}: ${tPngRel} is only ${tBytes} bytes (<${MIN_PNG_BYTES}) — blank/failed render`);
    qcTurntable.push(`qc/${base}${sfx}-a${k}.png`);
    console.log(`      ${tPngRel} (${(tBytes / 1024).toFixed(0)} KB)  yaw=${Math.round((k * 45))}°`);
  }
}

// ---- 4/4 propose ---------------------------------------------------------------------------
// builder.review's mutating calls are HELD by the approval queue — pending_approval IS success.
console.log(`[4/4] propose — catalog.publish as builder.review`);
const entry = {
  id: assetId,
  title,
  category,
  boundsM: card.boundsM,
  qcRender: `qc/${base}${sfx}.png`,
  qcChecks: { textured: null, scale: true, integrity: true, theme: null },
  // Provenance for the reviewer: which model authored the GLB (model tier is a quality signal).
  ...(authoredBy ? { authoredBy } : {}),
  // 360° turntable frames (task #66) — only present when --turntable ran.
  ...(qcTurntable ? { qcTurntable } : {}),
  tags: ["building"],
};
const ws = new WebSocket("ws://localhost:8787/");
let idc = 1;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((res, rej) => {
    const id = idc++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout")); } }, 30_000);
  });
}
ws.addEventListener("message", (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m && m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
});
ws.addEventListener("error", (e) => fail("propose", `ws error: ${e.message || "editor host unreachable at ws://localhost:8787/"}`));
ws.addEventListener("open", async () => {
  try {
    await rpc("initialize", { agentId: "architect", sessionId: `architect-${base}`, profile: "builder.review", authToken: TOKEN });
    try {
      await rpc("tools/call", { name: "catalog.publish", arguments: entry });
      // A builder.review mutation that goes THROUGH means the approval gate is off — that is
      // not a propose, it's an accidental direct publish. Surface it as a failure.
      fail("propose", "catalog.publish was applied directly (no approval hold) — review gate not active?");
    } catch (e) {
      let held = false;
      try { const m = JSON.parse(e.message); held = m?.data?.error?.code === "pending_approval"; } catch { /* not json-rpc */ }
      if (!held) throw e;
      console.log(`      HELD: catalog.publish ${entry.id} → proposed — awaiting approval in the editor queue`);
    }
    ws.close();
    console.log(`✓ pipeline complete — ${assetId} proposed for the catalog`);
    process.exit(0);
  } catch (e) {
    fail("propose", e.message);
  }
});
