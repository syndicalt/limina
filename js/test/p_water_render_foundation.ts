import * as THREE from "../build/three.bundle.mjs";
import { buildVariableRiverRibbonGeometry, buildWaterFootprintGeometry } from "../src/render/water/geometry.ts";
import { createWaterMaterial } from "../src/render/water/material.ts";
import { VisibleWaterManager } from "../src/render/water/visible-water-manager.ts";
import { DEFAULT_RENDER_QUALITY_PROFILES } from "../src/render/quality.ts";
import { WaterContactRuntime } from "../src/world/water-contact.ts";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_water_render_foundation FAIL: ${message}`);
}

function triangleAreaXZ(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  assert(index !== null, "geometry is not indexed");
  let area = 0;
  for (let cursor = 0; cursor < index.count; cursor += 3) {
    const a = index.getX(cursor), b = index.getX(cursor + 1), c = index.getX(cursor + 2);
    const ax = position.getX(a), az = position.getZ(a);
    const bx = position.getX(b), bz = position.getZ(b);
    const cx = position.getX(c), cz = position.getZ(c);
    area += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  }
  return area;
}

function assertUpwardTriangles(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  assert(index !== null, `${label} geometry is not indexed`);
  for (let cursor = 0; cursor < index.count; cursor += 3) {
    const a = index.getX(cursor), b = index.getX(cursor + 1), c = index.getX(cursor + 2);
    const abx = position.getX(b) - position.getX(a), abz = position.getZ(b) - position.getZ(a);
    const acx = position.getX(c) - position.getX(a), acz = position.getZ(c) - position.getZ(a);
    const normalY = abz * acx - abx * acz;
    if (Math.abs(normalY) > 1e-8) assert(normalY > 0, `${label} contains a downward-facing triangle`);
  }
}

const basin = buildWaterFootprintGeometry({
  outer: [[1_000_000, 1_000_000], [1_000_020, 1_000_000], [1_000_020, 1_000_020], [1_000_000, 1_000_020]],
  holes: [[[1_000_006, 1_000_006], [1_000_006, 1_000_014], [1_000_014, 1_000_014], [1_000_014, 1_000_006]]],
});
assert(Math.abs(triangleAreaXZ(basin.geometry) - (400 - 64)) < 1e-4, "outer-minus-hole triangulated area changed");
const basinPosition = basin.geometry.getAttribute("position") as THREE.BufferAttribute;
for (let index = 0; index < basinPosition.count; index++) {
  assert(Math.abs(basinPosition.getX(index)) <= 10 && Math.abs(basinPosition.getZ(index)) <= 10, "basin vertices were not feature-local");
}

const points = [[0, 0], [10, 0], [10, 0], [10.01, 10], [20, 10]] as const;
const ribbon = buildVariableRiverRibbonGeometry({
  points,
  widthsM: [2, 4, 5, 8, 10],
  surfaceElevationsM: [4, 3.5, 3.25, 2, 1],
  miterLimit: 1,
});
assert(ribbon.pointCount === 4 && ribbon.segmentCount === 3, "consecutive duplicate centerline point was not collapsed");
assert(ribbon.bevelJoinCount >= 1, "sharp join did not use the bounded bevel fallback");
const riverPosition = ribbon.geometry.getAttribute("position") as THREE.BufferAttribute;
const arc = ribbon.geometry.getAttribute("waterArcDistance") as THREE.BufferAttribute;
const flow = ribbon.geometry.getAttribute("waterFlowDirection") as THREE.BufferAttribute;
assert(riverPosition.count === arc.count && arc.count === flow.count, "flow attributes are not vertex-aligned");
assert(arc.getX(arc.count - 1) <= ribbon.lengthM, "arc-distance attribute exceeds total reach length");
const reversed = buildVariableRiverRibbonGeometry({
  points: [...points].reverse(), widthsM: [10, 8, 5, 4, 2], surfaceElevationsM: [1, 2, 3.25, 3.5, 4],
});
assert(reversed.geometry.getIndex()!.count > 0, "reversed river winding produced empty geometry");
assertUpwardTriangles(ribbon.geometry, "left-turn river");
assertUpwardTriangles(reversed.geometry, "right-turn river");
const distant = buildVariableRiverRibbonGeometry({
  points: [[10_000_000, 10_000_000], [10_000_000.1, 10_000_001], [10_000_000.5, 10_000_002]],
  widthsM: [0.2, 0.3, 0.4],
  surfaceElevationsM: [1000, 1000.1, 1000.2],
});
const distantPositions = distant.geometry.getAttribute("position") as THREE.BufferAttribute;
assert(Math.abs(distant.origin[0] - 10_000_000.25) < 1e-6 && Math.abs(distantPositions.getX(0)) < 2,
  "distant river did not retain a feature-local origin");
let capped = false;
try {
  const excessive = Array.from({ length: 8193 }, (_, index) => [index, 0] as const);
  buildVariableRiverRibbonGeometry({ points: excessive, widthsM: excessive.map(() => 1), surfaceElevationsM: excessive.map(() => 0) });
} catch (error) { capped = error instanceof RangeError; }
assert(capped, "river point cap was not enforced");

const material = createWaterMaterial({ color: 0x2b5d72, kind: "river", orientation: "xz" });
assert(material.transparent && material.depthWrite === false, "transparent water still writes depth");

const scene = new THREE.Scene();
const manager = new VisibleWaterManager(scene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
let factories = 0;
const first = manager.mount("authored:hash:body:lake", "basin", () => {
  factories++;
  return new THREE.Mesh(new THREE.PlaneGeometry(2, 2), createWaterMaterial({ color: 0x336677, kind: "basin" }));
});
const duplicate = manager.mount("authored:hash:body:lake", "basin", () => {
  factories++;
  return new THREE.Mesh();
});
assert(first.mounted && !duplicate.mounted && factories === 1 && scene.children.length === 1, "semantic mount was not idempotent");
let conflict: unknown;
try { manager.mount("authored:hash:body:lake", "basin", () => new THREE.Mesh(), {}, "different-render-input"); }
catch (error) { conflict = error; }
assert(conflict instanceof Error && /semantic identity/.test(conflict.message) && manager.size === 1,
  "conflicting semantic mount was silently deduplicated");
const originalGeometry = first.entry.mesh.geometry;
manager.setQuality(DEFAULT_RENDER_QUALITY_PROFILES.performance.water);
assert(manager.quality.oceanSegments === 32 && first.entry.mesh.geometry !== originalGeometry && factories === 2,
  "quality update did not rebuild existing water in place");

const map = {
  version: 1, id: "water-render-authority", unitsPerMeter: 1, origin: [0, 0], extent: { w: 20, h: 20 }, seaLevel: 0,
  land: [], relief: [], biomes: [], waterways: [], routes: [], anchors: [],
  waterBodies: [{
    id: "lake", kind: "lake", level: 4,
    footprint: { points: [[2, 2], [18, 2], [18, 18], [2, 18]] },
    depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 100, depthM: 5 }],
  }],
  provenance: { tool: "design-space", contentHash: "pending" },
} as WorldMap;
map.provenance.contentHash = worldMapContentHash(map);
const contacts = new WaterContactRuntime();
const prepared = contacts.prepareVerifiedMap(map, { bindingId: "render-authority" });
contacts.activate(prepared, () => 0);
const before = JSON.stringify(contacts.query(10, 10));
manager.dispose();
assert(JSON.stringify(contacts.query(10, 10)) === before, "visible-water disposal mutated contact authority");
assert(scene.children.length === 0 && manager.size === 0, "manager disposal retained scene objects");

const faultScene = new THREE.Scene();
const faulted = new VisibleWaterManager(faultScene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
let laterDisposed = 0;
faulted.mount("fault:first", "river", () => {
  const geometry = new THREE.PlaneGeometry();
  geometry.dispose = () => { throw new Error("injected water geometry failure"); };
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
});
faulted.mount("fault:second", "river", () => {
  const geometry = new THREE.PlaneGeometry();
  geometry.dispose = () => { laterDisposed++; };
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
});
let disposal: unknown;
try { faulted.dispose(); } catch (error) { disposal = error; }
assert(disposal instanceof AggregateError && laterDisposed === 1 && faultScene.children.length === 0,
  "disposal fault aborted later cleanup or escaped aggregation");

let detachFails = true;
const attached = new Set<unknown>();
const detachScene = {
  add(child: unknown): void { attached.add(child); },
  remove(child: unknown): void { if (detachFails) { detachFails = false; throw new Error("injected detach failure"); } attached.delete(child); },
};
const retryable = new VisibleWaterManager(detachScene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
retryable.mount("retry", "river", () => new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
let detachError: unknown;
try { retryable.dispose(); } catch (error) { detachError = error; }
assert(detachError instanceof AggregateError && retryable.size === 1 && !retryable.disposed && attached.size === 1,
  "detach failure forgot ownership or disposed a still-attached mesh");
retryable.dispose();
assert(retryable.size === 0 && retryable.disposed && attached.size === 0, "detach retry did not complete cleanup");

console.log("p_water_render_foundation OK: body holes/local precision, bounded variable river geometry, explicit flow attributes/depth policy, semantic dedup, quality updates, exhaustive disposal, and unchanged contact authority");
