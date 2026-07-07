#!/usr/bin/env node
// build-world.mjs — author a game's world INTO the live editor from its DESIGN SPEC,
// the coordinator way: connect to editor_host over its WS + token, then invoke the
// engine build skills in the CANONICAL order. The maker watches it appear at :5173.
//
//   LIMINA_EDITOR_TOKEN=<token> node tools/design/build-world.mjs [vault-dir]
//   node tools/design/build-world.mjs <token> [vault-dir]
//
// THREE HARD RULES this file obeys:
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
//  3. MAP-DRIVEN (Phase 1.3) — the world is no longer a procedural island the vault's
//     locations get sprinkled onto after the fact. The DRAWN map (assets/maps/*.worldmap.json,
//     compiled from the vault's maps.json + world-bible.md by tools/map/compile-designmap.mjs)
//     is rasterized straight into the terrain (generate.source:"map"), and each building-kind
//     location is sited AT its authored anchor position (village.build steering.anchors) —
//     never solver-only placement. The hamlet is built ON the drawn island, not near it.
//
// The build is DRIVEN BY THE VAULT: we read the authored world-bible locations and
// map each location `kind` to its Blender-authored GLB, and the compiled WorldMap's
// anchors for WHERE. Nothing is hand-invented.

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const LIMINA_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAP_ASSET_ID = "maps/primary.worldmap.json";

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

// -- Phase 1.3: recompile the vault's map into the committed WorldMap IR BEFORE we build,
//    so the terrain always rasterizes the CURRENT drawing, and read the result back (we
//    need its anchors + contentHash — the terrain skill re-resolves + re-verifies the same
//    file server-side, this is just so the driver can log it and derive steering.anchors).
function compileMap(vaultDir) {
  const compilerPath = join(LIMINA_HOME, "tools/map/compile-designmap.mjs");
  console.log("0. compiling design map from vault:", vaultDir);
  execFileSync(process.execPath, [compilerPath, vaultDir], { stdio: "inherit" });
  const mapPath = join(LIMINA_HOME, "assets", MAP_ASSET_ID);
  const worldMap = JSON.parse(readFileSync(mapPath, "utf8"));
  console.log(
    `0. compiled map "${worldMap.id}" · extent ${worldMap.extent.w}x${worldMap.extent.h}m · ` +
    `anchors ${worldMap.anchors.length} · contentHash ${worldMap.provenance.contentHash}`,
  );
  return worldMap;
}

const worldMap = compileMap(VAULT);

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
    const countByKind = new Map();
    for (const l of locs) {
      countByKind.set(l.kind, (countByKind.get(l.kind) || 0) + l.count);
      const g = KIND_TO_GLB[l.kind];
      if (!g) { console.log("  · skip marker/prop:", l.id, `(${l.kind})`); continue; }
      const cur = byAsset.get(g.assetId) || { ...g, count: 0 };
      cur.count += l.count;
      byAsset.set(g.assetId, cur);
    }
    const buildings = [...byAsset.values()].map((g) => ({ assetId: g.assetId, role: g.role, style: g.style, count: g.count }));
    console.log("buildings (whole GLBs):", buildings.map((b) => `${b.assetId}x${b.count}`).join(", "));

    // Map-driven placement (Phase 1.3): every building-kind anchor from the COMPILED map
    // becomes a village.build steering anchor — the drawn pin, not a solver guess. Marker
    // kinds (signal-fire, perimeter) have no KIND_TO_GLB entry and are skipped, same as above.
    const anchors = worldMap.anchors
      .filter((a) => KIND_TO_GLB[a.kind])
      .map((a) => ({
        id: a.id,
        position: a.position,
        role: KIND_TO_GLB[a.kind].role,
        count: countByKind.get(a.kind) ?? 1,
      }));
    console.log("map anchors (siting pins):", anchors.map((a) => `${a.id}@[${a.position[0]},${a.position[1]}](${a.role}x${a.count})`).join(", "));

    // 1. TERRAIN — MAP-DRIVEN (Phase 1.3): rasterize the compiled WorldMap IR (land/sea mask,
    //    relief, rivers carved, biomes painted) instead of a free-floating procedural island.
    //    terrain.create re-resolves + re-verifies the map asset server-side and throws on a
    //    tampered/mismatched hash — the committed mapHash rides the logged command for replay.
    const rc = await call("terrain.create", {
      size: 200, resolution: 129, origin: [0, 0, 0], color: 5926970,
      generate: { source: "map", mapAssetId: MAP_ASSET_ID, seed: 11, amplitude: 12 },
    });
    const terrain = (rc.result || {}).entity;
    console.log("1. terrain (map-driven):", terrain, rc.result && rc.result.mapHash ? `· mapHash ${rc.result.mapHash}` : "");

    // 1b. WATER — flood the basins to the terrain's own sea level (auto-derived), so the low ground
    //     reads as ponds/coast, not bare lakebed. Render-only surface; never touches sim/log.
    const rw = await call("world.addWater", { terrainEntity: terrain, size: 420, color: 2841970 });
    console.log("1b. water: flooded to sea level");

    // 2. THE SETTLEMENT (civilization's footprint on nature) — place the WHOLE Blender GLBs
    //    AT their authored map anchors (steering.anchors), and, in the same pass, register the
    //    settlement COMMONS clearing + per-building footprints on the terrain. The forest (step 3)
    //    then reads those footprints and scatters AROUND them, so the hamlet sits in an open ring
    //    of cleared ground with the treeline beyond. NO archetype / kit / assemble — the glb path
    //    only. (village.build's own layout terraces + lays the lawn on the leveled ground.)
    const steering = {
      buildings,
      layout: { focal: "the muster longhall at the settlement heart", density: "loose" },
      siting: { terrace: "minimal", yard: "lawn", lane: "dirt", clearing: "commons", clearingMargin: 15 },
      anchors,
    };
    const rv = await call("village.build", { direction: { setting: "medieval", mood: "weathered frontier watch, the Blight at the edge" }, steering, seed: 11, terrainEntity: terrain });
    console.log("2. hamlet:", (rv.result || {}).placed, "whole-GLB buildings placed at their drawn anchors (+ commons clearing registered)");

    // 3. THE FOREST RING (nature around the settlement) — scatter on the natural ground, auto-avoiding
    //    the registered commons + footprints (the terrain unions them as exclusions) so the trees ring
    //    the hamlet and never grow in the commons. The forest floor auto-defaults to the waterline, so
    //    NO trees wade into the lakes.
    const rf = await call("vegetation.scatter", { terrain, species: ["pine", "spruce"], density: 26, coverage: 0.7, cluster: 0.55, seed: 11 });
    console.log("3. forest:", (rf.result || {}).instances, "trees (ring around the cleared hamlet, above the waterline)");

    console.log("\n  built Eastern Watch (map-driven) into the live editor — open http://localhost:5173/\n");
    ws.close(); process.exit(0);
  } catch (e) {
    console.error("build failed:", e.message);
    process.exit(1);
  }
});
