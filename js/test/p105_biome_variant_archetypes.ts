// P105 — WEIGHTED ARCHETYPE VARIANTS per biome role: a BiomePack role may bind either a
// single asset (back-compat) or `{variants:[{id, weight?, …}]}`, and the per-instance
// archetype pick is the existing seeded cumulative-weight draw in scatterAssets — a pure
// function of (world seed, config). Falsifiable end to end:
//
//   1. RESOLUTION: resolveLayer expands a variants role into a multi-asset palette whose
//      weights are the ROLE weight split proportionally across the variants (role-vs-role
//      mix preserved); a single-entry pack resolves BYTE-IDENTICAL to the pre-variants code.
//   2. DETERMINISM: two independent scatter runs (fresh tiles, fresh source) produce
//      identical per-instance archetype assignments — assetId AND transform, byte-stable.
//   3. NON-VACUOUS: every bound variant genuinely appears among the placements.
//   4. FALSIFIABLE CONTROLS: (a) a single-variant pack collapses to one id (the spread in
//      3 is the variants doing work); (b) an extreme weight skew drives the pick (a pick
//      ignoring weights would place ~50% of the starved id and FAIL); (c) the variant seam
//      remaps ONLY identity through the pre-existing pickRoll — positions/yaw/scale are
//      byte-identical to the single-entry run (the RNG stream is untouched).
//   5. SKILL + MOUNT + REPLAY: world.populateBiome with an inline variants pack scatters
//      through asset.scatter, pins EVERY variant's content hash, mounts one instanced batch
//      per assetId, and replaying the recorded stream recomputes identical assignments.
//
// Run: limina js/test/p105_biome_variant_archetypes.ts   (exit 0 = pass)

import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { terrainTypeHints, type RegionBounds } from "../src/terrain/terrain-types.ts";
import {
  resolveLayer, surveyRegionRelief, type BiomeLayer, type BiomePack,
} from "../src/terrain/biome-content.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p105_biome_variant_archetypes FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
const sameInstances = (a: AssetInstance[], b: AssetInstance[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].assetId !== b[i].assetId) return false;
    for (const k of ["x", "y", "z", "yaw", "scale"] as (keyof AssetInstance)[]) if (!Object.is(a[i][k], b[i][k])) return false;
  }
  return true;
};
// Deep canonicalization (sorted keys) — byte-exact on values, independent of key order.
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};

const SEED = 1234;
const BOUNDS: RegionBounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };

// The four production conifer archetypes (weights 3/3/2/2 — the shipped biome-pack.json mix).
const CONIFER_VARIANTS = [
  { id: "vegetation/temperate-canopy/pine-1.glb", weight: 3, embedRadius: 0.6 },
  { id: "vegetation/temperate-canopy/pine-2.glb", weight: 3, embedRadius: 0.6 },
  { id: "vegetation/temperate-canopy/spruce-1.glb", weight: 2, embedRadius: 0.6 },
  { id: "vegetation/temperate-canopy/spruce-2.glb", weight: 2, embedRadius: 0.6 },
];
const VARIANT_IDS = CONIFER_VARIANTS.map((v) => v.id);
const VARIANT_PACK: BiomePack = { conifer: { variants: CONIFER_VARIANTS } };
const SINGLE_PACK: BiomePack = { conifer: { id: VARIANT_IDS[0], embedRadius: 0.6 } };

// ── 1. RESOLUTION: variants expand into a normalized multi-asset palette ────────────────
const survey = { minY: 0, maxY: 20 };
const layer: BiomeLayer = { seed: 31, assets: [{ role: "conifer" }], coverage: 0.30, slopeMax: 0.8, sizeRange: [0.8, 1.5] };
const variantCfg = resolveLayer(layer, VARIANT_PACK, survey);
const expectedPalette = CONIFER_VARIANTS.map((v) => ({ id: v.id, weight: 1 * (v.weight / 10), embedRadius: 0.6 }));
assert(canon(variantCfg.assets) === canon(expectedPalette),
  `variants palette drifted:\n got ${canon(variantCfg.assets)}\n want ${canon(expectedPalette)}`);
// ROLE-vs-ROLE mix preserved: with a role weight of 3, the variant weights sum to exactly 3's
// proportional split (so a layer's palm-3 : boulder-2 tuning is untouched by variant count).
const weighted = resolveLayer(
  { seed: 81, assets: [{ role: "conifer", weight: 3 }, { role: "boulder", weight: 2 }] },
  { ...VARIANT_PACK, boulder: { id: "rock.glb" } }, survey,
);
const coniferSum = weighted.assets.filter((a) => VARIANT_IDS.includes(a.id)).reduce((s, a) => s + (a.weight ?? 1), 0);
assert(Math.abs(coniferSum - 3) < 1e-12, `conifer variants sum to ${coniferSum}, expected the role weight 3`);
assert(weighted.assets.find((a) => a.id === "rock.glb")?.weight === 2, "boulder role weight perturbed by the variants expansion");
// BACK-COMPAT: a single-entry pack resolves byte-identical to the pre-variants shape
// (no synthesized weight field — the recorded ScatterConfig for existing packs is unchanged).
const singleCfg = resolveLayer(layer, SINGLE_PACK, survey);
assert(canon(singleCfg.assets) === canon([{ id: VARIANT_IDS[0], embedRadius: 0.6 }]),
  `single-entry palette changed (back-compat broken): ${canon(singleCfg.assets)}`);

// ── 2 + 3 + 4. PURE SCATTER: deterministic assignment, non-vacuous spread, controls ─────
function regionTiles(): { tiles: TerrainTile[]; cfg: ScatterConfig; cfgOf: (pack: BiomePack) => ScatterConfig } {
  const src = new ProceduralTerrainSource(); // fresh source per run — proves cross-run stability
  const hints = terrainTypeHints("mountains", BOUNDS);
  const tiles: TerrainTile[] = [];
  for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
    for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) tiles.push(src.generateTile({ seed: SEED, tx, tz, lod: 0, hints }));
  }
  const sv = surveyRegionRelief(src, SEED, BOUNDS, hints);
  const cfgOf = (pack: BiomePack): ScatterConfig => resolveLayer(layer, pack, sv);
  return { tiles, cfg: cfgOf(VARIANT_PACK), cfgOf };
}
function scatterRegion(tiles: TerrainTile[], cfg: ScatterConfig): AssetInstance[] {
  const out: AssetInstance[] = [];
  for (const t of tiles) for (const inst of scatterAssets(t, SEED, cfg)) out.push(inst);
  return out;
}
const runA = regionTiles();
const runB = regionTiles();
const placedA = scatterRegion(runA.tiles, runA.cfg);
const placedB = scatterRegion(runB.tiles, runB.cfg);
assert(placedA.length > 100, `expected a populated forest, got ${placedA.length}`);
// 2. Identical per-instance archetype assignment across independent runs (byte-stable).
assert(sameInstances(placedA, placedB), "archetype assignment diverged between two identical runs (non-deterministic pick)");
// 3. Non-vacuous: EVERY variant appears (the fixed seed makes this a stable, not statistical, fact).
const countsById = new Map<string, number>();
for (const p of placedA) countsById.set(p.assetId, (countsById.get(p.assetId) ?? 0) + 1);
for (const id of VARIANT_IDS) assert((countsById.get(id) ?? 0) > 0, `variant ${id} never placed — the pick is vacuous`);
// 4a. Single-variant control: collapse the pack → every placement is that one id (so the
//     4-way spread above is the variants doing work, not scatter noise).
const singlePlaced = scatterRegion(runA.tiles, runA.cfgOf(SINGLE_PACK));
assert(singlePlaced.every((p) => p.assetId === VARIANT_IDS[0]), "single-entry pack placed a foreign archetype");
// 4b. Weights drive the pick: an extreme skew starves the low-weight variant to ZERO
//     (a broken pick that ignored weights would place ~half of it and fail here).
const skewPlaced = scatterRegion(runA.tiles, runA.cfgOf({
  conifer: { variants: [{ id: VARIANT_IDS[0], weight: 1e9 }, { id: VARIANT_IDS[2], weight: 1e-9 }] },
}));
assert(skewPlaced.length > 0 && skewPlaced.every((p) => p.assetId === VARIANT_IDS[0]),
  "weight skew did not drive the archetype pick (weights are not wired into the cumulative draw)");
// 4c. Identity-only remap: the variant seam reuses the pre-existing per-candidate pickRoll,
//     so positions/yaw/scale are byte-identical to the single-entry run (equal embedRadius) —
//     the RNG stream is provably untouched.
assert(singlePlaced.length === placedA.length, `variant expansion changed the placement count (${placedA.length} vs ${singlePlaced.length})`);
for (let i = 0; i < placedA.length; i++) {
  const a = placedA[i], s = singlePlaced[i];
  assert(Object.is(a.x, s.x) && Object.is(a.y, s.y) && Object.is(a.z, s.z) && Object.is(a.yaw, s.yaw) && Object.is(a.scale, s.scale),
    `instance ${i} transform diverged between variant and single-entry packs (the pick perturbed the RNG stream)`);
}

// ── 5. SKILL + MOUNT + REPLAY: populateBiome with an inline variants pack ───────────────
function makeWorld(worldOps: typeof ops, added?: unknown[]): WorldContext {
  const scene = {
    add(o: unknown) { added?.push(o); }, remove() {},
    position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown,
  };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
function captureScatter(registry: SkillRegistry): { placements: AssetInstance[]; hashes: Record<string, string>[] } {
  const captured = { placements: [] as AssetInstance[], hashes: [] as Record<string, string>[] };
  const inner = registry.invoke.bind(registry);
  registry.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
    if (n === "asset.scatter" && rr.success) {
      const r = rr.result as { placements: AssetInstance[]; assetHashes: Record<string, string> };
      captured.placements.push(...r.placements);
      captured.hashes.push(r.assetHashes);
    }
    return rr;
  });
  return captured;
}
// Inline pack: the 4 production conifer variants + a single-entry boulder (mixed forms in one pack).
const INLINE_PACK = { conifer: { variants: CONIFER_VARIANTS }, boulder: { id: "rock.glb", embedRadius: 0.4 } };

const recorder = new WorldRecorder("ses_p105_rec");
const recReg = new SkillRegistry(new LiminaTracer("ses_p105_rec"));
registerCoreSkills(recReg);
recorder.attach(recReg);
const authCapture = captureScatter(recReg);
const recOps = recorder.wrapOps(ops);
const addedObjects: unknown[] = [];
const recWorld = makeWorld(recOps, addedObjects);
const base = { agentId: "agt_p105", sessionId: "ses_p105_rec", permissions: resolveProfile("builder.readWrite"), tick: 0, world: recWorld };
recOps.op_physics_create_world(-9.81);
const gen = ok(await recReg.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains" }, base));
const pop = ok(await recReg.invoke("world.populateBiome", {
  regionId: gen.regionId as string, biomePack: INLINE_PACK,
}, base));
assert((pop.instances as number) > 0, "populateBiome with a variants pack placed nothing");
assert(authCapture.placements.length === (pop.instances as number), "captured placements != reported instances");
const skillIds = new Set(authCapture.placements.map((p) => p.assetId));
assert(VARIANT_IDS.filter((id) => skillIds.has(id)).length >= 2, `skill path placed fewer than 2 conifer archetypes (${[...skillIds].join(", ")})`);
// Hash pinning: EVERY variant that placed has its content hash pinned in the scatter response
// (the recorder commits assetHashes back into the logged command — all archetypes are pinned).
const coniferHashes = authCapture.hashes.find((h) => VARIANT_IDS.some((id) => h[id] !== undefined));
assert(coniferHashes !== undefined, "no conifer layer hashes captured");
for (const id of VARIANT_IDS) {
  assert(typeof coniferHashes[id] === "string" && coniferHashes[id].startsWith("sha256:"), `variant ${id} hash not pinned`);
}
// MOUNT: one instanced batch per assetId. Every InstancedMesh built for an asset id carries
// count === that id's placement total, so the mounted counts must (a) include every placed
// archetype's total and (b) contain nothing else.
const perId = new Map<string, number>();
for (const p of authCapture.placements) perId.set(p.assetId, (perId.get(p.assetId) ?? 0) + 1);
const instanced = (addedObjects as { isInstancedMesh?: boolean; count?: number }[]).filter((o) => o?.isInstancedMesh === true);
assert(instanced.length >= perId.size, `mounted ${instanced.length} InstancedMesh batches for ${perId.size} distinct assetIds — an archetype has no batch`);
const validCounts = new Set(perId.values());
for (const mesh of instanced) assert(validCounts.has(mesh.count ?? -1), `an InstancedMesh mounted with count ${mesh.count} matching no per-assetId placement total`);
for (const [id, n] of perId) assert(instanced.some((m) => m.count === n), `assetId ${id} (${n} placements) has no mounted batch of that size`);

// REPLAY: the recorded stream (generateRegion + populateBiome-with-variants) recomputes the
// SAME per-instance archetype assignment in a fresh world/registry — byte-identical.
let replayCapture: ReturnType<typeof captureScatter> | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    registerCoreSkills(r);
    replayCapture = captureScatter(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p105_replay"),
});
assert(replayCapture !== undefined && replayCapture.placements.length > 0, "replay re-ran no asset.scatter");
assert(sameInstances(replayCapture.placements, authCapture.placements),
  "replay recomputed a DIFFERENT archetype assignment (variants broke replay determinism)");

ops.op_log(
  `p105_biome_variant_archetypes OK: variants palette normalized (role mix preserved, single-entry byte-identical); ` +
  `${placedA.length} placements assign archetypes deterministically across independent runs (all ${VARIANT_IDS.length} variants appear: ` +
  VARIANT_IDS.map((id) => `${id.split("/").pop()}=${countsById.get(id)}`).join(", ") + `); ` +
  `single-variant + weight-skew controls falsify the pick; transforms byte-identical to the single-entry stream; ` +
  `populateBiome scattered ${pop.instances} instances over ${skillIds.size} assetIds, ${instanced.length} instanced batches mounted, all variant hashes pinned; ` +
  `replay bit-identical (${replayCapture.placements.length} placements).`,
);
