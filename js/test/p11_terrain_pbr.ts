// Headless CONSTRUCTION + GRAPH-REFERENCE check for the OPT-IN procedural-PBR terrain surface
// (terrain/material-pbr.ts). The surface's LOOK is UAT (landscape_window.ts), but its node graph
// must BUILD headlessly AND be wired CORRECTLY — and the wiring is asserted FALSIFIABLY by
// traversing the built TSL node graph (the cheap `!= null` checks would pass even if the detail
// normals collapsed to bare clay, the layer blend collapsed to one layer, or the #1 view-space
// transform regressed). So this test has TEETH:
//   • OPT-IN / NO-REGRESSION: with NO pbr (and no palette/shoreline) the material sets NO
//     colorNode/normalNode/roughnessNode — byte-identical to the flat default.
//   • NORMAL is VIEW-SPACE detail (#1 fix): normalNode references the shared 256² detail texture
//     (NOT just the geometric normal) and its root applies `transformNormalToView` — its immediate
//     child is the transformNormalToView Fn call (ShaderCallNodeInternal), NOT a
//     `transformDirection` math node (the bug form). Revert-proof: switching back to
//     `transformDirection(nrm, cameraViewMatrix)` makes the immediate child a transformDirection
//     _MathNode → fails; collapsing normalNode to `normalWorld` drops the 256² texture → fails.
//   • COLOR is the full band-blend over ALL FOUR layers: colorNode references the detail texture
//     (256²) + the climate texture (33²) + the distinct tiling scale of each of the four layers
//     (rock/grass/snow/sand) + every band-mask threshold (rock/snow/cliff/coast/sub). Revert-proof:
//     dropping a layer mix removes that layer's scale const; dropping a band mix removes that
//     mask's threshold const → fails.
//
// Run: limina js/test/p11_terrain_pbr.ts   (exit 0 = pass)

import { buildTerrainMesh } from "../src/terrain/render.ts";
import { ProceduralTerrainSource, TILE_RES } from "../src/terrain/procedural.ts";
import { terrainTypeHints } from "../src/terrain/terrain-types.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_terrain_pbr FAIL: " + msg);
}
// deno-lint-ignore no-explicit-any
const isSet = (n: any) => n !== undefined && n !== null;

// Traverse a built TSL node graph (via getChildren) and collect: referenced texture widths,
// node constructor names, math methods, and numeric ConstNode values. Reachability is from the
// ROOT, so a layer/mask that is not wired into the node does NOT appear (→ falsifiable).
// deno-lint-ignore no-explicit-any
function collect(root: any) {
  const seen = new Set<unknown>();
  const texW = new Set<number>(); const types = new Set<string>(); const methods = new Set<string>(); const consts: number[] = [];
  // deno-lint-ignore no-explicit-any
  function walk(n: any) {
    if (!n || typeof n !== "object" || seen.has(n)) return; seen.add(n);
    const tn = n.constructor?.name; if (tn) types.add(tn);
    if (typeof n.method === "string") methods.add(n.method);
    if (n.isTextureNode && n.value && n.value.image) texW.add(n.value.image.width);
    if (tn === "ConstNode" && typeof n.value === "number") consts.push(n.value);
    if (typeof n.getChildren === "function") for (const c of n.getChildren()) walk(c);
  }
  walk(root);
  return { texW: [...texW], types: [...types], methods: [...methods], consts };
}
const hasConst = (arr: number[], v: number) => arr.some((c) => Math.abs(c - v) < 1e-6);
// The immediate children's constructor/method tags of a (VarNode) root node.
// deno-lint-ignore no-explicit-any
function rootChildTags(root: any): string[] {
  if (typeof root.getChildren !== "function") return [];
  // deno-lint-ignore no-explicit-any
  return [...root.getChildren()].map((k: any) => (k.constructor?.name ?? "?") + (typeof k.method === "string" ? ":" + k.method : ""));
}

const SEED = 1234;
const source = new ProceduralTerrainSource();
const bounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };
const hints = { ...terrainTypeHints("mountains", bounds), erode: 1 };
const tile = source.generateTile({ seed: SEED, tx: 0, tz: 0, lod: 0, hints });
const sea = tile.origin[1] + 0.2 * tile.scale[1];
const minY = tile.origin[1], maxY = tile.origin[1] + tile.scale[1];

// (1) DEFAULT (no pbr/palette/shoreline): flat-colour material — NO colorNode/normalNode/roughnessNode.
const flat = buildTerrainMesh(tile, { color: 0x4a6b3a, roughness: 0.9 });
// deno-lint-ignore no-explicit-any
const fm = flat.material as any;
assert(!isSet(fm.colorNode), "default material must NOT set a colorNode (opt-in / no regression)");
assert(!isSet(fm.normalNode), "default material must NOT set a normalNode (opt-in / no regression)");
assert(!isSet(fm.roughnessNode), "default material must NOT set a roughnessNode (opt-in / no regression)");

// (2) PBR with DISTINCT per-layer scales (so each layer's tiling const is unambiguous) builds.
const SCALE = { rock: 0.13, grass: 0.41, snow: 0.09, sand: 0.57 };
const pbr = buildTerrainMesh(tile, {
  pbr: {
    seaLevel: sea, minY, maxY,
    detail: { rockScale: SCALE.rock, grassScale: SCALE.grass, snowScale: SCALE.snow, sandScale: SCALE.sand },
  },
});
// deno-lint-ignore no-explicit-any
const pm = pbr.material as any;
assert(isSet(pm.colorNode) && isSet(pm.normalNode) && isSet(pm.roughnessNode), "pbr must set colorNode + normalNode + roughnessNode");
assert(pbr.geometry.getAttribute("position").count === tile.nrows * tile.ncols, "pbr geometry vertex count wrong");

const cn = collect(pm.colorNode);
const nn = collect(pm.normalNode);

// (3) NORMAL is a VIEW-SPACE DETAIL normal, not clay (#1 fix, falsifiable).
//   (a) references the shared 256² detail texture → it is NOT the bare geometric normal.
assert(nn.texW.includes(256), "normalNode must reference the shared 256² detail texture (else it collapsed to clay)");
//   (b) its root applies transformNormalToView: the root's immediate child is the Fn call
//       (ShaderCallNodeInternal), NOT a `transformDirection` math node (the inverted-rotation bug).
const nChild = rootChildTags(pm.normalNode);
assert(nChild.includes("ShaderCallNodeInternal"), `normalNode root must wrap the transformNormalToView Fn call (got [${nChild}])`);
assert(!nChild.some((t) => t === "_MathNode:transformDirection"), `normalNode must NOT apply transformDirection at the root (the #1 inverted-rotation bug) (got [${nChild}])`);
//   (c) all four layer detail normals are wired (each layer's distinct scale const reachable).
for (const [k, s] of Object.entries(SCALE)) {
  assert(hasConst(nn.consts, s), `normalNode must reference the ${k} layer detail scale ${s} (layer dropped from the normal blend?)`);
}

// (4) COLOR is the full band-blend over ALL FOUR layers (falsifiable).
//   (a) references BOTH the detail texture (256²) and the per-tile climate texture (TILE_RES²).
assert(cn.texW.includes(256), "colorNode must reference the shared 256² detail texture (procedural layer albedo)");
assert(cn.texW.includes(TILE_RES), `colorNode must reference the ${TILE_RES}² climate texture (biome band modulation)`);
//   (b) all four layer albedos are wired (each layer's distinct scale const reachable from color).
for (const [k, s] of Object.entries(SCALE)) {
  assert(hasConst(cn.consts, s), `colorNode must reference the ${k} layer detail scale ${s} (layer dropped from the albedo blend?)`);
}
//   (c) every band mask is wired — its threshold const reachable from colorNode.
const aboveSpan = Math.max(1e-3, maxY - sea);
const coastBand = Math.max(1e-3, aboveSpan * 0.06);
const subBand = Math.max(0.5, (sea - minY) * 0.6);
const MASKS: [string, number][] = [
  ["rock-lo", 0.32], ["rock-hi", 0.46], ["snow-lo", 0.84], ["snow-hi", 0.95],
  ["cliff-lo", 0.55], ["cliff-hi", 0.82], ["coast", coastBand], ["sub", subBand],
];
for (const [k, v] of MASKS) {
  assert(hasConst(cn.consts, v), `colorNode must reference the ${k} band-mask threshold ${v} (band mix dropped?)`);
}

// (5) PBR with default relief + a NO-climate tile still build (robustness).
const pbr2 = buildTerrainMesh(tile, { pbr: { seaLevel: sea } });
// deno-lint-ignore no-explicit-any
assert(isSet((pbr2.material as any).colorNode) && isSet((pbr2.material as any).normalNode), "pbr with default relief must still build");
const noClimate = { ...tile, climate: undefined, climateChannels: undefined };
const pbr3 = buildTerrainMesh(noClimate, { pbr: { seaLevel: sea } });
// deno-lint-ignore no-explicit-any
assert(isSet((pbr3.material as any).colorNode), "pbr must build even when the tile has no climate grid");

// (6) pbr supersedes palette (normalNode is set ⇒ the PBR path ran, not the flat ramp).
const both = buildTerrainMesh(tile, { palette: { seaLevel: sea }, pbr: { seaLevel: sea } });
// deno-lint-ignore no-explicit-any
assert(isSet((both.material as any).normalNode), "pbr must supersede palette (normalNode set ⇒ PBR path ran)");

// (7) OPT-IN WET-SHORE BAND (falsifiable): with `waterline` set, the wet/foam contact band is
// folded into colorNode (its wetBand + foamBand + darken consts reachable) and the wet roughness
// into roughnessNode — and WITHOUT it none of those consts appear (genuinely opt-in, no default
// regression). Distinctive values so the consts are unambiguous.
const WL = { wetBand: 1.37, foamBand: 0.29, darken: 0.53, wetRoughness: 0.41 };
const wlMesh = buildTerrainMesh(tile, { pbr: { seaLevel: sea, minY, maxY, waterline: WL } });
// deno-lint-ignore no-explicit-any
const wlm = wlMesh.material as any;
const wcn = collect(wlm.colorNode);
const wrn = collect(wlm.roughnessNode);
assert(hasConst(wcn.consts, WL.wetBand), `waterline colorNode must reference the wet band ${WL.wetBand} (wet band not folded into PBR)`);
assert(hasConst(wcn.consts, WL.foamBand), `waterline colorNode must reference the foam band ${WL.foamBand} (foam line not folded into PBR)`);
assert(hasConst(wcn.consts, WL.darken), `waterline colorNode must reference the wet darken ${WL.darken} (wet darkening not applied)`);
assert(hasConst(wrn.consts, WL.wetRoughness), `waterline roughnessNode must reference the wet roughness ${WL.wetRoughness} (wet gloss not applied)`);
// FALSIFIABLE control: the no-waterline PBR (section 2) does NOT carry the wet-band consts.
assert(!hasConst(cn.consts, WL.wetBand) && !hasConst(cn.consts, WL.darken),
  "non-waterline PBR colorNode carries wet-band consts — the band is not actually opt-in");

ops.op_log(
  "p11_terrain_pbr OK: default keeps flat-colour defaults (no colorNode/normalNode/roughnessNode); " +
  "normalNode is VIEW-SPACE detail — refs the 256² detail texture + root wraps transformNormalToView " +
  "(NOT transformDirection) + all 4 layer normals wired; colorNode is the full band-blend — refs detail+" +
  "climate textures + all 4 layer scales + all 8 band-mask thresholds; default-relief/no-climate/" +
  "supersede-palette all build; opt-in wet-shore band folds wet/foam/darken into colorNode + wet " +
  "roughness into roughnessNode (absent when not requested).",
);
