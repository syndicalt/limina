import * as THREE from "../build/three.bundle.mjs";
import { DEFAULT_RENDER_QUALITY_PROFILES, type WaterRenderQuality } from "../src/render/quality.ts";
import {
  mountGeneratedWaterResource,
  type VerifiedGeneratedWaterRenderResource,
} from "../src/render/water/generated-water-renderer.ts";
import { createWaterMaterial } from "../src/render/water/material.ts";
import { VisibleWaterManager } from "../src/render/water/visible-water-manager.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_generated_water_renderer FAIL: ${message}`);
}

const ARTIFACT_HASH = `sha256:${"a".repeat(64)}`;
const FAR = 9_000_000;

function resource(): VerifiedGeneratedWaterRenderResource {
  return {
    artifactHash: ARTIFACT_HASH,
    topology: {
      schema: "limina.hydrology-generated-water/v1",
      version: 1,
      basins: [{
        id: "gen-b-1-2",
        spillLevelM: 12,
        footprint: {
          points: [[FAR, FAR], [FAR + 20, FAR], [FAR + 20, FAR + 20], [FAR, FAR + 20]],
          holes: [[[FAR + 6, FAR + 6], [FAR + 6, FAR + 14], [FAR + 14, FAR + 14], [FAR + 14, FAR + 6]]],
        },
      }],
      reaches: [{
        id: "gen-r-3-4",
        class: "river",
        order: 4,
        points: [[FAR, FAR + 40], [FAR + 10, FAR + 40], [FAR + 20, FAR + 40]],
        widths: [2, 4, 8],
        terrainElevationsM: [9, 6, 2],
        surfaceElevationsM: [10, 7, 3],
        waterfalls: [{ startSegment: 0, endSegmentExclusive: 2, totalDropM: 7 }],
      }],
    },
  };
}

function triangleAreaXZ(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  assert(index !== null, "geometry is not indexed");
  let area = 0;
  for (let cursor = 0; cursor < index.count; cursor += 3) {
    const a = index.getX(cursor), b = index.getX(cursor + 1), c = index.getX(cursor + 2);
    area += Math.abs(
      (position.getX(b) - position.getX(a)) * (position.getZ(c) - position.getZ(a))
      - (position.getZ(b) - position.getZ(a)) * (position.getX(c) - position.getX(a)),
    ) / 2;
  }
  return area;
}

function assertUpward(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  assert(index !== null, `${label} is not indexed`);
  for (let cursor = 0; cursor < index.count; cursor += 3) {
    const a = index.getX(cursor), b = index.getX(cursor + 1), c = index.getX(cursor + 2);
    const abx = position.getX(b) - position.getX(a), abz = position.getZ(b) - position.getZ(a);
    const acx = position.getX(c) - position.getX(a), acz = position.getZ(c) - position.getZ(a);
    const normalY = abz * acx - abx * acz;
    if (Math.abs(normalY) > 1e-8) assert(normalY > 0, `${label} has downward winding`);
  }
}

function geometrySignature(manager: VisibleWaterManager): string {
  return JSON.stringify(manager.entries().map((entry) => {
    const position = entry.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = entry.mesh.geometry.getIndex();
    return {
      key: entry.key,
      position: entry.mesh.position.toArray(),
      vertices: Array.from(position.array as ArrayLike<number>),
      index: index === null ? [] : Array.from(index.array as ArrayLike<number>),
    };
  }));
}

const scene = new THREE.Scene();
const manager = new VisibleWaterManager(scene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
const source = resource();
const mounted = mountGeneratedWaterResource(source, manager);
assert(mounted.basinCount === 1 && mounted.reachCount === 1 && mounted.waterfallCount === 1,
  "mount counts do not match topology");
assert(mounted.mountedKeys.length === 3 && manager.size === 3 && scene.children.length === 3,
  "generated fragments were not all mounted");
for (const key of mounted.keys) assert(key.includes(ARTIFACT_HASH), "semantic key omits artifact identity");

const basin = manager.entries().find((entry) => entry.metadata.feature === "basin")!;
assert(Math.abs(triangleAreaXZ(basin.mesh.geometry) - 336) < 1e-4, "basin hole was filled or outer area changed");
assert(Math.abs(basin.mesh.position.x - (FAR + 10)) < 1e-8 && Math.abs(basin.mesh.position.z - (FAR + 10)) < 1e-8,
  "basin feature-local origin is wrong");
const basinPositions = basin.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
for (let index = 0; index < basinPositions.count; index++) {
  assert(Math.abs(basinPositions.getX(index)) <= 10 && Math.abs(basinPositions.getZ(index)) <= 10,
    "basin geometry lost feature-local precision");
}
assertUpward(basin.mesh.geometry, "basin");

const reach = manager.entries().find((entry) => entry.metadata.feature === "reach")!;
assert(reach.metadata.order === 4 && reach.metadata.class === "river" && reach.metadata.gameplayAuthority === false,
  "reach metadata lost hydrology order/class or claimed gameplay authority");
assertUpward(reach.mesh.geometry, "reach");
const reachPositions = reach.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
const reachWorldYs = new Set(Array.from({ length: reachPositions.count }, (_, index) =>
  Math.round((reachPositions.getY(index) + reach.mesh.position.y) * 1e6) / 1e6));
assert(reachWorldYs.has(10) && reachWorldYs.has(7) && reachWorldYs.has(3), "reach did not use exact ordered surface elevations");
assert(Math.abs(reachPositions.getZ(0) - reachPositions.getZ(1)) === 2, "reach start width is not the exact generated width");
assert(Math.abs(reach.mesh.position.x - (FAR + 10)) < 1e-8, "reach geometry lost feature-local origin");

const waterfall = manager.entries().find((entry) => entry.metadata.feature === "waterfall")!;
const fallPosition = waterfall.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
const fallIndex = waterfall.mesh.geometry.getIndex()!;
const fallWorldYs = new Set(Array.from({ length: fallPosition.count }, (_, index) => fallPosition.getY(index) + waterfall.mesh.position.y));
assert(fallWorldYs.has(10) && fallWorldYs.has(3), "waterfall sheet did not span exact surface elevations");
assert(Math.abs(fallPosition.getZ(0) - fallPosition.getZ(1)) === 8, "waterfall sheet did not use downstream width");
const a = fallIndex.getX(0), b = fallIndex.getX(1), c = fallIndex.getX(2);
const ab = new THREE.Vector3().fromBufferAttribute(fallPosition, b).sub(new THREE.Vector3().fromBufferAttribute(fallPosition, a));
const ac = new THREE.Vector3().fromBufferAttribute(fallPosition, c).sub(new THREE.Vector3().fromBufferAttribute(fallPosition, a));
assert(new THREE.Vector3().crossVectors(ab, ac).x < 0, "waterfall front face does not point upstream");
assert(waterfall.metadata.gameplayAuthority === false, "waterfall claimed gameplay authority");

const stableSignature = geometrySignature(manager);
(source.topology.reaches[0].points as [number, number][])[0][0] = -123;
(source.topology.reaches[0].surfaceElevationsM as number[])[0] = 999;
manager.setQuality(DEFAULT_RENDER_QUALITY_PROFILES.performance.water);
assert(geometrySignature(manager) === stableSignature, "quality rebuild read mutable adapter input instead of its verified snapshot");
const rebuiltWaterfall = manager.entries().find((entry) => entry.metadata.feature === "waterfall")!;
assert(rebuiltWaterfall.mesh.children.length === 0 && rebuiltWaterfall.mesh.userData.waterfallExtras === undefined,
  "performance quality created or claimed unbudgeted waterfall foam/mist extras");
const repeat = mountGeneratedWaterResource(source, manager);
assert(repeat.mountedKeys.length === 0 && manager.size === 3 && scene.children.length === 3,
  "semantic repeat allocated duplicate fragments");

const otherScene = new THREE.Scene();
const otherManager = new VisibleWaterManager(otherScene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
const conflictingKey = `generated:${ARTIFACT_HASH}:basin:gen-b-1-2`;
otherManager.mount(conflictingKey, "basin", () => new THREE.Mesh(new THREE.PlaneGeometry(), createWaterMaterial({ color: 0, kind: "basin" })), {}, "wrong-identity");
let conflict: unknown;
try { mountGeneratedWaterResource(resource(), otherManager); } catch (error) { conflict = error; }
assert(conflict instanceof Error && /conflict/.test(conflict.message) && otherManager.size === 1 && otherScene.children.length === 1,
  "semantic conflict was deduplicated or partially mounted");
otherManager.dispose();

let addCount = 0;
const attached = new Set<unknown>();
const faultScene = {
  add(child: unknown): void {
    addCount++;
    if (addCount === 2) throw new Error("injected generated-water scene failure");
    attached.add(child);
  },
  remove(child: unknown): void { attached.delete(child); },
};
const faultManager = new VisibleWaterManager(faultScene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
let lateFailure: unknown;
try { mountGeneratedWaterResource(resource(), faultManager); } catch (error) { lateFailure = error; }
assert(lateFailure instanceof Error && /injected/.test(lateFailure.message) && faultManager.size === 0 && attached.size === 0,
  "late mount failure retained an earlier fragment");

const cappedQuality: WaterRenderQuality = Object.freeze({
  ...DEFAULT_RENDER_QUALITY_PROFILES.performance.water,
  maxResidentFragments: 16,
});
const cappedBasins = Array.from({ length: 17 }, (_, index) => ({
  id: `gen-b-${(index + 1).toString(36)}-${(index + 20).toString(36)}`,
  spillLevelM: 1,
  footprint: { points: [[index * 3, 0], [index * 3 + 2, 0], [index * 3 + 2, 2], [index * 3, 2]] as const, holes: [] },
}));
const cappedResource: VerifiedGeneratedWaterRenderResource = {
  artifactHash: `sha256:${"b".repeat(64)}`,
  topology: { schema: "limina.hydrology-generated-water/v1", version: 1, basins: cappedBasins, reaches: [] },
};
const cappedScene = new THREE.Scene();
const cappedManager = new VisibleWaterManager(cappedScene, cappedQuality);
let capFailure: unknown;
try { mountGeneratedWaterResource(cappedResource, cappedManager); } catch (error) { capFailure = error; }
assert(capFailure instanceof RangeError && /resident budget/.test(capFailure.message)
  && cappedManager.size === 0 && cappedScene.children.length === 0,
"resident cap was enforced after partial geometry mount");

const deterministicA = new VisibleWaterManager(new THREE.Scene(), DEFAULT_RENDER_QUALITY_PROFILES.cinematic.water);
const deterministicB = new VisibleWaterManager(new THREE.Scene(), DEFAULT_RENDER_QUALITY_PROFILES.cinematic.water);
mountGeneratedWaterResource(resource(), deterministicA);
mountGeneratedWaterResource(resource(), deterministicB);
assert(geometrySignature(deterministicA) === geometrySignature(deterministicB), "identical resources produced different geometry");
deterministicA.dispose();
deterministicB.dispose();

let geometryDisposals = 0;
let materialDisposals = 0;
for (const entry of manager.entries()) {
  entry.mesh.geometry.dispose = () => { geometryDisposals++; };
  const materials = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
  for (const material of materials) material.dispose = () => { materialDisposals++; };
}
mounted.dispose();
repeat.dispose();
assert(manager.size === 0 && scene.children.length === 0 && geometryDisposals === 3 && materialDisposals === 3,
  "resource disposal leaked or double-disposed manager-owned render resources");

console.log("p_generated_water_renderer OK: verified adapter, holes/local precision, exact ordered reaches, vertical waterfalls, semantic transactions, caps, quality snapshots, deterministic rebuilds, disposal, and no gameplay authority");
