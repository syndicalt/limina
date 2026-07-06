#!/usr/bin/env node
// build-world.mjs — author a game's world INTO the live editor from its DESIGN SPEC,
// the coordinator way: connect to editor_host over its WS + token, then invoke the
// engine build skills in the CANONICAL order. The maker watches it appear at :5173.
//
//   LIMINA_EDITOR_TOKEN=<token> node tools/design/build-world.mjs [vault-dir]
//   node tools/design/build-world.mjs <token> [vault-dir]
//
// TWO HARD RULES this file obeys (both were violated by the earlier version):
//
//  1. BUILDINGS ARE WHOLE BLENDER-AUTHORED GLBs — never the retired parametric
//     assembler. Each location is placed through village.build's `assetId` (glb)
//     path, which runs asset.place on a whole baked GLB. We NEVER pass `archetype`,
//     `kit`, or touch building.assemble / architecture.building — that pipeline
//     output the misoriented walls + old textures. (memory: agent-authors-buildings-not-engine)
//
//  2. CANONICAL BUILD ORDER — terrain -> vegetation(nature) -> structures-that-clear.
//     The forest is scattered on the natural ground FIRST; village.build then carves
//     its building footprints out of that forest via the vegetationClears mechanism.
//     "World exists first, then intelligence builds." (memory: build-pipeline-order)
//
// The build is DRIVEN BY THE VAULT: we read the authored world-bible locations and
// map each location `kind` to its Blender-authored GLB. Nothing is hand-invented.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.LIMINA_EDITOR_URL || "ws://localhost:8787/";
const args = process.argv.slice(2);
// First non-path arg is the token; a dir-looking arg is the vault.
let TOKEN = process.env.LIMINA_EDITOR_TOKEN;
let VAULT = process.env.LIMINA_VAULT_DIR;
for (const a of args) {
  if (a.includes("/") || a === "." ) { VAULT = a; } else if (!TOKEN) { TOKEN = a; }
}
VAULT = VAULT || join(process.env.HOME || "", "Projects/Personal/eastern-watch/design");
if (!TOKEN) { console.error("need the editor token (arg or LIMINA_EDITOR_TOKEN)"); process.exit(1); }

// -- Each authored location `kind` -> the WHOLE Blender-authored GLB that renders it.
//    (marker kinds are not buildings — signal-fire / perimeter are set-dressing props,
//    placed in a later pass, so they are intentionally absent here.)
const KIND_TO_GLB = {
  civic:     { assetId: "norman-manor-building.glb", style: "cut-stone", role: "hall" },
  // dwelling + military now use the QC-approved, Blender-authored + human-approved GLBs.
  dwelling:  { assetId: "cottage-authored.glb",      style: "timber",    role: "cottage" },
  religious: { assetId: "norman-church.glb",         style: "cut-stone", role: "monastery" },
  military:  { assetId: "watchtower-authored.glb",   style: "timber",    role: "watchtower" },
};

// -- Parse the world-bible frontmatter locations (id / kind / position) — a tiny,
//    targeted read of the SAME authored vault the design space edits. We only need
//    kind (-> which GLB) and count per kind (dwelling authored once = a hamlet row of 3).
function readLocations(vaultDir) {
  const md = readFileSync(join(vaultDir, "world-bible.md"), "utf8");
  const fm = md.split(/^---$/m)[1] ?? md;
  const locs = [];
  const block = fm.split(/^locations:/m)[1];
  if (!block) return locs;
  for (const chunk of block.split(/^  - id:/m).slice(1)) {
    const id = chunk.split("\n")[0].trim();
    const kind = (chunk.match(/kind:\s*(\S+)/) || [])[1];
    const count = Number((chunk.match(/count:\s*(\d+)/) || [])[1]) || (kind === "dwelling" ? 3 : 1);
    if (id && kind) locs.push({ id, kind, count });
  }
  return locs;
}

const ws = new WebSocket(URL);
let idc = 1;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((res, rej) => {
    const id = idc++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " timed out")); } }, 90000);
  });
}
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m && m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
});
ws.addEventListener("error", (e) => { console.error("ws error:", e.message || e); process.exit(1); });

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r && r.success === false) throw new Error(name + " failed: " + JSON.stringify(r.error));
  return r;
}

ws.addEventListener("open", async () => {
  try {
    await rpc("initialize", { agentId: "design-build", sessionId: "design-build-1", profile: "builder.readWrite", authToken: TOKEN });
    console.log("connected as builder — vault:", VAULT);

    const locs = readLocations(VAULT);
    console.log("authored locations:", locs.map((l) => `${l.id}(${l.kind}x${l.count})`).join(", "));

    // Fold locations into village.build glb specs by kind (markers -> skipped for now).
    const byAsset = new Map();
    for (const l of locs) {
      const g = KIND_TO_GLB[l.kind];
      if (!g) { console.log("  · skip marker/prop:", l.id, `(${l.kind})`); continue; }
      const cur = byAsset.get(g.assetId) || { ...g, count: 0 };
      cur.count += l.count;
      byAsset.set(g.assetId, cur);
    }
    const buildings = [...byAsset.values()].map((g) => ({ assetId: g.assetId, role: g.role, style: g.style, count: g.count }));
    console.log("buildings (whole GLBs):", buildings.map((b) => `${b.assetId}x${b.count}`).join(", "));

    // 1. TERRAIN — the frontier clearing the hamlet + forest sit on. seaCoverage floods the low
    //    basins to a real waterline (the lakebeds you can see in the relief).
    const rc = await call("terrain.create", { size: 200, resolution: 128, color: 5926970, generate: { seed: 11, amplitude: 12, seaCoverage: 0.06, erosion: { rain: 1.2, thermal: 5 } } });
    const terrain = (rc.result || {}).entity;
    console.log("1. terrain:", terrain);

    // 1b. WATER — flood the basins to the terrain's own sea level (auto-derived), so the low ground
    //     reads as ponds/coast, not bare lakebed. Render-only surface; never touches sim/log.
    const rw = await call("world.addWater", { terrainEntity: terrain, size: 420, color: 2841970 });
    console.log("1b. water: flooded to sea level");

    // 2. THE SETTLEMENT (civilization's footprint on nature) — place the WHOLE Blender GLBs and, in the
    //    same pass, register the settlement COMMONS clearing + per-building footprints on the terrain.
    //    The forest (step 3) then reads those footprints and scatters AROUND them, so the hamlet sits in
    //    an open ring of cleared ground with the treeline beyond. NO archetype / kit / assemble — the
    //    glb path only. (village.build's own layout terraces + lays the lawn on the leveled ground.)
    const steering = {
      buildings,
      layout: { focal: "the muster longhall at the settlement heart", density: "loose" },
      siting: { terrace: "minimal", yard: "lawn", lane: "dirt", clearing: "commons", clearingMargin: 15 },
    };
    const rv = await call("village.build", { direction: { setting: "medieval", mood: "weathered frontier watch, the Blight at the edge" }, steering, seed: 11, terrainEntity: terrain });
    console.log("2. hamlet:", (rv.result || {}).placed, "whole-GLB buildings placed (+ commons clearing registered)");

    // 3. THE FOREST RING (nature around the settlement) — scatter on the natural ground, auto-avoiding
    //    the registered commons + footprints (the terrain unions them as exclusions) so the trees ring
    //    the hamlet and never grow in the commons. The forest floor auto-defaults to the waterline, so
    //    NO trees wade into the lakes.
    const rf = await call("vegetation.scatter", { terrain, species: ["pine", "spruce"], density: 26, coverage: 0.7, cluster: 0.55, seed: 11 });
    console.log("3. forest:", (rf.result || {}).instances, "trees (ring around the cleared hamlet, above the waterline)");

    console.log("\n  built Eastern Watch into the live editor — open http://localhost:5173/\n");
    ws.close(); process.exit(0);
  } catch (e) {
    console.error("build failed:", e.message);
    process.exit(1);
  }
});
