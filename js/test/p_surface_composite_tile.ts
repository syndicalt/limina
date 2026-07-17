import { buildBiomeSurfacePlan } from "../src/world/biome-surface-plan.mjs";
import { buildSurfaceCompositeTile, grassPresentationCoverage, SURFACE_COMPOSITE_POLICY_VERSION } from "../src/world/surface-composite-tile.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_surface_composite_tile FAIL: ${message}`); }
const A = `sha256:${"a".repeat(64)}`, B = `sha256:${"b".repeat(64)}`, C = `sha256:${"c".repeat(64)}`;
assert(grassPresentationCoverage(0) === 0 && grassPresentationCoverage(1) === 1
  && grassPresentationCoverage(0.35) === 0.35 && grassPresentationCoverage(0.65) === 0.65,
  "grass presentation coverage no longer preserves ecological authority");
let priorCoverage = 0;
for (let density = 0; density <= 1; density += 0.01) {
  const coverage = grassPresentationCoverage(Math.min(1, density));
  assert(coverage >= priorCoverage && coverage >= 0 && coverage <= 1, "grass presentation occupancy curve is not bounded and monotone");
  priorCoverage = coverage;
}
const bindings = Array.from({ length: 16 }, (_, index) => ({ assetId: `materials/role-${index}`, contentHash: `sha256:${index.toString(16).padStart(2, "0").repeat(32)}`,
  licenseId: "CC0-1.0", sourceUri: "https://example.invalid" }));
const publication = { disposed: false, fieldContentHash: A, runtimePackContentHash: B, sample() {
  const base = Math.floor(65_535 / 16), remainder = 65_535 - base * 16;
  return { status: "fulfilled", surfaces: bindings.map((binding, index) => ({ role: `ground/role-${index}`,
    rule: { role: `ground/role-${index}`, weight: 1, tileScaleM: 4 + index }, binding,
    weightU16: base + (index < remainder ? 1 : 0) })) };
} };
const plan = buildBiomeSurfacePlan({ publication, grid: { origin: [-64, -16], rows: 6, cols: 9, cellSizeM: 16 } });
const solid = (r: number, g: number, b: number) => new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]);
const pattern = (r: number, g: number, b: number) => new Uint8Array([
  r, g, b, 255, Math.min(255, r + 9), g, b, 255,
  r, Math.min(255, g + 11), b, 255, r, g, Math.min(255, b + 13), 255,
]);
const layers = plan.roles.map((role: any, index: number) => ({ index, assetId: role.assetId, contentHash: role.contentHash, width: 2, height: 2,
  albedo: pattern(30 + index * 8, 60 + index * 4, 40 + index * 6),
  normal: index === 0 ? solid(170, 110, 245) : solid(128, 128, 255),
  orm: index === 0 ? solid(190, 235, 0) : solid(220, 180, 0) }));
const tile = (tx: number, originX: number, featureX = 0) => buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx, tz: 0, lod: 0, origin: [originX, 0], sizeM: 48 }, featureOrigin: [featureX, 0], interior: 4, gutter: 1 });
const left = tile(-1, -48), leftAgain = tile(-1, -48), right = tile(0, 0);
assert(left.maps.albedo.contentHash === leftAgain.maps.albedo.contentHash && left.edgeHashes.east === right.edgeHashes.west,
  "same-input determinism or shared negative/positive tile edge identity failed");
assert(left.diagnostics.roles === 16 && left.diagnostics.runtimeTextureSamples === 3 && left.maps.albedo.data.length === 144,
  "16-role adversarial input did not collapse to exactly three bounded runtime maps");
const grassTile = (tx: number, originX: number, featureX = 0) => buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx, tz: 0, lod: 0, origin: [originX, 0], sizeM: 48 }, featureOrigin: [featureX, 0], interior: 4, gutter: 1,
  edgePolicy: "clamp", sampleGrassDensity: (x: number, z: number) => Math.max(0, Math.min(1, (x + z + 96) / 192)),
  grassOverlayRole: "ground/role-0" });
const grassLeft = grassTile(-1, -48), grassRight = grassTile(0, 0);
assert(grassLeft.edgeHashes.east === grassRight.edgeHashes.west,
  "density-baked turf broke shared surface edge identity");
assert(left.maps.normal.data.every((value: number, index: number) => index % 4 === 3 ? value === 255 : value >= 127),
  "normal blend did not remain normalized OpenGL-style data");
const shiftedPlan = buildBiomeSurfacePlan({ publication, grid: { origin: [999_936, 999_984], rows: 6, cols: 9, cellSizeM: 16 } });
const shiftedLayers = shiftedPlan.roles.map((role: any, index: number) => ({ ...layers[index], assetId: role.assetId, contentHash: role.contentHash }));
const shifted = buildSurfaceCompositeTile({ plan: shiftedPlan, layers: shiftedLayers, terrainChunkHash: C,
  tile: { tx: -1, tz: 0, lod: 0, origin: [999_952, 1_000_000], sizeM: 48 }, featureOrigin: [1_000_000, 1_000_000], interior: 4, gutter: 1 });
assert(left.maps.albedo.contentHash === shifted.maps.albedo.contentHash && left.maps.orm.contentHash === shifted.maps.orm.contentHash,
  "million-metre feature translation changed logical composite pixels");
let mismatch = false;
try { buildSurfaceCompositeTile({ plan, layers: layers.map((entry: any, index: number) => index === 0 ? { ...entry, contentHash: C } : entry),
  terrainChunkHash: C, tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 1 }); }
catch (error) { mismatch = /identity mismatch/.test(String(error)); }
assert(mismatch, "role source identity mismatch did not fail before compositing");
let outsideRejected = false;
try { buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 9, tz: 9, lod: 0, origin: [999, 999], sizeM: 48 }, interior: 4, gutter: 1 }); }
catch (error) { outsideRejected = /outside its surface plan/.test(String(error)); }
assert(outsideRejected, "default surface edge policy stopped rejecting unbounded samples");
const clamped = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C, edgePolicy: "clamp",
  tile: { tx: 9, tz: 9, lod: 0, origin: [999, 999], sizeM: 48 }, interior: 4, gutter: 1 });
assert(clamped.source.policyVersion === SURFACE_COMPOSITE_POLICY_VERSION && clamped.maps.albedo.data.length === 144,
  "explicit complete-world edge clamping did not produce a bounded composite");
const shoreline = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: (x: number) => ({ slope01: 0, elevationM: 0, waterDistanceM: Math.max(0, x / 16) }) });
const shorelineAlpha = Array.from({ length: 16 }, (_, index) => shoreline.maps.albedo.data[index * 4 + 3]);
assert(Math.max(...shorelineAlpha) === 255 && Math.min(...shorelineAlpha) === 0
  && shorelineAlpha.some((value) => value > 0 && value < 255),
  "surface composite did not encode a feathered generated-water shoreline mask in albedo alpha");
const grassDensity = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleGrassDensity: (x: number) => x / 48, grassOverlayRole: "ground/role-0" });
const grassAlpha = Array.from({ length: 16 }, (_, index) => grassDensity.maps.orm.data[index * 4 + 3]);
assert(grassDensity.maps.orm.channels === "ao-roughness-metalness-grass-density"
  && Math.min(...grassAlpha) === 0 && Math.max(...grassAlpha) === 255
  && grassAlpha.includes(85) && grassAlpha.includes(170),
  "surface composite did not preserve exact quantized grass density in ORM alpha");
const grassZero = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleGrassDensity: () => 0, grassOverlayRole: "ground/role-0" });
const grassBase = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0 });
assert(grassZero.maps.albedo.contentHash === grassBase.maps.albedo.contentHash
  && grassZero.maps.normal.contentHash === grassBase.maps.normal.contentHash
  && grassZero.maps.orm.contentHash === grassBase.maps.orm.contentHash,
  "zero grass density changed the base PBR composite");
const grassFull = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/role-0" });
assert(grassFull.maps.albedo.contentHash !== grassBase.maps.albedo.contentHash
  && grassFull.maps.normal.contentHash !== grassBase.maps.normal.contentHash
  && grassFull.maps.orm.contentHash !== grassBase.maps.orm.contentHash,
  "full grass density did not affect turf color, normal, and roughness together");
for (let offset = 0; offset < grassFull.maps.normal.data.length; offset += 4) {
  const x = grassFull.maps.normal.data[offset] / 127.5 - 1;
  const y = grassFull.maps.normal.data[offset + 1] / 127.5 - 1;
  assert(Math.hypot(x, y) <= 0.292 && grassFull.maps.normal.data[offset + 3] === 255,
    "density-one turf normal exceeded the bounded micro-tilt contract");
  assert(grassFull.maps.orm.data[offset + 1] >= Math.round(0.88 * 255)
    && grassFull.maps.orm.data[offset + 1] <= Math.round(0.96 * 255)
    && grassFull.maps.orm.data[offset + 3] === 255,
    "density-one turf roughness or ecological density escaped its exact channel contract");
}
const wetBase = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: () => ({ slope01: 0, elevationM: 0, waterDistanceM: 0 }) });
const wetGrass = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: () => ({ slope01: 0, elevationM: 0, waterDistanceM: 0 }),
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/role-0" });
for (let offset = 0; offset < wetGrass.maps.albedo.data.length; offset += 4) {
  for (let channel = 0; channel < 3; channel++) {
    assert(wetGrass.maps.albedo.data[offset + channel] === wetBase.maps.albedo.data[offset + channel]
      && wetGrass.maps.normal.data[offset + channel] === wetBase.maps.normal.data[offset + channel]
      && wetGrass.maps.orm.data[offset + channel] === wetBase.maps.orm.data[offset + channel],
    "shoreline-owned water did not suppress turf presentation back to exact base PBR");
  }
  assert(wetGrass.maps.albedo.data[offset + 3] === 255 && wetGrass.maps.orm.data[offset + 3] === 255,
    "shoreline or ecological authority alpha changed while suppressing underwater turf");
}
const wetEdgeGrass = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: () => ({ slope01: 0, elevationM: 0, waterDistanceM: 0.2 }),
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/role-0" });
assert(wetEdgeGrass.maps.albedo.contentHash === wetGrass.maps.albedo.contentHash
  && wetEdgeGrass.maps.normal.contentHash === wetGrass.maps.normal.contentHash
  && wetEdgeGrass.maps.orm.contentHash === wetGrass.maps.orm.contentHash,
  "full-wet shoreline guard changed at its 0.2m boundary");
const dryGrass = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: () => ({ slope01: 0, elevationM: 0, waterDistanceM: 3 }),
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/role-0" });
assert(dryGrass.maps.albedo.contentHash === grassFull.maps.albedo.contentHash
  && dryGrass.maps.normal.contentHash === grassFull.maps.normal.contentHash
  && dryGrass.maps.orm.contentHash === grassFull.maps.orm.contentHash,
  "dry turf path changed at the 3m shoreline guard boundary");
const halfWetGrass = buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleEnvironment: () => ({ slope01: 0, elevationM: 0, waterDistanceM: 1.6 }),
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/role-0" });
assert((halfWetGrass.maps.albedo.data[3] === 127 || halfWetGrass.maps.albedo.data[3] === 128) && halfWetGrass.maps.orm.data[3] === 255
  && halfWetGrass.maps.albedo.contentHash !== wetGrass.maps.albedo.contentHash
  && halfWetGrass.maps.albedo.contentHash !== dryGrass.maps.albedo.contentHash,
  "mid-shore turf presentation did not feather independently from ecological density");
let missingGrassRole = false;
try { buildSurfaceCompositeTile({ plan, layers, terrainChunkHash: C,
  tile: { tx: 0, tz: 0, lod: 0, origin: [0, 0], sizeM: 48 }, interior: 4, gutter: 0,
  sampleGrassDensity: () => 1, grassOverlayRole: "ground/not-bound" }); }
catch (error) { missingGrassRole = /must resolve exactly once/.test(String(error)); }
assert(missingGrassRole, "missing authenticated turf overlay role did not fail closed");
console.log("p_surface_composite_tile OK: deterministic 16-role CPU blend becomes three runtime PBR maps with exact shared edges and large-world equivalence");
