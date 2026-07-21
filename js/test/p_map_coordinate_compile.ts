import { ops } from "../src/engine.ts";
import { compileAtlasMapDoc, compileDesignMap } from "../src/world/design-map-compile.mjs";
import { canonicalMapDocText } from "../src/world/mapdoc-canonical.mjs";
import { encodeRasterCells, u8ToB64 } from "../src/world/pipeline/raster-codec.mjs";
import { verifyWorldMap, WorldMapSchema, type WorldMap } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_map_coordinate_compile FAIL: ${message}`);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}
function compileAtlas(doc: unknown): WorldMap {
  return WorldMapSchema.parse(compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(doc) }).worldMap) as WorldMap;
}

const frame = { kind: "m", unitsPerMeter: 2, origin: [100, -50] };
const waterBody = {
  id: "mere",
  kind: "lake",
  level: 7,
  footprint: {
    points: [[2, 2], [10, 2], [10, 10], [2, 10]],
    holes: [[[4, 4], [4, 6], [6, 6], [6, 4]]],
  },
  depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 4, depthM: 2 }],
};
const vectorDoc: any = {
  version: 2,
  activeMapId: "primary",
  maps: [{
    id: "primary", name: "Noncanonical vectors", scope: "site", parent: null,
    units: frame,
    seaLevel: 3,
    features: [
      { id: "outline", type: "area", kind: "outline", points: [[0, 0], [20, 0], [20, 20], [0, 20]] },
      { id: "mountains", type: "area", kind: "biome", biome: "mountain", points: [[0, 0], [8, 0], [4, 8]] },
      { id: "river", type: "line", kind: "river", class: "stream", points: [[0, 0], [10, 10]], widthM: 6, widths: [5, 7] },
      { id: "road", type: "line", kind: "road", points: [[2, 4], [18, 16]] },
      { id: "peak", type: "glyph", kind: "relief", glyph: "peak", x: 8, z: 4 },
    ],
    waterBodies: [waterBody],
    stamps: [{ id: "church", assetId: "church.glb", x: 12, z: 6, rot: 0.25, scale: 1.5 }],
  }],
};

const vector = compileAtlas(vectorDoc);
assert(vector.unitsPerMeter === 1 && vector.origin[0] === 0 && vector.origin[1] === 0,
  "compiler did not emit the canonical WorldMap frame");
assert(JSON.stringify(vector.land[0].points) === JSON.stringify([[100, -50], [110, -50], [110, -40], [100, -40]]),
  "outline points were not affine-normalized exactly once");
assert(JSON.stringify(vector.biomes[0].points) === JSON.stringify([[100, -50], [104, -50], [102, -46]]),
  "biome points were not normalized");
assert(JSON.stringify(vector.waterways[0].points) === JSON.stringify([[100, -50], [105, -45]]),
  "waterway points were not normalized");
assert(vector.waterways[0].widthM === 6 && vector.waterways[0].widths?.join(",") === "5,7",
  "meter-suffixed waterway widths were incorrectly scaled");
assert(JSON.stringify(vector.routes[0].points) === JSON.stringify([[101, -48], [109, -42]]),
  "route points were not normalized");
const peak = vector.relief.find((entry) => entry.kind === "peak");
assert(JSON.stringify(peak?.shape.point) === JSON.stringify([104, -48]) && peak?.amplitude === 15,
  "relief point was not normalized or physical amplitude changed");
assert(JSON.stringify(vector.waterBodies?.[0].footprint.points) === JSON.stringify([[101, -49], [105, -49], [105, -45], [101, -45]]),
  "WaterBody footprint was not normalized");
assert(JSON.stringify(vector.waterBodies?.[0].footprint.holes?.[0]) === JSON.stringify([[102, -48], [102, -47], [103, -47], [103, -48]]),
  "WaterBody footprint hole was not normalized");
assert(vector.waterBodies?.[0].level === 7 && vector.waterBodies[0].depthZones[0].maxShoreDistanceM === 4
    && vector.waterBodies[0].depthZones[0].depthM === 2,
  "WaterBody meter-suffixed physical quantities were incorrectly scaled");
assert(JSON.stringify(vector.anchors[0].position) === JSON.stringify([106, -47])
    && vector.anchors[0].rot === 0.25 && vector.anchors[0].scale === 1.5,
  "stamp position was not normalized or dimensionless fields changed");
assert(vector.extent.w === 10 && vector.extent.h === 10 && vector.seaLevel === 3,
  "extent was double-scaled or vertical sea level changed");
assert(verifyWorldMap(vector).ok, "normalized vector WorldMap failed its content hash");

// The same physical map authored directly in canonical coordinates must produce identical spatial
// IR. Provenance differs because the authoritative source bytes differ, so compare only map state.
const canonicalDoc = clone(vectorDoc);
canonicalDoc.maps[0].units = { kind: "m", unitsPerMeter: 1, origin: [0, 0] };
const toWorld = ([x, z]: number[]) => [100 + x / 2, -50 + z / 2];
for (const feature of canonicalDoc.maps[0].features) {
  if (Array.isArray(feature.points)) feature.points = feature.points.map(toWorld);
  if (typeof feature.x === "number") [feature.x, feature.z] = toWorld([feature.x, feature.z]);
}
canonicalDoc.maps[0].waterBodies[0].footprint.points = canonicalDoc.maps[0].waterBodies[0].footprint.points.map(toWorld);
canonicalDoc.maps[0].waterBodies[0].footprint.holes = canonicalDoc.maps[0].waterBodies[0].footprint.holes.map((hole: number[][]) => hole.map(toWorld));
for (const stamp of canonicalDoc.maps[0].stamps) [stamp.x, stamp.z] = toWorld([stamp.x, stamp.z]);
const canonical = compileAtlas(canonicalDoc);
for (const field of ["unitsPerMeter", "origin", "extent", "seaLevel", "land", "relief", "biomes", "waterways", "waterBodies", "routes", "anchors"] as const) {
  assert(JSON.stringify(vector[field]) === JSON.stringify(canonical[field]), `canonical/noncanonical ${field} output diverged`);
}

// Raster rects are normalized before elevation sampling and mask vectorization. Elevation values
// are vertical metres and therefore remain unchanged.
const maskCells = Uint8Array.from([
  0, 0, 0, 0, 0,
  0, 255, 255, 255, 0,
  0, 255, 255, 255, 0,
  0, 255, 255, 255, 0,
  0, 0, 0, 0, 0,
]);
const mask = encodeRasterCells(maskCells);
const biome = encodeRasterCells(maskCells.map((value) => value === 0 ? 0 : 1));
const rasterDoc = clone(vectorDoc);
rasterDoc.maps[0].features = [];
rasterDoc.maps[0].waterBodies = [];
rasterDoc.maps[0].stamps = [];
rasterDoc.maps[0].rasters = {
  elevation: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 20, h: 20 }, minY: -5, maxY: 15, data: u8ToB64(Uint8Array.from([255, 255, 255, 255])) },
  landmass: { w: 5, h: 5, rect: { x0: 0, z0: 0, w: 20, h: 20 }, ...mask },
  biomes: { w: 5, h: 5, rect: { x0: 0, z0: 0, w: 20, h: 20 }, ...biome },
};
const raster = compileAtlas(rasterDoc);
assert(JSON.stringify(raster.reliefGrid?.rect) === JSON.stringify({ x0: 100, z0: -50, w: 10, h: 10 }),
  "elevation rect was not normalized");
assert(raster.reliefGrid?.minY === -5 && raster.reliefGrid.maxY === 15,
  "vertical elevation range was incorrectly scaled");
for (const point of [...raster.land.flatMap((entry) => entry.points), ...raster.biomes.flatMap((entry) => entry.points)]) {
  assert(point[0] >= 100 && point[0] <= 110 && point[1] >= -50 && point[1] <= -40,
    `raster vectorization emitted an unnormalized point ${JSON.stringify(point)}`);
}
assert(raster.land.length > 0 && raster.biomes.length > 0 && verifyWorldMap(raster).ok,
  "normalized raster compile was empty or hash-invalid");

// Legacy aggregate marker/place coordinates share the selected MapDoc frame; their radii/counts
// are physical or dimensionless metadata and must not be scaled.
const aggregate = WorldMapSchema.parse(compileDesignMap({
  mapsJsonText: JSON.stringify({ activeMapId: "primary", maps: [vectorDoc.maps[0]] }),
  worldBibleText: "---\nzone:\n  size_m: 1000\nlocations:\n  - id: tower\n    name: Tower\n    kind: landmark\n    position: [20, -10]\n    count: 3\n---\n",
  placesText: "---\nkind: places\nplaces:\n  - id: village\n    name: Village\n    kind: settlement\n    position: [16, 12]\n    binding: area\n    radiusM: 30\n    assetId: village.glb\n---\n",
}).worldMap) as WorldMap;
const tower = aggregate.anchors.find((entry) => entry.id === "tower");
const village = aggregate.gazetteer?.find((entry) => entry.placeId === "village");
assert(JSON.stringify(tower?.position) === JSON.stringify([110, -55]) && tower?.count === 3,
  "world-bible marker was not normalized or count changed");
assert(JSON.stringify(village?.position) === JSON.stringify([108, -44]) && village?.radiusM === 30,
  "place was not normalized or radiusM changed");
assert(JSON.stringify(aggregate.anchors.find((entry) => entry.id === "village")?.position) === JSON.stringify([108, -44]),
  "place asset anchor diverged from its gazetteer position");

const overflow = clone(vectorDoc);
overflow.maps[0].units.origin = [10_000_000, 0];
rejects(() => compileAtlas(overflow), /world coordinate range/, "out-of-range normalized coordinate was accepted");
const collapsed = clone(vectorDoc);
collapsed.maps[0].units = { kind: "m", unitsPerMeter: 1e308, origin: [10_000_000, 0] };
rejects(() => compileAtlas(collapsed), /loses precision|positive extent/, "precision-collapsing frame was accepted");
const inactiveOverflow = clone(vectorDoc);
inactiveOverflow.maps.unshift({
  id: "inactive", name: "Inactive", scope: "site", parent: null,
  units: { kind: "m", unitsPerMeter: 1, origin: [10_000_000, 0] },
  features: [{ id: "outside", type: "line", kind: "road", points: [[0, 0], [1, 0]] }],
});
rejects(() => compileAtlas(inactiveOverflow), /world coordinate range/, "inactive-map coordinate overflow bypassed whole-document validation");

ops.op_log("p_map_coordinate_compile OK: vector, water, raster, marker, place, stamp, extent, canonical-equivalence, physical-metre, bounds, and precision normalization contracts hold.");
