import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerGrassFieldSkill } from "../src/skills/grass-field.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { EditableTerrain } from "../src/skills/terrain-edit.ts";
import { buildGrassFieldCompute, type GrassFieldComputeInput } from "../src/render/grass-field-compute.ts";
import { teardownEntity } from "../src/skills/entity-teardown.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState } from "../src/worldlog/log.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";

function assert(value: boolean, message: string): asserts value { if (!value) throw new Error(`p_grass_field_skill FAIL: ${message}`); }
function collectNodes(root: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [], seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value); const record = value as Record<string, unknown>;
    if (record.isNode === true) nodes.push(record);
    for (const child of Object.values(record)) Array.isArray(child) ? child.forEach(visit) : visit(child);
  };
  visit(root); return nodes;
}
function world(mode: "headless" | "windowed", renderer?: unknown): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: new THREE.Scene() as unknown as WorldContext["scene"], camera: new THREE.PerspectiveCamera() as unknown as WorldContext["camera"],
    ops, mode, renderer };
}
function layer(): EditableTerrain {
  const n = 17, heights = new Float32Array(n * n), paintMat = new Uint8Array(n * n).fill(2), paintW = new Float32Array(n * n).fill(1);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = (r + c) * 0.01;
  return { tile: { nrows: n, ncols: n, origin: [1_000_020, 0, -2_000_004], scale: [24, 1, 24], heights, paintMat, paintW }, mesh: undefined,
    eid: 0, entity: "terrain", bodyId: 0 };
}
const invokeInput = { terrain: "terrain", seed: -17, spacing: 1, tileSize: 24, climate: "summer" };
const perms = resolveProfile("builder.readWrite");
const ok = <T>(response: { success: boolean; result?: unknown; error?: unknown }): T => {
  if (!response.success) throw new Error(`skill failed: ${JSON.stringify(response.error)}`); return response.result as T;
};

const headlessRegistry = new SkillRegistry(new LiminaTracer("grass-field-headless"));
const headlessLayers = new Map([["terrain", layer()]]);
registerGrassFieldSkill(headlessRegistry, headlessLayers, new Map(), new Map(), {}, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
assert(headlessRegistry.describe("vegetation.grassField")?.version === "1.0.0" && headlessRegistry.describe("vegetation.grassField")?.permissions.includes("scene.write") === true,
  "skill is not registered/versioned/scene.write gated");
const deniedWorld = world("headless");
const denied = await headlessRegistry.invoke("vegetation.grassField", invokeInput, { agentId: "p", sessionId: "d", permissions: resolveProfile("player.limited"), tick: 1, world: deniedWorld });
assert(!denied.success && deniedWorld.entities.ids().length === 0, "permission denial mutated world state");
const strict = await headlessRegistry.invoke("vegetation.grassField", { ...invokeInput, unknown: true }, { agentId: "a", sessionId: "s", permissions: perms, tick: 1, world: world("headless") });
assert(!strict.success, "strict schema accepted an unknown field");
const cpuWorld = world("headless");
const cpu = ok<{ entity: string; gridTiles: number; candidateSlots: number; planHash: string }>(await headlessRegistry.invoke("vegetation.grassField", invokeInput,
  { agentId: "a", sessionId: "cpu", permissions: perms, tick: 1, world: cpuWorld }));
assert(cpu.gridTiles >= 1 && cpu.candidateSlots <= cpu.gridTiles * 1024 && /^fnv1a64:/.test(cpu.planHash), `deterministic output shape/bounds are wrong: ${JSON.stringify(cpu)}`);

let dispatches = 0, computeBuilds = 0, computeDisposals = 0;
const computeOrigins: Array<readonly [number, number, number]> = [];
const computeInputs: GrassFieldComputeInput[] = [];
const nativeRenderer = { backend: { isWebGPUBackend: true, isWebGLBackend: false }, hasInitialized: () => true, async computeAsync() { dispatches++; } };
const nativeRegistry = new SkillRegistry(new LiminaTracer("grass-field-native"));
registerGrassFieldSkill(nativeRegistry, new Map([["terrain", layer()]]), new Map(), new Map(), { buildCompute: (input) => {
  computeInputs.push(input);
  computeOrigins.push(input.featureOrigin ?? [0, 0, 0]);
  computeBuilds++; const resource = buildGrassFieldCompute(input); const dispose = resource.dispose;
  return { ...resource, dispose: () => { computeDisposals++; dispose(); } };
} }, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
const nativeWorld = world("windowed", nativeRenderer);
const native = ok<typeof cpu>(await nativeRegistry.invoke("vegetation.grassField", invokeInput,
  { agentId: "a", sessionId: "gpu", permissions: perms, tick: 1, world: nativeWorld }));
assert(JSON.stringify(native) === JSON.stringify(cpu), "CPU/native deterministic output parity failed");
assert(dispatches === cpu.gridTiles && computeBuilds === cpu.gridTiles, "native path did not construct/dispatch every canonical compute page exactly once");
const meshes: THREE.InstancedMesh[] = [];
(nativeWorld.scene as unknown as THREE.Scene).traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) meshes.push(object as THREE.InstancedMesh); });
assert(meshes.length === cpu.gridTiles && meshes.every((mesh, index) => mesh.position.x === computeOrigins[index][0] && mesh.position.z === computeOrigins[index][2]),
  "compute roots are not feature-local under their canonical page origins");
const nativeVisual = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").lod[0];
assert(meshes.every((mesh, index) => {
  const input = computeInputs[index], bounds = input.plan.bounds;
  let minY = Infinity, maxY = -Infinity;
  for (const y of input.heights) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const sizeHi = input.sizeRange?.[1] ?? 1.3;
  const rx = (bounds.maxX - bounds.minX) / 2, rz = (bounds.maxZ - bounds.minZ) / 2;
  const ry = (maxY - minY) / 2 + nativeVisual.maxHeight * sizeHi + nativeVisual.maxHorizontalDisplacement;
  const requiredRadius = Math.sqrt(rx * rx + ry * ry + rz * rz) + nativeVisual.footprintRadius * sizeHi;
  return mesh.boundingSphere !== null && Number.isFinite(mesh.boundingSphere.radius)
    && mesh.boundingSphere.radius + 1e-9 >= requiredRadius;
}), "manual compute bounds do not conservatively cover each canonical page plus blade motion");
const balancedNearBlades = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").bladesPerInstance[0];
assert(meshes.every((mesh) => mesh.geometry.userData.liminaTemperateMeadowBlades === balancedNearBlades),
  "native compute rendering bypassed the injected layered-meadow visual package");
const matrix = new THREE.Matrix4(), identity = new THREE.Matrix4();
for (const mesh of meshes) {
  for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); assert(matrix.equals(identity), "compute path published a non-identity/zero instance matrix"); }
  const graph = mesh.material as THREE.MeshStandardNodeMaterial;
  const storageNodes = collectNodes(graph.positionNode).filter((node) => node.constructor?.name === "BufferAttributeNode");
  assert(storageNodes.length >= 2, "storage-backed root/scale attributes are unreachable from a page material graph");
}
teardownEntity(nativeWorld, native.entity);
assert(computeDisposals === computeBuilds && (nativeWorld.scene as unknown as THREE.Scene).children.length === 0, "runtimeDispose did not remove/dispose every compute page exactly once");

let forbiddenCompute = 0;
const webglRegistry = new SkillRegistry(new LiminaTracer("grass-field-webgl"));
registerGrassFieldSkill(webglRegistry, new Map([["terrain", layer()]]), new Map(), new Map(), { buildCompute: () => { forbiddenCompute++; throw new Error("compute forbidden"); } }, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
const webglWorld = world("windowed", { backend: { isWebGPUBackend: false, isWebGLBackend: true }, hasInitialized: () => true, async computeAsync() { forbiddenCompute++; } });
ok(await webglRegistry.invoke("vegetation.grassField", invokeInput, { agentId: "a", sessionId: "gl", permissions: perms, tick: 1, world: webglWorld }));
assert(forbiddenCompute === 0, "forceWebGL constructed or dispatched compute resources");
const webglMeshes: THREE.InstancedMesh[] = [];
(webglWorld.scene as unknown as THREE.Scene).traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) webglMeshes.push(object as THREE.InstancedMesh); });
assert(webglMeshes.length > 0 && webglMeshes.every((mesh) => mesh.geometry.userData.liminaTemperateMeadowBlades === balancedNearBlades),
  "CPU rendering bypassed the injected layered-meadow visual package");

const missingPackageRegistry = new SkillRegistry(new LiminaTracer("grass-field-missing-package"));
registerGrassFieldSkill(missingPackageRegistry, new Map([["terrain", layer()]]));
const missingPackageWorld = world("windowed", { backend: { isWebGLBackend: true } });
const missingPackage = await missingPackageRegistry.invoke("vegetation.grassField", invokeInput,
  { agentId: "a", sessionId: "missing-package", permissions: perms, tick: 1, world: missingPackageWorld });
assert(!missingPackage.success && missingPackageWorld.entities.ids().length === 0
  && (missingPackageWorld.scene as unknown as THREE.Scene).children.length === 0,
"rendering without a visual package did not fail closed before publication");

let rollbackDisposals = 0, rollbackBuilds = 0;
const rollbackRegistry = new SkillRegistry(new LiminaTracer("grass-field-rollback"));
registerGrassFieldSkill(rollbackRegistry, new Map([["terrain", layer()]]), new Map(), new Map(), { buildCompute: (input) => {
  rollbackBuilds++; if (rollbackBuilds === 2) throw new Error("injected second-tile failure");
  const resource = buildGrassFieldCompute(input), dispose = resource.dispose;
  return { ...resource, dispose: () => { rollbackDisposals++; dispose(); } };
} }, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
const rollbackWorld = world("windowed", nativeRenderer);
const rolled = await rollbackRegistry.invoke("vegetation.grassField", { ...invokeInput, tileSize: 12 }, { agentId: "a", sessionId: "rb", permissions: perms, tick: 1, world: rollbackWorld });
assert(!rolled.success && rollbackDisposals === 1 && rollbackWorld.entities.ids().length === 0 && (rollbackWorld.scene as unknown as THREE.Scene).children.length === 0,
  "multi-tile failure did not roll back unpublished resources/world state");

// A failed tile disposer must not prevent the remaining unpublished tiles from
// being released when a later tile build fails.
let faultRollbackBuilds = 0, faultRollbackDisposals = 0;
const faultRollbackRegistry = new SkillRegistry(new LiminaTracer("grass-field-fault-rollback"));
registerGrassFieldSkill(faultRollbackRegistry, new Map([["terrain", layer()]]), new Map(), new Map(), { buildCompute: (input) => {
  faultRollbackBuilds++;
  if (faultRollbackBuilds === 3) throw new Error("injected third-tile build failure");
  const resource = buildGrassFieldCompute(input), dispose = resource.dispose, ordinal = faultRollbackBuilds;
  return { ...resource, dispose: () => {
    faultRollbackDisposals++;
    dispose();
    if (ordinal === 1) throw new Error("injected first-tile disposal failure");
  } };
} }, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
const faultRollbackWorld = world("windowed", nativeRenderer);
const faultRolled = await faultRollbackRegistry.invoke("vegetation.grassField", { ...invokeInput, tileSize: 12 },
  { agentId: "a", sessionId: "fault-rb", permissions: perms, tick: 1, world: faultRollbackWorld });
assert(!faultRolled.success && faultRollbackBuilds === 3 && faultRollbackDisposals === 2
  && faultRollbackWorld.entities.ids().length === 0 && (faultRollbackWorld.scene as unknown as THREE.Scene).children.length === 0,
"a throwing tile disposer short-circuited unpublished multi-tile rollback");

// Runtime teardown has the same all-attempted guarantee: one tile may fail to
// dispose, but every sibling tile, the scene mount, and retained clear callback
// still have to be released before the AggregateError is surfaced.
let teardownBuilds = 0, teardownDisposals = 0;
const teardownClears = new Map<string, Array<() => void | Promise<void>>>();
const teardownRegistry = new SkillRegistry(new LiminaTracer("grass-field-fault-teardown"));
registerGrassFieldSkill(teardownRegistry, new Map([["terrain", layer()]]), new Map(), teardownClears, { buildCompute: (input) => {
  teardownBuilds++;
  const resource = buildGrassFieldCompute(input), dispose = resource.dispose, ordinal = teardownBuilds;
  return { ...resource, dispose: () => {
    teardownDisposals++;
    dispose();
    if (ordinal === 1) throw new Error("injected runtime tile disposal failure");
  } };
} }, INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
const teardownWorld = world("windowed", nativeRenderer);
const teardownField = ok<typeof cpu>(await teardownRegistry.invoke("vegetation.grassField", { ...invokeInput, tileSize: 12 },
  { agentId: "a", sessionId: "fault-teardown", permissions: perms, tick: 1, world: teardownWorld }));
assert(teardownBuilds > 1 && teardownClears.get("terrain")?.length === 1, "runtime fault fixture did not create multiple tiles and a retained clear callback");
let teardownThrew = false;
try { teardownEntity(teardownWorld, teardownField.entity); } catch (error) { teardownThrew = error instanceof AggregateError; }
assert(teardownThrew && teardownDisposals === teardownBuilds && teardownWorld.entities.ids().length === 0
  && (teardownWorld.scene as unknown as THREE.Scene).children.length === 0 && !teardownClears.has("terrain"),
"runtime cleanup failure leaked sibling tiles, the scene mount, entity identity, or retained clear callback");

// Real recorder/replay over the core terrain layer proves only canonical input/state is authoritative.
const recorder = new WorldRecorder("grass-field-replay"); recorder.seed(77, { forceInstall: true });
const recRegistry = new SkillRegistry(new LiminaTracer("grass-field-rec")); registerCoreSkills(recRegistry); recorder.attach(recRegistry);
const recWorld = world("headless"); recWorld.ops = recorder.wrapOps(ops);
const base = { agentId: "a", sessionId: "grass-field-replay", permissions: perms, tick: 1, world: recWorld };
const terrain = ok<{ entity: string }>(await recRegistry.invoke("terrain.create", { size: 24, resolution: 17 }, base));
await recRegistry.invoke("terrain.paint", { terrain: terrain.entity, center: [0, 0], radius: 40, strength: 1, material: "grass" }, { ...base, tick: 2 });
await recRegistry.invoke("vegetation.grassField", { ...invokeInput, terrain: terrain.entity }, { ...base, tick: 3 });
const recorded = captureWorldState(recWorld);
const replay = await replayCommands(recorder.commands, { makeWorld: () => world("headless"), makeRegistry: (tracer) => { const registry = new SkillRegistry(tracer); registerCoreSkills(registry); return registry; } });
assert(compareWorldState(recorded, replay.state).identical, "record/replay world state diverged");

console.log("p_grass_field_skill OK: schema/permission, bounded deterministic output, CPU/native parity, forceWebGL fallback, identity/storage feature-local compute, all-attempted rollback/disposal, and record-replay are proven");
