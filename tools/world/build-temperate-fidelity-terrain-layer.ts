import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMapTerrainField } from "../../js/src/terrain/map-field.mjs";
import {
  canonicalTerrainEditLayer,
  createTerrainEditBaseTopology,
  createTerrainEditLayer,
} from "../../js/src/terrain/edit-layer.mjs";
import { terrainChunkRangeForBounds } from "../../js/src/terrain/grid.mjs";
import { DEFAULT_MAP_EROSION_RECIPE } from "../../js/src/world/pipeline/erosion.mjs";
import { WorldMapSchema, verifyWorldMap } from "../../js/src/world/worldmap.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assetRoot = path.join(root, "assets");
const scene = JSON.parse(fs.readFileSync(path.join(root, "art-direction/temperate-fidelity-scene.json"), "utf8"));
const map = WorldMapSchema.parse(JSON.parse(fs.readFileSync(path.join(assetRoot, scene.map.assetId), "utf8")));
if (!verifyWorldMap(map).ok) throw new Error("temperate fidelity WorldMap hash is invalid");

const field = createMapTerrainField({
  worldMap: map,
  seed: scene.compiler.seed,
  baseAmplitude: scene.compiler.baseAmplitude,
  erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
  gridId: scene.compiler.gridId,
});
const baseTopology = createTerrainEditBaseTopology({
  grid: field.grid,
  domain: terrainChunkRangeForBounds(field.grid, field.bounds),
});
const sampleStepM = field.grid.chunkSizeM / (field.grid.defaultSamples - 1);

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function riverDistance(x: number, z: number): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const waterway of map.waterways) {
    for (let index = 1; index < waterway.points.length; index++) {
      nearest = Math.min(nearest, segmentDistance(
        x, z,
        waterway.points[index - 1][0], waterway.points[index - 1][1],
        waterway.points[index][0], waterway.points[index][1],
      ));
    }
  }
  return nearest;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function compactRidge(x: number, z: number, cx: number, cz: number, rx: number, rz: number, amplitude: number): number {
  const nx = (x - cx) / rx, nz = (z - cz) / rz;
  const radius = Math.hypot(nx, nz);
  if (radius >= 1) return 0;
  const interior = 1 - radius;
  return amplitude * interior * interior * (3 - 2 * interior);
}

function authoredDeltaM(x: number, z: number): number {
  // Two asymmetrical valley walls and a broad headland terminate the river vista. The protected
  // corridor is deliberately wider than the rendered channel: authored relief must never lift
  // the compiler-carved river bed or turn the water back into a surface veneer.
  const relief =
    compactRidge(x, z, -94, 176, 85, 145, 17) +
    compactRidge(x, z, 112, 186, 95, 140, 21) +
    compactRidge(x, z, 8, 292, 220, 75, 13) +
    compactRidge(x, z, 76, 142, 42, 62, 6.5);
  const riverGuard = smoothstep(18, 42, riverDistance(x, z));
  const compositionWindow =
    smoothstep(-6, 34, z) *
    (1 - smoothstep(304, 354, z)) *
    (1 - smoothstep(178, 228, Math.abs(x)));
  const delta = relief * riverGuard * compositionWindow;
  return delta < 0.025 ? 0 : Math.round(delta * 1_000) / 1_000;
}

const bounds = baseTopology.domain;
const intervals = field.grid.defaultSamples - 1;
const deltas: Array<{ gx: number; gz: number; deltaM: number }> = [];
let nearestEditedRiverM = Number.POSITIVE_INFINITY;
let maximumDeltaM = 0;
for (let gz = bounds.minTz * intervals; gz <= (bounds.maxTz + 1) * intervals; gz++) {
  const z = field.grid.origin[1] + gz * sampleStepM;
  for (let gx = bounds.minTx * intervals; gx <= (bounds.maxTx + 1) * intervals; gx++) {
    const x = field.grid.origin[0] + gx * sampleStepM;
    const deltaM = authoredDeltaM(x, z);
    if (deltaM !== 0) {
      nearestEditedRiverM = Math.min(nearestEditedRiverM, riverDistance(x, z));
      maximumDeltaM = Math.max(maximumDeltaM, deltaM);
      deltas.push({ gx, gz, deltaM });
    }
  }
}
if (nearestEditedRiverM <= 18) throw new Error(`authored terrain entered the protected river corridor (${nearestEditedRiverM}m)`);

const operations = [];
if (deltas.length > 55_000) throw new Error(`authored terrain composition exceeds its 55,000-delta tuning budget (${deltas.length})`);
for (let start = 0, index = 0; start < deltas.length; start += 4_096, index++) {
  operations.push({
    operationId: `composition-${String(index).padStart(2, "0")}`,
    kind: "add",
    deltas: deltas.slice(start, start + 4_096),
  });
}
const layer = createTerrainEditLayer({
  layerId: "temperate-river-valley-composition",
  baseTopology,
  operations,
});
const bytes = `${canonicalTerrainEditLayer(layer)}\n`;
const target = path.join(assetRoot, "terrain/temperate-fidelity-composition.layer.json");
if (process.argv.includes("--write")) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
} else if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== bytes) {
  throw new Error("temperate fidelity terrain composition layer is absent or stale; rerun with --write");
}
console.log(JSON.stringify({
  assetId: path.relative(assetRoot, target),
  contentHash: layer.contentHash,
  baseTopologyHash: baseTopology.topologyHash,
  deltas: deltas.length,
  operations: operations.length,
  nearestEditedRiverM,
  maximumDeltaM,
}));
