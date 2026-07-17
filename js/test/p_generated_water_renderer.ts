import * as THREE from "../build/three.bundle.mjs";
import { DEFAULT_RENDER_QUALITY_PROFILES, type WaterRenderQuality } from "../src/render/quality.ts";
import {
  buildGeneratedReachDepthTexture,
  generatedWaterCoversPoint,
  mountGeneratedWaterResource,
  type VerifiedGeneratedWaterRenderResource,
} from "../src/render/water/generated-water-renderer.ts";
import { createWaterMaterial, WATER_OWNED_NODES_KEY, WATER_OWNED_TEXTURES_KEY } from "../src/render/water/material.ts";
import { VisibleWaterManager } from "../src/render/water/visible-water-manager.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_generated_water_renderer FAIL: ${message}`);
}

const ARTIFACT_HASH = `sha256:${"a".repeat(64)}`;
const FAR = 9_000_000;

function resource(): VerifiedGeneratedWaterRenderResource {
  return {
    artifactHash: ARTIFACT_HASH,
    field: {
      placement: { originX: FAR - 8, originZ: FAR - 8 },
      rows: 65,
      cols: 65,
      cellSizeM: 1,
      seaLevelM: 0,
      oceanMask: new Uint8Array(65 * 65),
    },
    sampleTerrainHeight: (x, z) => x >= FAR && x <= FAR + 20 && z >= FAR && z <= FAR + 20
      ? 11.75 - (x - FAR) * 0.35
      : x >= FAR && x <= FAR + 20 && z >= FAR + 36 && z <= FAR + 44
      ? 9 - (x - FAR) * 0.35
      : null,
    topology: {
      schema: "limina.hydrology-generated-water/v1",
      version: 1,
      basins: [{
        id: "gen-b-1-2",
        spillLevelM: 12,
        maxDepthM: 8,
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

const coverageResource = resource();
assert(generatedWaterCoversPoint(coverageResource, FAR + 2, FAR + 2),
  "semantic basin interior was not classified as water");
assert(!generatedWaterCoversPoint(coverageResource, FAR + 10, FAR + 10),
  "semantic basin hole was incorrectly classified as water");
assert(generatedWaterCoversPoint(coverageResource, FAR + 10, FAR + 41.9),
  "variable-width river interior was not classified as water");
assert(!generatedWaterCoversPoint(coverageResource, FAR + 10, FAR + 42.25),
  "dry river bank was incorrectly classified as water");
assert(generatedWaterCoversPoint(coverageResource, FAR + 10, FAR + 42.25, 0.3),
  "river vegetation-exclusion margin did not cover the immediate bank seam");
coverageResource.field.oceanMask[2 * coverageResource.field.cols + 3] = 1;
assert(generatedWaterCoversPoint(coverageResource, FAR - 5, FAR - 6),
  "verified ocean-mask cell was not classified as water");
let invalidCoverageRejected = false;
try { generatedWaterCoversPoint(coverageResource, Number.NaN, 0); } catch (error) {
  invalidCoverageRejected = error instanceof RangeError;
}
assert(invalidCoverageRejected, "non-finite water coverage query did not fail closed");

const stripedDepth = buildGeneratedReachDepthTexture({
  id: "gen-r-aa-bb", class: "river", order: 2,
  points: [[0, 0], [20, 0]], widths: [8, 8],
  terrainElevationsM: [6, 6], surfaceElevationsM: [10, 10], waterfalls: [],
}, {
  originX: -8, originZ: -8, rows: 65, cols: 65, cellSizeM: 1, seaLevelM: 0,
  oceanMask: new Uint8Array(65 * 65),
}, (x) => Math.floor(x * 3) % 2 === 0 ? 9.9 : 6, 64);
const stripedPixels = stripedDepth.texture.image.data as Uint8Array;
let largestPresentationStep = 0;
for (let row = 1; row < 63; row++) for (let col = 1; col < 63; col++) {
  const offset = (row * 64 + col) * 2, next = offset + 2;
  if (stripedPixels[offset + 1] !== 0 && stripedPixels[next + 1] !== 0) {
    largestPresentationStep = Math.max(largestPresentationStep, Math.abs(stripedPixels[offset] - stripedPixels[next]));
  }
}
assert(largestPresentationStep < 100,
  `compiler-grid bed noise leaked into the river presentation depth (${largestPresentationStep}/255 adjacent step)`);
// The bake reports its normalisation divisor in metres so Beer–Lambert absorption operates on
// real water-column depth. Deepest column here is 10−6=4 m; smoothing may only pull it down.
assert(Number.isFinite(stripedDepth.maxDepthM) && stripedDepth.maxDepthM > 0.25 && stripedDepth.maxDepthM <= 4 + 1e-9,
  `reach depth bake reported a bogus metre scale (${stripedDepth.maxDepthM})`);
stripedDepth.texture.dispose();

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

function graphSome(root: unknown, predicate: (node: Record<string, unknown>) => boolean): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (predicate(value as Record<string, unknown>)) return true;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(child)) { if (child.some(visit)) return true; }
      else if (visit(child)) return true;
    }
    return false;
  };
  return visit(root);
}

function nodeKinds(root: unknown): Set<string> {
  const kinds = new Set<string>(), seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value); kinds.add((value as { constructor?: { name?: string } }).constructor?.name ?? "Object");
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(root); return kinds;
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
const basinMaterial = basin.mesh.material as THREE.Material;
assert(basinMaterial.userData.liminaWaterShoreFoam === true && basinMaterial.userData.liminaWaterCaustics === true,
  "basin depth material omitted shoreline foam or shallow caustics");
assert(basinMaterial.userData.liminaWaterSceneDepthRefraction === true
  && nodeKinds((basinMaterial as THREE.MeshStandardNodeMaterial).backdropNode).has("ViewportSharedTextureNode")
  && basinMaterial.userData.liminaWaterPlanarReflection !== true,
"balanced basin did not use real viewport refraction or incorrectly allocated a reflector");
const basinTextures = (basinMaterial.userData as Record<string, unknown>)[WATER_OWNED_TEXTURES_KEY] as THREE.DataTexture[];
assert(Array.isArray(basinTextures) && basinTextures.length === 1, "basin did not own exactly one depth/coverage texture");
const basinDepth = basinTextures[0];
const basinPixels = basinDepth.image.data as Uint8Array;
let covered = 0, shallow = 255, deep = 0, holeCoverage = 0;
for (let row = 0; row < basinDepth.image.height; row++) for (let col = 0; col < basinDepth.image.width; col++) {
  const offset = (row * basinDepth.image.width + col) * 2;
  if (basinPixels[offset + 1] !== 0) {
    covered++; shallow = Math.min(shallow, basinPixels[offset]); deep = Math.max(deep, basinPixels[offset]);
  }
  const x = FAR + (col + 0.5) / basinDepth.image.width * 20;
  const z = FAR + (row + 0.5) / basinDepth.image.height * 20;
  if (x > FAR + 6 && x < FAR + 14 && z > FAR + 6 && z < FAR + 14) holeCoverage += basinPixels[offset + 1];
}
assert(covered > 0 && shallow < deep, "basin depth raster did not encode varying true water-column depth");
assert(holeCoverage === 0, "basin depth coverage filled a semantic hole");

const reach = manager.entries().find((entry) => entry.metadata.feature === "reach")!;
assert(reach.metadata.order === 4 && reach.metadata.class === "river" && reach.metadata.gameplayAuthority === false,
  "reach metadata lost hydrology order/class or claimed gameplay authority");
assertUpward(reach.mesh.geometry, "reach");
const reachPositions = reach.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
const reachWorldYs = new Set(Array.from({ length: reachPositions.count }, (_, index) =>
  Math.round((reachPositions.getY(index) + reach.mesh.position.y) * 1e6) / 1e6));
assert(Math.min(...reachWorldYs) === 3 && Math.max(...reachWorldYs) === 10 && reachWorldYs.size > 3,
  "reach presentation curve lost endpoint elevation authority or smooth ordered interpolation");
const reachTessellation = reach.mesh.geometry.userData.liminaRiverTessellation;
const firstAcross = reachTessellation?.segments?.[0]?.across;
assert(Number.isSafeInteger(firstAcross)
  && Math.abs(reachPositions.getZ(0) - reachPositions.getZ(firstAcross)) === 2
  && reachTessellation?.policy === "bounded-world-space/v1"
  && reachTessellation.minAlong >= 1 && reachTessellation.maxAlong <= 24
  && reachTessellation.minAcross >= 6 && reachTessellation.maxAcross <= 20
  && reachTessellation.quadCount > 0,
"reach start width or bounded world-space tessellation is not the exact generated contract");
assert(Math.abs(reach.mesh.position.x - (FAR + 10)) < 1e-8, "reach geometry lost feature-local origin");
const reachTextures = ((reach.mesh.material as THREE.Material).userData as Record<string, unknown>)[WATER_OWNED_TEXTURES_KEY] as THREE.DataTexture[];
assert((reach.mesh.material as THREE.Material).userData.liminaWaterDownstreamFlow === true
  && (reach.mesh.material as THREE.Material).userData.liminaWaterTwoDimensionalFlow === true
  && (reach.mesh.material as THREE.Material).userData.liminaWaterShoreFoam === true,
"depth-driven reach lost two-dimensional downstream flow or bank foam");
assert((reach.mesh.material as THREE.Material).userData.liminaWaterVolumetricAbsorption === true
  && (reach.mesh.material as THREE.Material).userData.liminaWaterWetShoreMargin === true
  && (reach.mesh.material as THREE.Material).userData.liminaWaterFlowAlignedNormals === true
  && ((reach.mesh.material as THREE.Material).userData.liminaWaterNormalOctaves as number) >= 1,
"depth-driven reach lost volumetric absorption, the wet contact margin, or flow-aligned normals");
{
  // The flags must not be self-declarations: the backdrop graph must actually carry the
  // Beer–Lambert exponential, and the colour graph must actually read the owned depth bake.
  const reachNodeMaterial = reach.mesh.material as THREE.MeshStandardNodeMaterial;
  assert(graphSome(reachNodeMaterial.backdropNode, (node) => node.method === "exp"),
    "river backdrop graph lost the Beer–Lambert absorption exponential");
  assert(graphSome(reachNodeMaterial.colorNode, (node) => node.constructor?.name === "TextureNode" && node.value === reachTextures[0]),
    "river colour graph no longer reads the verified depth bake");
}
const reachCross = reach.mesh.geometry.getAttribute("waterCrossDistance") as THREE.BufferAttribute;
assert(reachCross !== undefined && reachCross.count === reachPositions.count,
  "reach geometry lost the signed cross-stream attribute the flow-space ripple field requires");
assert(Array.isArray(reachTextures) && reachTextures.length === 1, "reach did not own exactly one terrain-derived depth/coverage texture");
const reachDepth = reachTextures[0], reachPixels = reachDepth.image.data as Uint8Array;
let reachCovered = 0, reachShallow = 255, reachDeep = 0;
for (let offset = 0; offset < reachPixels.length; offset += 2) if (reachPixels[offset + 1] !== 0) {
  reachCovered++; reachShallow = Math.min(reachShallow, reachPixels[offset]); reachDeep = Math.max(reachDeep, reachPixels[offset]);
}
assert(reachCovered > 0 && reachShallow < reachDeep, "reach depth raster is empty or collapsed to a uniform ribbon");

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
assert((waterfall.mesh.material as THREE.Material).userData.liminaWaterfallMaterial === "curtain/v1"
  && waterfall.mesh.children.length === 1
  && (waterfall.mesh.children[0] as THREE.Mesh).name === "limina:generated-water-waterfall-foam"
  && ((waterfall.mesh.children[0] as THREE.Mesh).material as THREE.Material).userData.liminaWaterfallMaterial === "foam/v1"
  && waterfall.mesh.userData.waterfallExtras === "foam",
"balanced waterfall did not mount its dedicated curtain and owned base foam");

const stableSignature = geometrySignature(manager);
(source.topology.reaches[0].points as [number, number][])[0][0] = -123;
(source.topology.reaches[0].surfaceElevationsM as number[])[0] = 999;
source.field.oceanMask.fill(1);
let retiredDepthDisposals = 0;
basinDepth.dispose = () => { retiredDepthDisposals++; };
reachDepth.dispose = () => { retiredDepthDisposals++; };
manager.setQuality(DEFAULT_RENDER_QUALITY_PROFILES.performance.water);
assert(geometrySignature(manager) === stableSignature, "quality rebuild read mutable adapter input instead of its verified snapshot");
assert(retiredDepthDisposals === 2, "quality rebuild did not retire the prior owned basin and reach depth textures exactly once");
const rebuiltBasin = manager.entries().find((entry) => entry.metadata.feature === "basin")!;
const rebuiltDepth = ((rebuiltBasin.mesh.material as THREE.Material).userData as Record<string, unknown>)[WATER_OWNED_TEXTURES_KEY] as THREE.DataTexture[];
assert(rebuiltDepth[0].image.width === DEFAULT_RENDER_QUALITY_PROFILES.performance.water.depthRasterSize,
  "quality rebuild did not honor the new bounded basin depth resolution");
const rebuiltReach = manager.entries().find((entry) => entry.metadata.feature === "reach")!;
const rebuiltReachDepth = ((rebuiltReach.mesh.material as THREE.Material).userData as Record<string, unknown>)[WATER_OWNED_TEXTURES_KEY] as THREE.DataTexture[];
assert(rebuiltReachDepth[0].image.width === DEFAULT_RENDER_QUALITY_PROFILES.performance.water.depthRasterSize,
  "quality rebuild did not honor the new bounded reach depth resolution");
const rebuiltWaterfall = manager.entries().find((entry) => entry.metadata.feature === "waterfall")!;
assert(rebuiltWaterfall.mesh.children.length === 0 && rebuiltWaterfall.mesh.userData.waterfallExtras === "none",
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
  maxDepthM: 1,
  footprint: { points: [[index * 3, 0], [index * 3 + 2, 0], [index * 3 + 2, 2], [index * 3, 2]] as const, holes: [] },
}));
const cappedResource: VerifiedGeneratedWaterRenderResource = {
  artifactHash: `sha256:${"b".repeat(64)}`,
  field: { placement: { originX: 0, originZ: 0 }, rows: 65, cols: 65, cellSizeM: 1, seaLevelM: 0, oceanMask: new Uint8Array(65 * 65) },
  sampleTerrainHeight: () => 0,
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
for (const candidate of [deterministicA, deterministicB]) {
  const cinematicBasin = candidate.entries().find((entry) => entry.metadata.feature === "basin")!;
  const cinematicMaterial = cinematicBasin.mesh.material as THREE.Material;
  const ownedNodes = cinematicMaterial.userData[WATER_OWNED_NODES_KEY] as Array<{ dispose(): void }>;
  assert(cinematicMaterial.userData.liminaWaterSceneDepthRefraction === true,
    "cinematic basin omitted depth-safe refraction");
  assert(cinematicMaterial.userData.liminaWaterPlanarReflection === true,
    "cinematic basin omitted planar reflection");
  assert(Array.isArray(ownedNodes) && ownedNodes.length === 1,
    "cinematic basin did not own exactly one reflector node");
  assert(cinematicBasin.mesh.children.length === 1,
    "cinematic basin did not attach exactly one reflector target");
  assert([...nodeKinds((cinematicMaterial as THREE.MeshStandardNodeMaterial).backdropNode)]
    .some((kind) => kind.endsWith("ReflectorNode")),
  "cinematic basin backdrop graph does not contain its reflector node");
  const cinematicReach = candidate.entries().find((entry) => entry.metadata.feature === "reach")!;
  assert((cinematicReach.mesh.material as THREE.Material).userData.liminaWaterSceneDepthRefraction === true
    && (cinematicReach.mesh.material as THREE.Material).userData.liminaWaterPlanarReflection !== true,
  "cinematic reach should refract without allocating a non-planar reflector");
  const cinematicFall = candidate.entries().find((entry) => entry.metadata.feature === "waterfall")!;
  assert(cinematicFall.mesh.children.length === 2
    && cinematicFall.mesh.children.some((child) => child.name.endsWith("-foam"))
    && cinematicFall.mesh.children.some((child) => child.name.endsWith("-mist"))
    && cinematicFall.mesh.userData.waterfallExtras === "foam-mist",
  "cinematic waterfall omitted its foam-mist quality extras");
}
const disposableBasin = deterministicA.entries().find((entry) => entry.metadata.feature === "basin")!;
const disposableNode = ((disposableBasin.mesh.material as THREE.Material).userData[WATER_OWNED_NODES_KEY] as Array<{ dispose(): void }>)[0];
let reflectorDisposals = 0;
disposableNode.dispose = () => { reflectorDisposals++; };
deterministicA.dispose();
assert(reflectorDisposals === 1, "cinematic disposal did not retire its reflector node exactly once");
deterministicB.dispose();

const opticsScene = new THREE.Scene();
const opticsManager = new VisibleWaterManager(opticsScene, DEFAULT_RENDER_QUALITY_PROFILES.cinematic.water);
mountGeneratedWaterResource(resource(), opticsManager);
const opticsBasin = opticsManager.entries().find((entry) => entry.metadata.feature === "basin")!;
const opticsNode = ((opticsBasin.mesh.material as THREE.Material).userData[WATER_OWNED_NODES_KEY] as Array<{ dispose(): void }>)[0];
let qualityReflectorDisposals = 0;
opticsNode.dispose = () => { qualityReflectorDisposals++; };
opticsManager.setQuality(DEFAULT_RENDER_QUALITY_PROFILES.performance.water);
const downgradedBasin = opticsManager.entries().find((entry) => entry.metadata.feature === "basin")!;
assert(qualityReflectorDisposals === 1 && downgradedBasin.mesh.children.length === 0
  && (downgradedBasin.mesh.material as THREE.Material).userData.liminaWaterSceneDepthRefraction !== true
  && (downgradedBasin.mesh.material as THREE.Material).userData.liminaWaterPlanarReflection !== true,
"quality downgrade leaked the reflector target/node or retained disabled scene optics");
opticsManager.dispose();

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

console.log("p_generated_water_renderer OK: verified field+terrain depth/coverage, holes/local precision, exact ordered reaches, vertical waterfalls, semantic transactions, caps, quality snapshots, deterministic rebuilds, disposal, and no gameplay authority");
