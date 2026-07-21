import {
  DERIVED_SIM_STAGE_SCHEMA,
  SimWorkerController,
  type AuthorCommand,
  type DerivedSimStageSnapshot,
} from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { encodeHydrologyFieldArtifact } from "../src/world/hydrology-artifact.mjs";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { DERIVED_SELF_BINDING_ID_PREFIX } from "../src/world/water-contact.ts";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_water_self_binding FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

let rapier: RapierModule | null = null;
try {
  // @ts-ignore native test runner cannot resolve the bare browser specifier.
  rapier = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (error) {
  throw new Error(`p_derived_water_self_binding FAIL: rapier import failed: ${String(error)}`);
}

// The authored worldlog map used ONLY by case (d) (worldlog binding preempts a self-binding).
const MAP_ASSET_ID = "maps/derived-self-binding.worldmap.json";
const map: any = {
  version: 1,
  id: "derived-self-binding",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 2048, h: 2048 },
  seaLevel: -100,
  land: [], relief: [], biomes: [], waterways: [], waterBodies: [], routes: [], anchors: [],
  provenance: { tool: "design-space", sourceHash: "fixture", contentHash: "0".repeat(64) },
};
map.provenance.contentHash = worldMapContentHash(map);
const mapBytes = new TextEncoder().encode(JSON.stringify(map));

function hash(text: string): string {
  return `sha256:${sha256(new TextEncoder().encode(text))}`;
}

// Two hydrology fields: same 16x16 grid, different sea levels (a "map edit" moves the field hash).
const fieldHeights = new Float64Array(256);
for (let index = 0; index < fieldHeights.length; index++) fieldHeights[index] = (index % 16) * 0.5 + Math.floor(index / 16) * 0.25;
function field(seaLevelM: number): { bytes: Uint8Array; contentHash: string } {
  const bytes = encodeHydrologyFieldArtifact(createHydrologyTopology({
    rows: 16,
    cols: 16,
    heightsM: fieldHeights,
    cellSizeM: 1,
    seaLevelM,
    precipitationMmPerYear: 500,
  }), { originX: 0, originZ: 0 });
  return { bytes, contentHash: `sha256:${sha256(bytes)}` };
}
const fieldA = field(-1);
const fieldB = field(-2);

function water(spillLevelM: number, maxDepthM: number, fieldHash: string): {
  bytes: Uint8Array;
  artifact: Readonly<{ artifactType: string; contentHash: string; byteLength: number; mediaType: string }>;
  bindings: Readonly<{ hydrologyFieldContentHash: string; recipeHash: string; erosionStageKey: string; compilerGraphHash: string }>;
} {
  const bindings = Object.freeze({
    hydrologyFieldContentHash: fieldHash,
    recipeHash: hash("recipe"),
    erosionStageKey: hash("erosion"),
    compilerGraphHash: hash("graph"),
  });
  const bytes = encodeHydrologyWaterArtifact({
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: 1,
    placement: { originX: 0, originZ: 0 },
    rows: 16,
    cols: 16,
    cellSizeM: 1,
    basins: [{
      id: "gen-b-6-5",
      kind: "lake",
      spillLevelM,
      maxDepthM,
      areaM2: 100,
      cellCount: 100,
      seedCell: 5,
      spillInsideCell: 5,
      spillOutsideCell: 6,
      spillOutsideDrainageRank: 6,
      footprint: { points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    }],
    reaches: [],
    diagnostics: {},
  }, bindings);
  return {
    bytes,
    artifact: Object.freeze({
      artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
      contentHash: `sha256:${sha256(bytes)}`,
      byteLength: bytes.byteLength,
      mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
    }),
    bindings,
  };
}
const waterA = water(14, 4, fieldA.contentHash);
const waterB = water(16, 6, fieldA.contentHash); // same field, changed water (revision N -> N+1)
const waterC = water(16, 6, fieldB.contentHash); // moved field identity (map edit rebind)

const MANIFEST_A = hash("manifest-a");
const MANIFEST_B = hash("manifest-b");
const MANIFEST_C = hash("manifest-c");
const MANIFEST_D = hash("manifest-d");
const grid = Object.freeze({
  schema: "limina.terrain-grid/v1",
  gridId: "derived-self-binding",
  origin: Object.freeze([0, 0] as const),
  chunkSizeM: 64,
  defaultSamples: 3,
});

function tile(height: number) {
  return {
    nrows: 3,
    ncols: 3,
    origin: [32, height, 32] as [number, number, number],
    scale: [64, 1, 64] as [number, number, number],
    heights: new Float32Array(9),
  };
}

function snapshot(manifestHash: string, revision: number, w: typeof waterA, f: typeof fieldA, omitField = false): DerivedSimStageSnapshot {
  return {
    schema: DERIVED_SIM_STAGE_SCHEMA,
    projectId: "derived-self-binding",
    branchId: "main",
    source: { revision, headHash: hash(`head-${revision}`) },
    manifestHash,
    grid,
    terrainWindow: [{ key: "0,0", tx: 0, tz: 0, tile: tile(10) }],
    generatedWater: {
      artifact: w.artifact,
      bytes: w.bytes.slice(),
      bindings: w.bindings,
      ...(omitField ? {} : { fieldBytes: f.bytes.slice() }),
    },
  };
}

const bootCommands: AuthorCommand[] = [{ kind: "physics", op: "op_physics_create_world", args: [-9.81] }];

async function controller(): Promise<SimWorkerController> {
  const result = await SimWorkerController.create({
    rapier: rapier as RapierModule,
    assets: [{ id: MAP_ASSET_ID, bytes: mapBytes }],
  });
  const loaded = await result.loadWorldIsolated(bootCommands);
  assert(loaded.failures.length === 0, `boot failed: ${JSON.stringify(loaded.failures)}`);
  return result;
}

function bodyCount(ctrl: SimWorkerController): number {
  const blob = ctrl.world.ops.op_physics_snapshot();
  const metaLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + metaLength))) as { entries: unknown[] };
  return meta.entries.length;
}

// (a) With NO worldlog map binding, a derived revision carrying generated water stages, commits,
// mounts its terrain collider, and makes the verified water queryable through a self-binding.
const ctrl = await controller();
assert(ctrl.core.water.contact.activeBindingId === null && bodyCount(ctrl) === 0, "fixture should begin unbound with no colliders");
const stageA = ctrl.stageDerivedRevision("stage-a", MANIFEST_A, snapshot(MANIFEST_A, 1, waterA, fieldA));
assert(stageA.tick === 0 && bodyCount(ctrl) === 0, "stage mutated physics");
assert(ctrl.core.water.contact.activeBindingId === null, "stage activated the self-binding before commit");
ctrl.commitDerivedRevision("commit-a", "stage-a", MANIFEST_A);
assert(ctrl.derivedRevisionStatus.activeColliderCount === 1 && bodyCount(ctrl) === 1, "commit did not mount the derived terrain collider");
const bindingA = ctrl.core.water.contact.activeBindingId;
assert(bindingA !== null && bindingA.startsWith(DERIVED_SELF_BINDING_ID_PREFIX), `commit did not install a self-binding, got ${bindingA}`);
const wetA = ctrl.core.water.contact.query(1, 1);
assert(wetA.wet && wetA.bodyId === "gen-b-6-5" && wetA.terrainHeightM === 10 && wetA.columnDepthM === 4,
  `self-bound contact is not queryable against derived terrain: ${JSON.stringify(wetA)}`);
const dryA = ctrl.core.water.contact.query(50, 50);
assert(!dryA.wet && dryA.terrainHeightM === 10, `sample above the verified sea level must be dry: ${JSON.stringify(dryA)}`);

// (e) Determinism: a second controller staging+committing the SAME bytes answers identically.
const ctrlReplay = await controller();
ctrlReplay.stageDerivedRevision("stage-a", MANIFEST_A, snapshot(MANIFEST_A, 1, waterA, fieldA));
ctrlReplay.commitDerivedRevision("commit-a", "stage-a", MANIFEST_A);
assert(JSON.stringify(ctrlReplay.core.water.contact.query(1, 1)) === JSON.stringify(wetA)
  && JSON.stringify(ctrlReplay.core.water.contact.query(50, 50)) === JSON.stringify(dryA)
  && ctrlReplay.core.water.contact.activeBindingId === bindingA, "replay of the same bytes did not reproduce the self-bound contact");
const snapshotA = ctrl.world.ops.op_physics_snapshot();
const snapshotReplay = ctrlReplay.world.ops.op_physics_snapshot();
assert(snapshotA.length === snapshotReplay.length && snapshotA.every((value, index) => value === snapshotReplay[index]),
  "replay of the same bytes did not reproduce byte-identical physics");
ctrlReplay.dispose();

// (b) Fail-closed: tampered water bytes, tampered field bytes, and a missing field envelope all
// reject the whole revision without touching the mounted physics or the active contact.
const beforeTamper = ctrl.world.ops.op_physics_snapshot();
const tamperedWater = snapshot(MANIFEST_B, 2, waterB, fieldA);
tamperedWater.generatedWater!.bytes[tamperedWater.generatedWater!.bytes.length - 1] ^= 1;
rejects(() => ctrl.stageDerivedRevision("tampered-water", MANIFEST_B, tamperedWater), /INVALID_DERIVED_WATER|content hash mismatch|verification failed/,
  "sim realm accepted corrupted canonical water bytes");
const tamperedField = snapshot(MANIFEST_B, 2, waterB, fieldA);
tamperedField.generatedWater!.fieldBytes![tamperedField.generatedWater!.fieldBytes!.length - 1] ^= 1;
rejects(() => ctrl.stageDerivedRevision("tampered-field", MANIFEST_B, tamperedField), /INVALID_DERIVED_WATER|pinned field binding|verification failed/,
  "sim realm accepted hydrology field bytes that do not match the pinned binding");
rejects(() => ctrl.stageDerivedRevision("missing-field", MANIFEST_B, snapshot(MANIFEST_B, 2, waterB, fieldA, true)), /requires the pinned hydrology field bytes/,
  "self-binding without the pinned field bytes did not fail closed");
const afterTamper = ctrl.world.ops.op_physics_snapshot();
assert(beforeTamper.length === afterTamper.length && beforeTamper.every((value, index) => value === afterTamper[index]),
  "a rejected revision mutated physics");
assert(JSON.stringify(ctrl.core.water.contact.query(1, 1)) === JSON.stringify(wetA)
  && ctrl.core.water.contact.activeBindingId === bindingA, "a rejected revision mutated the active contact");
assert(ctrl.derivedRevisionStatus.stagedRequestId === null, "a rejected revision left a staged candidate behind");

// (c) Revision N -> N+1 with changed water over the SAME field rebinds cleanly (same self-binding
// id, new generated artifact hash); a moved field identity (map edit) rebinds to a NEW
// self-binding id without wedging the conflict rules.
ctrl.stageDerivedRevision("stage-b", MANIFEST_B, snapshot(MANIFEST_B, 2, waterB, fieldA));
ctrl.commitDerivedRevision("commit-b", "stage-b", MANIFEST_B);
assert(ctrl.core.water.contact.activeBindingId === bindingA, "same-field water revision changed the self-binding identity");
assert(ctrl.core.water.contact.activeGeneratedArtifactContentHash === waterB.artifact.contentHash,
  "revision N+1 water artifact did not rebind");
const wetB = ctrl.core.water.contact.query(1, 1);
assert(wetB.wet && wetB.columnDepthM === 6, `rebound contact did not follow the new water: ${JSON.stringify(wetB)}`);
ctrl.stageDerivedRevision("stage-c", MANIFEST_C, snapshot(MANIFEST_C, 3, waterC, fieldB));
ctrl.commitDerivedRevision("commit-c", "stage-c", MANIFEST_C);
const bindingC = ctrl.core.water.contact.activeBindingId;
assert(bindingC !== null && bindingC.startsWith(DERIVED_SELF_BINDING_ID_PREFIX) && bindingC !== bindingA,
  "map-edit rebind did not move the self-binding identity");
assert(ctrl.core.water.contact.query(1, 1).wet && ctrl.core.water.contact.query(50, 50).wet === false,
  "map-edit rebind left the contact unqueryable");

// (d) A worldlog authored binding arriving while a self-binding is active WINS: the terrain-source
// command preempts the self-binding, the derived reactivation guard does not reinstall it, and the
// next derived revision re-binds the generated water against the authored map.
const authored = await ctrl.loadWorldIsolated([
  { kind: "skill", tool: "world.setTerrainSource", input: { kind: "map", mapAssetId: MAP_ASSET_ID, hash: map.provenance.contentHash } },
]);
assert(authored.failures.length === 0, `authored map binding did not preempt the self-binding: ${JSON.stringify(authored.failures)}`);
assert(ctrl.core.water.contact.activeBindingId === "terrain-source",
  `authored binding did not win over the self-binding: ${ctrl.core.water.contact.activeBindingId}`);
ctrl.stageDerivedRevision("stage-d", MANIFEST_D, snapshot(MANIFEST_D, 4, waterA, fieldA));
ctrl.commitDerivedRevision("commit-d", "stage-d", MANIFEST_D);
assert(ctrl.core.water.contact.activeBindingId === "terrain-source"
  && ctrl.core.water.contact.activeGeneratedArtifactContentHash === waterA.artifact.contentHash,
  "derived revision did not re-bind generated water against the authored map");
const wetD = ctrl.core.water.contact.query(1, 1);
assert(wetD.wet && wetD.bodyId === "gen-b-6-5" && wetD.columnDepthM === 4,
  `authored-map generated contact is wrong: ${JSON.stringify(wetD)}`);

ctrl.dispose();
console.log("[js] p_derived_water_self_binding OK: self-binding from verified artifact identity, fail-closed tamper rejection, same-field rebind, map-edit rebind, worldlog preemption, and byte-exact replay parity proven");
