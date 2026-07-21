import * as THREE from "../build/three.bundle.mjs";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { grassFieldVisualBounds } from "../src/render/grass-field-package.ts";
import { grassFieldRandom } from "../src/render/grass-field-plan.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_grass_midfield_variation_contract FAIL: ${message}`);
}

const geometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({
  quality: "cinematic", lod: 1, maxBlades: 960_000, presentationBand: "mid-cluster",
});
const descriptor = geometry.userData.liminaMidClusterGeometry as any;
assert(descriptor?.schema === "limina.grass-mid-physical-cluster/v1"
  && descriptor.blades === 16 && descriptor.longitudinalSegments === 1
  && descriptor.trianglesPerBlade === 2 && descriptor.foldedLightingSurface === true
  && descriptor.variationDomain === "world-root-xz" && descriptor.variantFamilies >= 32
  && descriptor.bladeYawJitterRad >= 0.2 && descriptor.bladeOffsetRadiusM > 0
  && descriptor.bladeLeanMaxM > 0,
"package omitted the world-seeded folded physical mid-cluster contract");
assert(geometry.userData.liminaGroundCoverStrategy === "world-varied-folded-physical-cluster/v2"
  && geometry.userData.liminaMidClusterSilhouette === undefined,
"rejected analytic crossed-card silhouette remains active in the mid field");

const position = geometry.getAttribute("position") as THREE.BufferAttribute;
const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
const variation = geometry.getAttribute("meadowVariation") as THREE.BufferAttribute;
assert(position.count === 16 * 4 && variation.count === position.count && geometry.index?.count === 16 * 6,
  "mid cluster does not contain sixteen independently modeled connected folded leaves");
for (let blade = 0; blade < descriptor.blades; blade++) {
  const start = blade * 4;
  const span = (a: number, b: number) => Math.hypot(
    position.getX(start + a) - position.getX(start + b),
    position.getY(start + a) - position.getY(start + b),
    position.getZ(start + a) - position.getZ(start + b),
  );
  const rootWidth = span(0, 1), crownWidth = span(2, 3);
  assert(crownWidth > 0.002 && crownWidth < rootWidth * 0.45,
    `physical blade ${blade} lost its narrow nonzero crown (${crownWidth}/${rootWidth})`);
  let mostDifferentNormalDot = 1;
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    mostDifferentNormalDot = Math.min(mostDifferentNormalDot,
      normal.getX(start + a) * normal.getX(start + b)
      + normal.getY(start + a) * normal.getY(start + b)
      + normal.getZ(start + a) * normal.getZ(start + b));
  }
  assert(mostDifferentNormalDot < 0.995,
    `physical blade ${blade} collapsed to one preferred flat normal`);
}
const adjacency: number[][] = Array.from({ length: position.count }, () => []);
for (let offset = 0; offset < geometry.index!.count; offset += 3) {
  const a = geometry.index!.getX(offset), b = geometry.index!.getX(offset + 1), c = geometry.index!.getX(offset + 2);
  adjacency[a].push(b, c); adjacency[b].push(a, c); adjacency[c].push(a, b);
}
const visited = new Uint8Array(position.count); let components = 0;
for (let start = 0; start < position.count; start++) if (visited[start] === 0) {
  components++; visited[start] = 1; const pending = [start];
  while (pending.length > 0) for (const neighbor of adjacency[pending.pop()!]) if (visited[neighbor] === 0) {
    visited[neighbor] = 1; pending.push(neighbor);
  }
}
assert(components === descriptor.blades, `mid cluster has ${components} connected surfaces for ${descriptor.blades} blades`);

const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic");
const band = profile.additionalContinuousBands![0]!;
assert(band.cellSizeDivisor === 3 && band.radius === 2 && band.bladesPerSquareMeter === 72
  && band.maxResidentBlades === 540_000 && band.fadeOut.start === 18 && band.fadeOut.end === 32,
"cinematic mid geometry is not budgeted in the camera-centered 16m physical-blade window");
assert(band.placement?.strategy === "world-matern-blue-noise/v1"
  && band.placement.oversample === 2 && band.placement.minimumDistanceMultiplier === 0.84,
"mid cluster retained the one-root-per-Cartesian-cell placement lattice");
const bounds = grassFieldVisualBounds(profile, band.lod, band.id), geometryBox = geometry.boundingBox!;
const baseRadius = Math.max(Math.abs(geometryBox.min.x), Math.abs(geometryBox.max.x),
  Math.abs(geometryBox.min.z), Math.abs(geometryBox.max.z));
assert(bounds === band.visualBounds
  && bounds.footprintRadius >= baseRadius * descriptor.bladeWidthScale[1]
    + descriptor.bladeOffsetRadiusM + descriptor.bladeLeanMaxM
  && bounds.maxHeight >= geometryBox.max.y * descriptor.bladeHeightScale[1] * 1.22
  && bounds.maxHorizontalDisplacement >= profile.lod[band.lod].maxHorizontalDisplacement,
"mid physical shader deformation exceeds CPU/native frustum-culling bounds");

// Root and per-blade transforms must not restore a preferred world azimuth.
const yawBins = new Uint32Array(16), orientationBins = new Uint32Array(24), seed = 0x4d454144;
let rootCount = 0;
for (let gridZ = -128; gridZ < 128; gridZ++) for (let gridX = -128; gridX < 128; gridX++) {
  const style = grassFieldRandom(seed, gridX, gridZ, 2);
  const rootYaw = (style & 0xffff) * Math.PI * 2 / 65536;
  yawBins[Math.min(yawBins.length - 1, Math.floor(rootYaw / (Math.PI * 2) * yawBins.length))]++;
  rootCount++;
  if ((gridX & 7) !== 0 || (gridZ & 7) !== 0) continue;
  for (let blade = 0; blade < descriptor.blades; blade++) {
    const authored = blade * 2.399963229728653;
    const cardSeed = (grassFieldRandom(seed, gridX, gridZ, 100 + blade) & 0xffff) / 65535;
    const jitter = (cardSeed - 0.5) * descriptor.bladeYawJitterRad * 2;
    const orientation = ((rootYaw + authored + jitter) % Math.PI + Math.PI) % Math.PI;
    orientationBins[Math.min(orientationBins.length - 1, Math.floor(orientation / Math.PI * orientationBins.length))]++;
  }
}
const deviation = (bins: Uint32Array): number => {
  const mean = bins.reduce((sum, value) => sum + value, 0) / bins.length;
  return Math.max(...Array.from(bins, (value) => Math.abs(value - mean) / mean));
};
const yawDeviation = deviation(yawBins), orientationDeviation = deviation(orientationBins);
assert(yawDeviation < 0.08, `world-root yaw is not uniform (${yawDeviation.toFixed(3)})`);
assert(orientationDeviation < 0.2, `physical blade variants retain a preferred azimuth (${orientationDeviation.toFixed(3)})`);

// Native WebGPU draws every fixed candidate slot, including rejected zero-scale roots. Pin the
// submitted rather than merely visible triangle cost so a future oversampling change cannot turn
// this visually richer band into a hidden whole-scene budget regression.
const cellSize = 48 / band.cellSizeDivisor;
const candidateSpacing = Math.sqrt(descriptor.blades / band.bladesPerSquareMeter
  / band.placement!.oversample);
const candidatesPerCell = Math.ceil(cellSize / candidateSpacing) ** 2;
const residentCells = (band.radius * 2 + 1) ** 2;
const submittedTriangles = candidatesPerCell * residentCells * descriptor.blades * descriptor.trianglesPerBlade;
assert(submittedTriangles <= 2_000_000,
  `mid physical band submits ${submittedTriangles.toLocaleString()} fixed-slot triangles before the rest of the scene`);

geometry.dispose();
console.log(`p_grass_midfield_variation_contract OK: 16 folded blades/root, ${rootCount} roots, ${submittedTriangles.toLocaleString()} maximum fixed-slot triangles, yaw deviation ${yawDeviation.toFixed(3)}, orientation deviation ${orientationDeviation.toFixed(3)}`);
