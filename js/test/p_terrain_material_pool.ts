// Adversarial resource-lifetime gate for elevation-coloured terrain materials.
// Run: limina js/test/p_terrain_material_pool.ts

import {
  buildTerrainMesh,
  disposeTerrainMesh,
  TerrainMaterialPool,
  TerrainStreamRenderer,
} from "../src/terrain/render.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { ops } from "../src/engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_material_pool FAIL: ${message}`);
}

function expectThrow(operation: () => unknown, pattern: RegExp, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof Error && pattern.test(error.message), `${message}: wrong error ${String(error)}`);
    return;
  }
  throw new Error(`p_terrain_material_pool FAIL: ${message}: did not throw`);
}

const source = new ProceduralTerrainSource();
const tileA = source.generateTile({ seed: 91, tx: 0, tz: 0, lod: 0 });
const tileB = source.generateTile({ seed: 91, tx: 1, tz: 0, lod: 0 });
const elevationColors = { seaLevel: 1, amplitude: 18 };

// A pool shares exact material variants inside one world, never across worlds.
const poolA = new TerrainMaterialPool();
const poolB = new TerrainMaterialPool();
const siblingA = buildTerrainMesh(tileA, { elevationColors, roughness: 0.8, metalness: 0.1, materialPool: poolA });
const siblingB = buildTerrainMesh(tileB, { elevationColors, roughness: 0.8, metalness: 0.1, materialPool: poolA });
const isolated = buildTerrainMesh(tileA, { elevationColors, roughness: 0.8, metalness: 0.1, materialPool: poolB });
assert(siblingA.material === siblingB.material, "one pool must reuse an exact material key");
assert(siblingA.material !== isolated.material, "separate world pools must not share materials");

let poolADisposals = 0;
let poolBDisposals = 0;
(siblingA.material as { dispose(): void }).dispose = () => { poolADisposals++; };
(isolated.material as { dispose(): void }).dispose = () => { poolBDisposals++; };

// Removing one tile frees its geometry but cannot invalidate a sibling's pooled material.
disposeTerrainMesh(siblingA);
assert(poolADisposals === 0, "tile disposal must not free a pooled sibling material");
disposeTerrainMesh(siblingB);
assert(poolADisposals === 0, "last tile disposal must still leave ownership with the pool");

// Pool teardown is explicit and exactly-once, including repeated teardown attempts.
poolA.dispose();
poolA.dispose();
assert(poolADisposals === 1, "pool disposal must release its material exactly once");
assert(poolBDisposals === 0, "disposing one world pool must not affect another world");
expectThrow(() => poolA.acquire(0.8, 0.1, false), /disposed/, "disposed pool must reject acquisition");
disposeTerrainMesh(isolated);
assert(poolBDisposals === 0, "tile disposal must not steal ownership from the second pool");
poolB.dispose();
assert(poolBDisposals === 1, "second pool must release its own isolated material");

// Without a pool, an elevation-coloured mesh owns and releases its material normally.
const standalone = buildTerrainMesh(tileA, { elevationColors, roughness: 0.8, metalness: 0.1 });
let standaloneDisposals = 0;
(standalone.material as { dispose(): void }).dispose = () => { standaloneDisposals++; };
disposeTerrainMesh(standalone);
assert(standaloneDisposals === 1, "no-pool mesh must dispose its owned material");

// Pooled keys reject malformed material values and have a hard cardinality bound.
const bounded = new TerrainMaterialPool();
expectThrow(() => bounded.acquire(Number.NaN, 0, false), /roughness/, "NaN roughness must be rejected");
expectThrow(() => bounded.acquire(0.5, 2, false), /metalness/, "out-of-range metalness must be rejected");
for (let i = 0; i < 32; i++) bounded.acquire(i / 32, 0, false);
expectThrow(() => bounded.acquire(1, 0, false), /limited to 32/, "pool must reject an unbounded 33rd exact variant");
bounded.dispose();

// TerrainStreamRenderer creates and tears down its own pool with the streamed world.
const mounted: unknown[] = [];
const streamRenderer = new TerrainStreamRenderer({
  add(child) { mounted.push(child); },
  remove(child) {
    const index = mounted.indexOf(child);
    if (index >= 0) mounted.splice(index, 1);
  },
}, {
  tileSize: 48,
  radius: 0,
  getTile: () => tileA,
  mesh: { elevationColors },
});
streamRenderer.update(0, 0);
assert(mounted.length === 1, "stream renderer must mount its initial tile");
const streamedMaterial = (mounted[0] as { material: { dispose(): void } }).material;
let streamPoolDisposals = 0;
streamedMaterial.dispose = () => { streamPoolDisposals++; };
streamRenderer.clear();
streamRenderer.clear();
assert(mounted.length === 0, "stream renderer clear must remove every tile");
assert(streamPoolDisposals === 1, "stream renderer must dispose its pool exactly once");
expectThrow(() => streamRenderer.update(0, 0), /disposed/, "cleared stream renderer must reject reuse");

ops.op_log(
  "p_terrain_material_pool OK: pools isolate worlds, exact siblings share, tile disposal preserves " +
  "siblings, pool teardown disposes exactly once, standalone meshes own materials, and keys are validated+bounded.",
);
