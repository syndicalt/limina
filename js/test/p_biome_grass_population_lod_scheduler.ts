import * as THREE from "../build/three.bundle.mjs";
import {
  BiomeGrassPopulationRuntime,
  type BiomeGrassPopulationBuildScheduler,
} from "../src/render/biome-grass-population-runtime.ts";
import {
  GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  type GrassFieldVisualBuildContext,
  type GrassFieldVisualPackage,
  type GrassFieldVisualProfile,
} from "../src/render/grass-field-package.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_grass_population_lod_scheduler FAIL: ${message}`);
}

interface ManualJob {
  readonly work: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

class ManualScheduler {
  readonly jobs: ManualJob[] = [];
  scheduled = 0;
  readonly schedule: BiomeGrassPopulationBuildScheduler = <Result>(work: () => Result) => {
    this.scheduled++;
    return new Promise<Result>((resolve, reject) => {
      this.jobs.push({ work, resolve: resolve as (value: unknown) => void, reject });
    });
  };

  runNext(): void {
    const job = this.jobs.shift();
    if (job === undefined) throw new Error("manual grass scheduler has no pending job");
    try { job.resolve(job.work()); } catch (error) { job.reject(error); }
  }
}

async function flushMicrotasks(): Promise<void> {
  // The mount continuation and its finally each occupy one promise turn. This is deterministic
  // queue advancement, not a wall-clock/timing assertion.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

const profile: GrassFieldVisualProfile = Object.freeze({
  maxResidentBlades: 64,
  bladesPerInstance: Object.freeze([3, 1]) as readonly [number, number],
  bladesPerSquareMeter: Object.freeze([12, 3]) as readonly [number, number],
  radius: 2,
  fineRadius: 1,
  spacingMultipliers: Object.freeze([1, 1]) as readonly [number, number],
  lod: Object.freeze([
    Object.freeze({ maxHeight: 0.5, maxHorizontalDisplacement: 0.1, footprintRadius: 0.1,
      fade: Object.freeze({ start: 10, end: 20 }) }),
    Object.freeze({ maxHeight: 0.3, maxHorizontalDisplacement: 0.05, footprintRadius: 0.08,
      fade: Object.freeze({ start: 20, end: 60 }) }),
  ]),
});

const geometryBuilds: number[] = [], materialBuilds: number[] = [];
let pageGeometryBuilds = 0, pageGeometryDisposals = 0, templateDisposals = 0, materialDisposals = 0;
const visualPackage: GrassFieldVisualPackage = Object.freeze({
  schema: GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  id: "test.grass.scheduler-cache",
  version: "1.0.0",
  variants: Object.freeze(["summer"]),
  profile: () => profile,
  createGeometry(context: GrassFieldVisualBuildContext) {
    geometryBuilds.push(context.lod);
    const geometry = new THREE.BoxGeometry(0.2, context.lod === 0 ? 0.5 : 0.25, 0.1);
    geometry.addEventListener("dispose", () => templateDisposals++);
    const clone = geometry.clone.bind(geometry);
    geometry.clone = () => {
      pageGeometryBuilds++;
      const page = clone();
      page.addEventListener("dispose", () => pageGeometryDisposals++);
      return page;
    };
    return geometry;
  },
  createMaterial(context: GrassFieldVisualBuildContext) {
    materialBuilds.push(context.lod);
    const material = new THREE.MeshBasicMaterial({ color: context.lod === 0 ? 0x228833 : 0x446622 });
    material.addEventListener("dispose", () => materialDisposals++);
    return material;
  },
});

const scheduler = new ManualScheduler(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
camera.position.set(9.5, 2, 0);
const runtime = new BiomeGrassPopulationRuntime({
  role: "flora/scheduler-test",
  placements: [
    { x: 0, y: 1, z: 0, yaw: 0.25, scale: 1, pageX: 0, pageZ: 0 },
    { x: 0, y: 1, z: 0, yaw: 0.75, scale: 0.9, pageX: 0, pageZ: 0 },
  ],
  visualPackage,
  quality: "cinematic",
  variant: "summer",
  bladeScale: [0.8, 1.2],
  scene,
  lodHysteresis: 0.1,
  buildScheduler: scheduler.schedule,
});
runtime.initialize(camera); runtime.publish();

function mountedMesh(): THREE.InstancedMesh {
  const mesh = runtime.root.children.find((child) => (child as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh | undefined;
  if (mesh === undefined) throw new Error("grass scheduler fixture has no mounted mesh");
  return mesh;
}
function contentSnapshot(): string {
  const mesh = mountedMesh(), wind = mesh.geometry.getAttribute("aWind");
  return JSON.stringify({ matrix: Array.from(mesh.instanceMatrix.array), wind: Array.from(wind.array) });
}

assert(runtime.draws === 1 && runtime.lods.has(0) && runtime.cachedVisuals === 1,
  "initial staged page did not own exactly one cached LOD0 visual");
const initialContent = contentSnapshot();
const initialGeometry = mountedMesh().geometry;

// The authored transition is 10m and the 10% band exits LOD0 only beyond 11m. Repeated boundary
// jitter must therefore allocate no work and preserve the exact active object.
for (const x of [10.1, 9.9, 10.8, 9.2, 10.4]) {
  camera.position.x = x; runtime.update(camera);
}
assert(scheduler.scheduled === 0 && scheduler.jobs.length === 0 && runtime.pendingBuilds === 0 && mountedMesh().name.endsWith("lod0"),
  "fine-boundary jitter rebuilt or changed the active LOD inside the hysteresis band");

// Multiple updates while one job is pending may revise its generation, but may never enqueue a
// second build. Execute the candidate, then move back before its promise continuation publishes.
camera.position.x = 12; runtime.update(camera);
camera.position.x = 13; runtime.update(camera);
assert(scheduler.jobs.length === 1 && runtime.pendingBuilds === 1,
  "camera updates admitted more than the one bounded pending build");
scheduler.runNext();
camera.position.x = 0; runtime.update(camera);
await flushMicrotasks();
assert(runtime.pendingBuilds === 0 && scheduler.jobs.length === 0 && mountedMesh().name.endsWith("lod0")
  && runtime.recycledGeometries === 1 && pageGeometryDisposals === 0,
  "a stale completed LOD1 candidate published or leaked after its generation changed");

// A later valid LOD1 build reuses the already-created package resources. Returning to LOD0 must
// likewise reuse its template/material and reproduce deterministic instance bytes exactly.
camera.position.x = 12; runtime.update(camera);
assert(scheduler.jobs.length === 1 && runtime.pendingBuilds === 1, "valid LOD1 replacement was not deferred");
scheduler.runNext(); await flushMicrotasks();
assert(runtime.lods.has(1) && geometryBuilds.join(",") === "0,1" && materialBuilds.join(",") === "0,1"
  && runtime.cachedVisuals === 2, "package visuals were rebuilt instead of cached once per LOD");
assert(typeof mountedMesh().userData.liminaGrassVisualCacheKey === "string",
  "mounted page did not retain its exact package/quality/variant/LOD cache identity");

// The 60m cull boundary uses the same outward deadband: once resident, the page survives through
// 66m without scheduling or rebuilding. This prevents range-edge unload/reload churn.
const scheduledBeforeCullJitter = scheduler.scheduled;
for (const x of [60.5, 59.7, 65, 60.2]) { camera.position.x = x; runtime.update(camera); }
assert(runtime.draws === 1 && runtime.lods.has(1) && scheduler.scheduled === scheduledBeforeCullJitter
  && runtime.pendingBuilds === 0, "cull-boundary jitter retired or rebuilt a resident page inside its hysteresis band");

camera.position.x = 8; runtime.update(camera);
assert(scheduler.jobs.length === 1 && runtime.pendingBuilds === 1, "LOD1-to-LOD0 replacement was not bounded and deferred");
scheduler.runNext(); await flushMicrotasks();
assert(runtime.lods.has(0) && geometryBuilds.length === 2 && materialBuilds.length === 2,
  "returning to a cached LOD rebuilt package geometry or material");
assert(pageGeometryBuilds === 2 && mountedMesh().geometry === initialGeometry,
  "LOD round-trip did not reuse the exact bounded page-local geometry wrapper");
assert(contentSnapshot() === initialContent, "cached LOD round-trip changed deterministic placement transforms or wind roots");

// Disposal can race a completed-but-unpublished candidate. Active pages and cache resources retire
// synchronously; the sole late result is generation-rejected and retired when its promise settles.
camera.position.x = 12; runtime.update(camera);
assert(runtime.pendingBuilds === 1 && scheduler.jobs.length === 1, "terminal-race fixture did not hold one candidate");
scheduler.runNext(); runtime.dispose();
assert(runtime.draws === 0 && runtime.cachedVisuals === 0 && scene.children.length === 0,
  "terminal disposal retained active pages, cached resources, or scene publication");
await runtime.settle(); await flushMicrotasks();
assert(runtime.pendingBuilds === 0 && pageGeometryDisposals === pageGeometryBuilds,
  "terminal generation rejection leaked a page-local geometry");
assert(templateDisposals === 2 && materialDisposals === 2,
  "shared package resources were not disposed exactly once per cached LOD");
assert(runtime.takeErrors().length === 0, "scheduler/cache lifecycle reported an unexpected error");

// Exercise the recycle ceiling with more retired pages than a cache may hold. Every transition is
// still one-pending, only eight idle wrappers survive per LOD, and the terminal count proves that
// overflow wrappers plus retained wrappers all have one owner and one disposal.
const boundedBuildBase = pageGeometryBuilds, boundedDisposalBase = pageGeometryDisposals;
const boundedTemplateBase = templateDisposals, boundedMaterialBase = materialDisposals;
const boundedScheduler = new ManualScheduler(), boundedScene = new THREE.Scene(), boundedCamera = new THREE.PerspectiveCamera();
boundedCamera.position.set(0, 2, 0);
const bounded = new BiomeGrassPopulationRuntime({
  role: "flora/bounded-cache-test",
  placements: Array.from({ length: 12 }, (_, pageX) => ({
    x: 0, y: 1, z: 0, yaw: pageX * 0.1, scale: 1, pageX, pageZ: 0,
  })),
  visualPackage,
  quality: "cinematic",
  variant: "summer",
  bladeScale: [1, 1],
  scene: boundedScene,
  lodHysteresis: 0.1,
  buildScheduler: boundedScheduler.schedule,
});
bounded.initialize(boundedCamera); bounded.publish();
assert(bounded.draws === 12, "bounded-cache fixture did not stage all twelve independent pages");

async function drainBounded(): Promise<void> {
  let advances = 0;
  while (bounded.pendingBuilds > 0 || boundedScheduler.jobs.length > 0) {
    assert(bounded.pendingBuilds <= 1 && boundedScheduler.jobs.length <= 1,
      "multi-page transition exceeded one pending build");
    if (boundedScheduler.jobs.length === 1) boundedScheduler.runNext();
    await flushMicrotasks();
    if (++advances > 24) throw new Error("bounded grass transition did not converge within its page bound");
  }
}

boundedCamera.position.x = 12; bounded.update(boundedCamera); await drainBounded();
assert(bounded.draws === 12 && bounded.lods.size === 1 && bounded.lods.has(1) && bounded.recycledGeometries === 8,
  "LOD0 retirement exceeded the per-LOD eight-geometry recycle ceiling");
boundedCamera.position.x = 0; bounded.update(boundedCamera); await drainBounded();
assert(bounded.draws === 12 && bounded.lods.size === 1 && bounded.lods.has(0) && bounded.recycledGeometries === 8,
  "LOD1 retirement exceeded the per-LOD eight-geometry recycle ceiling");
assert(pageGeometryBuilds - boundedBuildBase === 28,
  "bounded cache did not reuse eight LOD0 wrappers and allocate only the four-page shortfall");
bounded.dispose(); await bounded.settle();
assert(pageGeometryDisposals - boundedDisposalBase === pageGeometryBuilds - boundedBuildBase,
  "bounded cache overflow or terminal cleanup leaked/double-disposed page geometries");
assert(templateDisposals - boundedTemplateBase === 2 && materialDisposals - boundedMaterialBase === 2,
  "bounded cache did not retire exactly its two package/LOD templates and materials");
assert(boundedScene.children.length === 0 && bounded.takeErrors().length === 0,
  "bounded cache fixture retained publication or reported an unexpected lifecycle error");

console.log("p_biome_grass_population_lod_scheduler OK: hysteresis, one-pending deferred work, stale-result rejection, deterministic cache reuse, and bounded cleanup proven");
