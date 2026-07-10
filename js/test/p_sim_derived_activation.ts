import {
  DERIVED_SIM_STAGE_SCHEMA,
  SimWorkerController,
  installSimWorker,
  type AuthorCommand,
  type DerivedSimStageSnapshot,
} from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_sim_derived_activation FAIL: ${message}`);
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
  throw new Error(`p_sim_derived_activation FAIL: rapier import failed: ${String(error)}`);
}

const MAP_ASSET_ID = "maps/derived-activation.worldmap.json";
const map: any = {
  version: 1,
  id: "derived-activation",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 2048, h: 2048 },
  seaLevel: -100,
  land: [], relief: [], biomes: [], waterways: [], waterBodies: [], routes: [], anchors: [],
  provenance: { tool: "design-space", sourceHash: "fixture", contentHash: "0".repeat(64) },
};
map.provenance.contentHash = worldMapContentHash(map);
const mapBytes = new TextEncoder().encode(JSON.stringify(map));

const bindings = Object.freeze({
  hydrologyFieldContentHash: `sha256:${"11".repeat(32)}`,
  recipeHash: `sha256:${"22".repeat(32)}`,
  erosionStageKey: `sha256:${"33".repeat(32)}`,
  compilerGraphHash: `sha256:${"44".repeat(32)}`,
});
const waterBytes = encodeHydrologyWaterArtifact({
  schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  version: 1,
  placement: { originX: 0, originZ: 0 },
  rows: 16,
  cols: 16,
  cellSizeM: 1,
  basins: [{
    id: "gen-b-6-5",
    kind: "lake",
    spillLevelM: 14,
    maxDepthM: 4,
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
const waterArtifact = Object.freeze({
  artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
  contentHash: `sha256:${sha256(waterBytes)}`,
  byteLength: waterBytes.byteLength,
  mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
});
const MANIFEST_A = `sha256:${"a1".repeat(32)}`;
const MANIFEST_B = `sha256:${"b2".repeat(32)}`;
const MANIFEST_C = `sha256:${"c3".repeat(32)}`;
const grid = Object.freeze({
  schema: "limina.terrain-grid/v1",
  gridId: "derived-uat",
  origin: Object.freeze([0, 0] as const),
  chunkSizeM: 64,
  defaultSamples: 3,
});

function tile(tx: number, tz: number, height: number) {
  return {
    nrows: 3,
    ncols: 3,
    origin: [32 + tx * 64, height, 32 + tz * 64] as [number, number, number],
    scale: [64, 1, 64] as [number, number, number],
    heights: new Float32Array(9),
  };
}

function snapshot(manifestHash: string, tiles = [{ key: "0,0", tx: 0, tz: 0, tile: tile(0, 0, 10) }], includeWater = true): DerivedSimStageSnapshot {
  return {
    schema: DERIVED_SIM_STAGE_SCHEMA,
    projectId: "derived-activation",
    branchId: "main",
    source: { revision: manifestHash === MANIFEST_A ? 1 : manifestHash === MANIFEST_B ? 2 : 3, headHash: `sha256:${"dd".repeat(32)}` },
    manifestHash,
    grid,
    terrainWindow: tiles,
    ...(includeWater ? { generatedWater: { artifact: waterArtifact, bytes: waterBytes.slice(), bindings } } : {}),
  };
}

const initialCommands: AuthorCommand[] = [
  { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
  { kind: "skill", tool: "world.setTerrainSource", input: { kind: "map", mapAssetId: MAP_ASSET_ID, hash: map.provenance.contentHash } },
  { kind: "skill", tool: "terrain.create", input: { size: 64, resolution: 3, origin: [32, 0, 32], baseHeight: 0 } },
];

async function controller(): Promise<SimWorkerController> {
  const result = await SimWorkerController.create({
    rapier: rapier as RapierModule,
    assets: [{ id: MAP_ASSET_ID, bytes: mapBytes }],
  });
  const loaded = await result.loadWorldIsolated(initialCommands);
  assert(loaded.failures.length === 0, `initial authored map failed: ${JSON.stringify(loaded.failures)}`);
  return result;
}

function bodyCount(ctrl: SimWorkerController): number {
  const blob = ctrl.world.ops.op_physics_snapshot();
  const metaLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + metaLength))) as { entries: unknown[] };
  return meta.entries.length;
}

// Stage is pure with respect to gameplay/collision authority, yet independently verifies raw
// generated bytes and creates exactly one bounded candidate.
const ctrl = await controller();
const authoredBodies = bodyCount(ctrl);
assert(authoredBodies === 1, `fixture should begin with one authored terrain collider, got ${authoredBodies}`);
const authoredContact = ctrl.core.water.contact.query(1, 1);
const authoredOutsideWindow = ctrl.core.water.contact.query(100, 100);
const stageA = ctrl.stageDerivedRevision("stage-a", MANIFEST_A, snapshot(MANIFEST_A));
assert(stageA.tick === 0 && bodyCount(ctrl) === authoredBodies, "stage mutated physics or tick status");
assert(ctrl.core.water.contact.activeGeneratedArtifactContentHash === null
  && JSON.stringify(ctrl.core.water.contact.query(1, 1)) === JSON.stringify(authoredContact), "stage mutated active water contact");
assert(ctrl.derivedRevisionStatus.stagedRequestId === "stage-a"
  && ctrl.derivedRevisionStatus.activeManifestHash === null, "stage status is wrong");
const oversizedWindow = Array.from({ length: 226 }, (_, tx) => ({ key: `${tx},0`, tx, tz: 0, tile: tile(tx, 0, 10) }));
rejects(() => ctrl.stageDerivedRevision("oversized", MANIFEST_B, snapshot(MANIFEST_B, oversizedWindow, false)), /1-225/,
  "stage accepted more than the bounded 15x15 terrain residency budget");
assert(ctrl.derivedRevisionStatus.stagedRequestId === "stage-a", "oversized stage evicted the valid bounded candidate");

const corrupt = snapshot(MANIFEST_B);
corrupt.generatedWater!.bytes[corrupt.generatedWater!.bytes.length - 1] ^= 1;
rejects(() => ctrl.stageDerivedRevision("corrupt", MANIFEST_B, corrupt), /content hash mismatch|verification failed/,
  "sim realm accepted corrupted canonical water bytes");
assert(ctrl.derivedRevisionStatus.stagedRequestId === "stage-a", "failed realm verification replaced the valid stage");
rejects(() => ctrl.stageDerivedRevision("wrong-manifest", MANIFEST_B, snapshot(MANIFEST_A)), /does not match/,
  "outer manifest binding was not enforced");

const committedA = ctrl.commitDerivedRevision("commit-a", "stage-a", MANIFEST_A);
assert(committedA.tick === 0 && ctrl.ticks === 0, "commit advanced or raced a fixed tick");
assert(ctrl.derivedRevisionStatus.activeManifestHash === MANIFEST_A
  && ctrl.derivedRevisionStatus.activeColliderCount === 1, "commit did not activate the derived collider set");
assert(bodyCount(ctrl) === 1, "commit did not replace the authored collider one-for-one");
const wet = ctrl.core.water.contact.query(1, 1);
assert(wet.wet && wet.bodyId === "gen-b-6-5" && wet.terrainHeightM === 10 && wet.columnDepthM === 4,
  `commit did not bind generated contact to indexed terrain: ${JSON.stringify(wet)}`);
assert(ctrl.core.water.contact.query(100, 100).terrainHeightM === authoredOutsideWindow.terrainHeightM,
  "derived contact did not fall back to the prior active terrain sampler outside its resident window");
ctrl.tick();
assert(ctrl.ticks === 1, "post-commit tick did not serialize after the unchanged commit tick");

// A partial collider allocation failure restores the exact physics snapshot, retains the staged
// candidate for retry/discard, and leaves the prior contact/collider revision active.
const twoTiles = [
  { key: "0,0", tx: 0, tz: 0, tile: tile(0, 0, 20) },
  { key: "1,0", tx: 1, tz: 0, tile: tile(1, 0, 20) },
];
ctrl.stageDerivedRevision("stage-b", MANIFEST_B, snapshot(MANIFEST_B, twoTiles));
const beforeFailedCommit = ctrl.world.ops.op_physics_snapshot();
const originalAdd = ctrl.world.ops.op_physics_add_heightfield;
let addCalls = 0;
ctrl.world.ops.op_physics_add_heightfield = (...args) => {
  addCalls++;
  if (addCalls === 2) throw new Error("injected second collider failure");
  return originalAdd(...args);
};
rejects(() => ctrl.commitDerivedRevision("commit-b", "stage-b", MANIFEST_B), /injected second collider failure/,
  "partial commit did not fail");
ctrl.world.ops.op_physics_add_heightfield = originalAdd;
const afterFailedCommit = ctrl.world.ops.op_physics_snapshot();
assert(beforeFailedCommit.length === afterFailedCommit.length
  && beforeFailedCommit.every((value, index) => value === afterFailedCommit[index]), "failed commit did not restore exact physics bytes");
assert(ctrl.derivedRevisionStatus.activeManifestHash === MANIFEST_A
  && ctrl.derivedRevisionStatus.stagedRequestId === "stage-b", "failed commit changed active state or dropped its retry candidate");
assert(ctrl.core.water.contact.activeGeneratedArtifactContentHash === waterArtifact.contentHash
  && ctrl.core.water.contact.query(1, 1).terrainHeightM === 10, "failed commit changed active contact/sampler");

rejects(() => ctrl.commitDerivedRevision("stale", "stage-a", MANIFEST_A), /currently staged/,
  "stale committed stage id was accepted");
assert(ctrl.discardDerivedRevision("discard-b", "stage-b", MANIFEST_B).discarded, "matching stage was not discarded");
assert(!ctrl.discardDerivedRevision("discard-b-again", "stage-b", MANIFEST_B).discarded, "matching discard was not idempotent");
rejects(() => ctrl.discardDerivedRevision("discard-stale", "stage-a", MANIFEST_A), /currently staged or last-discarded/,
  "arbitrary stale discard was accepted");

// At most one candidate is retained: a later successful stage invalidates the earlier ID.
ctrl.stageDerivedRevision("stage-replaced", MANIFEST_B, snapshot(MANIFEST_B, twoTiles, false));
ctrl.stageDerivedRevision("stage-c", MANIFEST_C, snapshot(MANIFEST_C, twoTiles, false));
assert(ctrl.derivedRevisionStatus.stagedRequestId === "stage-c", "stage replacement retained the wrong candidate");
rejects(() => ctrl.commitDerivedRevision("commit-replaced", "stage-replaced", MANIFEST_B), /currently staged/,
  "replaced stage remained commit-capable");
ctrl.discardDerivedRevision("discard-c", "stage-c", MANIFEST_C);

// Later terrain authoring is retained as editable state but its collider is immediately suppressed
// while the derived collision presentation remains live.
const beforeLateAuthoring = bodyCount(ctrl);
const late = await ctrl.loadWorldIsolated([{
  kind: "skill",
  tool: "terrain.create",
  input: { size: 32, resolution: 3, origin: [1000, 100, 1000], baseHeight: 0 },
}]);
assert(late.failures.length === 0 && ctrl.core.terrain.layers.size === 2, "late terrain authoring did not remain editable");
assert(bodyCount(ctrl) === beforeLateAuthoring, "late authored terrain reintroduced a collider while derived was active");
const ray = new Float32Array(6);
ctrl.world.ops.op_physics_raycast(1000, 200, 1000, 0, -1, 0, 200, ray);
assert(ray[0] === 0, "suppressed late authored terrain remained raycast-visible");

// Exercise the exact worker-shell request/response contract through an injected controller. The
// pause and commit ACKs report the same completed tick; the next explicit step advances it once.
const shellController = await controller();
const posts: any[] = [];
const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (message: unknown) => posts.push(message) };
installSimWorker(scope, { createController: async () => shellController });
async function send(message: unknown, expectedType: string): Promise<any> {
  const start = posts.length;
  scope.onmessage?.({ data: message });
  for (let attempt = 0; attempt < 50; attempt++) {
    await Promise.resolve();
    const found = posts.slice(start).find((post) => post?.type === expectedType);
    if (found !== undefined) return found;
  }
  throw new Error(`p_sim_derived_activation FAIL: shell did not post '${expectedType}': ${JSON.stringify(posts.slice(start))}`);
}
await send({ type: "init", hz: 1 }, "ready");
const paused = await send({ type: "pause", requestId: 1 }, "paused");
const shellStage = await send({ type: "stageDerivedRevision", requestId: "shell-stage", manifestHash: MANIFEST_A, snapshot: snapshot(MANIFEST_A) }, "derivedRevisionStaged");
const shellCommit = await send({ type: "commitDerivedRevision", requestId: "shell-commit", stagedRequestId: "shell-stage", manifestHash: MANIFEST_A }, "derivedRevisionCommitted");
assert(paused.tick === shellStage.tick && shellStage.tick === shellCommit.tick, "shell commit was not serialized at one completed tick");
const malformed = await send({ type: "commitDerivedRevision", requestId: "bad id with spaces", stagedRequestId: "shell-stage", manifestHash: MANIFEST_A }, "derivedRevisionRejected");
assert(malformed.code === "INVALID_DERIVED_MESSAGE", "shell did not reject an invalid bounded request id structurally");
shellController.tick();
assert(shellController.ticks === shellCommit.tick + 1, "next fixed tick did not begin after the shell commit ACK boundary");
scope.onmessage?.({ data: { type: "stop" } });

ctrl.dispose();
console.log("[js] p_sim_derived_activation OK: bounded exact two-phase sim staging, independent realm verification, atomic collider/contact commit with byte-exact rollback, stale/replacement/discard rules, authored-collider suppression, prior-sampler fallback, and fixed-tick shell ACK serialization proven");
