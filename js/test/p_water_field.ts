import {
  MAX_WATER_FIELD_BVH_NODES,
  MAX_WATER_FIELD_COLS,
  MAX_WATER_FIELD_ROWS,
  WATER_SAMPLE_CLASS_BASIN,
  WATER_SAMPLE_CLASS_DRY,
  WATER_SAMPLE_CLASS_OCEAN,
  WATER_SAMPLE_RECORD_BYTES,
  WATER_SAMPLE_SUBMERGED_UNKNOWN,
  WaterFieldCancelledError,
  WaterFieldValidationError,
  createWaterField,
} from "../src/world/water-field.mjs";
import { inspectWaterBodyTopology, WATER_LIMITS } from "../src/world/water-ir.mjs";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_water_field FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function regularRing(cx: number, cz: number, radius: number, points: number): number[][] {
  return Array.from({ length: points }, (_, index) => {
    const angle = index * Math.PI * 2 / points;
    return [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
  });
}

function bruteShoreDistance(body: Body, x: number, z: number): number {
  let minimumSquared = Number.POSITIVE_INFINITY;
  for (const ring of [body.footprint.points, ...(body.footprint.holes ?? [])]) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[previous], b = ring[index];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const lengthSquared = dx * dx + dz * dz;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      const ox = x - (a[0] + t * dx), oz = z - (a[1] + t * dz);
      minimumSquared = Math.min(minimumSquared, ox * ox + oz * oz);
    }
  }
  return Math.sqrt(minimumSquared);
}

function brutePointInRing(ring: number[][], x: number, z: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[previous], b = ring[index];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function bruteContains(body: Body, x: number, z: number): boolean {
  return brutePointInRing(body.footprint.points, x, z)
    && !(body.footprint.holes ?? []).some((hole) => brutePointInRing(hole, x, z));
}

type Body = {
  id: string;
  kind: "lake" | "pond" | "reservoir";
  level: number;
  footprint: { points: number[][]; holes?: number[][][] };
  depthZones: Array<{ minShoreDistanceM: number; maxShoreDistanceM: number; depthM: number }>;
};

function rectangle(id: string, level: number, x0: number, z0: number, x1: number, z1: number, options: Partial<Body> = {}): Body {
  return {
    id,
    kind: options.kind ?? "lake",
    level,
    footprint: options.footprint ?? { points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] },
    depthZones: options.depthZones ?? [{ minShoreDistanceM: 0, maxShoreDistanceM: 100, depthM: 4 }],
  };
}

function sealedMap(waterBodies: Body[], seaLevel = 0, overrides: Record<string, unknown> = {}): any {
  const map: any = {
    version: 1,
    id: "water-field-test",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 4000, h: 4000 },
    seaLevel,
    land: [],
    relief: [],
    biomes: [],
    waterways: [],
    waterBodies,
    routes: [],
    anchors: [],
    provenance: { tool: "design-space", contentHash: "0".repeat(64) },
    ...overrides,
  };
  map.provenance.contentHash = worldMapContentHash(map);
  return map;
}

const bands = [
  { minShoreDistanceM: 0, maxShoreDistanceM: 2, depthM: 1 },
  { minShoreDistanceM: 2, maxShoreDistanceM: 5, depthM: 3 },
  { minShoreDistanceM: 5, maxShoreDistanceM: 10, depthM: 6 },
];
const islandPond = rectangle("island-pond", 10, -20, -20, 20, 20, {
  kind: "pond",
  footprint: {
    points: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
    holes: [[[-4, -4], [-4, 4], [4, 4], [4, -4]]],
  },
  depthZones: bands,
});
const field = createWaterField(sealedMap([islandPond], 0));
const bandField = createWaterField(sealedMap([rectangle("band-lake", 10, -20, -20, 20, 20, { depthZones: bands })], 0));

// Above-sea basin membership is independent of the global ocean and is immutable.
const lake = field.query(12, 0, 8);
assert(lake.type === "basin" && lake.id === "island-pond" && lake.kind === "pond", "above-sea pond was not selected");
assert(lake.surfaceLevelM === 10 && lake.actualSubmergedDepthM === 2, "basin surface/actual depth changed");
assert(Object.isFrozen(lake) && Object.isFrozen(field) && Object.isFrozen(field.buildStats), "field/query envelopes are not immutable");

// The outer boundary is wet. Hole interiors and exact hole boundaries are dry for the basin.
const outerEdge = field.query(20, 0, 9);
assert(outerEdge.type === "basin" && outerEdge.shoreDistanceM === 0 && outerEdge.authoredTargetDepthM === 1, "outer boundary is not basin-wet at depth band zero");
for (const [x, z, label] of [[0, 0, "hole interior"], [4, 0, "hole boundary"]] as const) {
  const result = field.query(x, z, 12);
  assert(result.type === "dry" && result.isSubmerged === false, `${label} was not dry`);
}

// Bands are half-open, exact shared edges select the deeper band, and the final band clamps.
for (const [x, expectedDistance, expectedDepth, label] of [
  [19, 1, 1, "first band"],
  [18, 2, 3, "second band boundary"],
  [16, 4, 3, "second band"],
  [15, 5, 6, "third band boundary"],
  [10, 10, 6, "final maximum clamp"],
] as const) {
  const result = bandField.query(x, 0, 20);
  assert(result.shoreDistanceM === expectedDistance, `${label} shoreline distance ${result.shoreDistanceM} != ${expectedDistance}`);
  assert(result.authoredTargetDepthM === expectedDepth && result.targetFloorLevelM === 10 - expectedDepth, `${label} depth/floor changed`);
}

// Authored target depth is not actual terrain depth: high terrain is dry; low terrain may exceed target.
const highTerrain = bandField.query(10, 0, 11);
const lowTerrain = bandField.query(10, 0, -10);
assert(highTerrain.type === "basin" && highTerrain.isSubmerged === false && highTerrain.actualSubmergedDepthM === 0, "high basin terrain was claimed submerged");
assert(lowTerrain.authoredTargetDepthM === 6 && lowTerrain.actualSubmergedDepthM === 20, "actual depth was incorrectly clamped to authored target");

// Highest surface wins overlaps; equal surfaces use portable id, independent of input order.
const overlapBodies = [
  rectangle("z-low", 11, -5, -5, 5, 5),
  rectangle("z-tie", 13, -5, -5, 5, 5),
  rectangle("a-tie", 13, -5, -5, 5, 5, { kind: "reservoir" }),
];
const overlapA = createWaterField(sealedMap(overlapBodies));
const overlapB = createWaterField(sealedMap([...overlapBodies].reverse()));
assert(overlapA.query(0, 0).id === "a-tie" && overlapA.query(0, 0).kind === "reservoir", "overlap level/id policy changed");
assert(JSON.stringify(overlapA.query(0, 0, 9)) === JSON.stringify(overlapB.query(0, 0, 9)), "overlap result depends on authored array order");

// A proven-submerged ocean participates in the same highest-surface decision. A below-sea basin
// cannot mask the global ocean; an above-sea basin still wins, and basin wins an exact level tie.
const belowSeaBasin = createWaterField(sealedMap([rectangle("below-sea", 3, -10, -10, 10, 10)], 5));
const oceanOverBasin = belowSeaBasin.query(0, 0, 4);
assert(oceanOverBasin.type === "ocean" && oceanOverBasin.surfaceLevelM === 5 && oceanOverBasin.actualSubmergedDepthM === 1, "lower basin masked proven-submerged ocean");
const aboveSeaBasin = createWaterField(sealedMap([rectangle("above-sea", 8, -10, -10, 10, 10)], 5));
assert(aboveSeaBasin.query(0, 0, 4).id === "above-sea", "above-sea basin did not beat ocean surface");
const tiedSeaBasin = createWaterField(sealedMap([rectangle("sea-level-basin", 5, -10, -10, 10, 10)], 5));
assert(tiedSeaBasin.query(0, 0, 4).id === "sea-level-basin", "basin did not win explicit equal-ocean-level tie");

// Ocean is only wet with supplied terrain below sea level. Without terrain it is a candidate,
// not a claim that the unbounded plane is submerged.
const oceanField = createWaterField(sealedMap([], 5));
const unknownOcean = oceanField.query(100, 100);
const wetOcean = oceanField.query(100, 100, 2);
const dryOcean = oceanField.query(100, 100, 5);
assert(unknownOcean.type === "ocean" && unknownOcean.isSubmerged === null && unknownOcean.surfaceLevelM === null && unknownOcean.oceanSurfaceCandidateM === 5, "unknown ocean candidate claims wetness or lost sea level");
assert(wetOcean.type === "ocean" && wetOcean.isSubmerged === true && wetOcean.surfaceLevelM === 5 && wetOcean.actualSubmergedDepthM === 3, "submerged ocean result changed");
assert(dryOcean.type === "dry" && dryOcean.isSubmerged === false && dryOcean.oceanSurfaceCandidateM === 5, "terrain at sea level was not dry");

// Identity and source data fail closed. Structural WaterBody parsing remains canonical: malformed
// bodies are re-sealed so the failure proves the parser, not merely a stale hash.
const stale = sealedMap([islandPond]);
stale.seaLevel = 1;
const staleError = rejects(() => createWaterField(stale), /content hash mismatch/, "stale WorldMap identity was accepted");
assert(staleError instanceof WaterFieldValidationError, "identity rejection was not typed");
const malformedBodyMap = sealedMap([rectangle("bad-depth", 1, 0, 0, 10, 10)]);
malformedBodyMap.waterBodies[0].depthZones[0].depthM = 0;
malformedBodyMap.provenance.contentHash = worldMapContentHash(malformedBodyMap);
rejects(() => createWaterField(malformedBodyMap), /finite, positive/, "malformed re-hashed WaterBody was accepted");
const nonfinite = sealedMap([]);
nonfinite.seaLevel = Number.NaN;
rejects(() => createWaterField(nonfinite), /plain finite/, "non-finite WorldMap was accepted");
rejects(() => field.query(Number.POSITIVE_INFINITY, 0), /finite/, "non-finite query was accepted");
rejects(() => field.query(1_000_000_000_001, 0), /absolute value/, "query coordinate cap was not enforced");
const excessiveCoordinate = sealedMap([rectangle("too-far", 1, WATER_LIMITS.absCoordinateM + 1, 0, WATER_LIMITS.absCoordinateM + 2, 2)]);
rejects(() => createWaterField(excessiveCoordinate), /WaterBody contract rejected/, "authored coordinate cap was not enforced");

// Indexed semantics match a brute-force reference made from one-body fields across deterministic
// probes. The sparse BVH must inspect fewer candidates than all bodies.
const sparseBodies: Body[] = [];
for (let index = 0; index < 32; index++) {
  const x = (index % 8) * 50;
  const z = Math.floor(index / 8) * 50;
  sparseBodies.push(rectangle(`sparse-${String(index).padStart(2, "0")}`, 10 + index % 3, x, z, x + 20, z + 20));
}
const indexed = createWaterField(sealedMap(sparseBodies, -20));
const singles = sparseBodies.map((body) => createWaterField(sealedMap([body], -20)));
let maximumCandidates = 0;
for (let probe = 0; probe < 96; probe++) {
  const x = ((probe * 73) % 420) - 20;
  const z = ((probe * 41) % 220) - 20;
  const actual = indexed.queryWithStats(x, z, 100);
  maximumCandidates = Math.max(maximumCandidates, actual.stats.candidateBodies);
  const matches = singles.map((single) => single.query(x, z, 100)).filter((result) => result.type === "basin");
  matches.sort((left, right) => (right.surfaceLevelM! - left.surfaceLevelM!) || (left.id! < right.id! ? -1 : 1));
  const expected = matches[0];
  assert(actual.result.type === (expected === undefined ? "dry" : "basin"), `indexed classification diverged at probe ${probe}`);
  if (expected !== undefined) {
    assert(actual.result.id === expected.id && actual.result.authoredTargetDepthM === expected.authoredTargetDepthM, `indexed winner/depth diverged at probe ${probe}`);
  }
}
assert(maximumCandidates < sparseBodies.length, `sparse BVH visited all ${sparseBodies.length} bodies`);

// Grid records are fixed-layout LE bytes generated through scalar query semantics.
const sampleOptions = { rect: { x0: -25, z0: -25, w: 50, h: 50 }, rows: 5, cols: 5, terrainSampler: () => 8 };
const sampleA = field.sampleGrid(sampleOptions);
const sampleB = field.sampleGrid(sampleOptions);
assert(sampleA.bytes.length === 25 * WATER_SAMPLE_RECORD_BYTES && bytesEqual(sampleA.bytes, sampleB.bytes), "repeat grid samples were not byte-identical");
const sampleView = new DataView(sampleA.bytes.buffer, sampleA.bytes.byteOffset, sampleA.bytes.byteLength);
assert(sampleView.getUint8(0) === WATER_SAMPLE_CLASS_DRY, "outside sample did not use scalar dry-ocean semantics");
assert(sampleView.getUint8(12 * WATER_SAMPLE_RECORD_BYTES) === WATER_SAMPLE_CLASS_DRY, "center hole sample was not dry");
assert(sampleView.getUint8(11 * WATER_SAMPLE_RECORD_BYTES) === WATER_SAMPLE_CLASS_BASIN, "basin sample classification changed");
const unknownSample = oceanField.sampleGrid({ rect: { x0: 0, z0: 0, w: 1, h: 1 }, rows: 1, cols: 1 });
assert(unknownSample.bytes[0] === WATER_SAMPLE_CLASS_OCEAN && unknownSample.bytes[1] === WATER_SAMPLE_SUBMERGED_UNKNOWN, "sample without terrain claimed ocean wetness");
rejects(() => field.sampleGrid({ ...sampleOptions, rows: MAX_WATER_FIELD_ROWS + 1 }), /rows/, "sample row cap was not enforced");
rejects(() => field.sampleGrid({ ...sampleOptions, cols: MAX_WATER_FIELD_COLS + 1 }), /cols/, "sample column cap was not enforced");
rejects(() => field.sampleGrid({ ...sampleOptions, terrainSampler: () => Number.NaN }), /finite/, "non-finite terrain sample was accepted");
let cancellationChecks = 0;
const cancellation = rejects(
  () => field.sampleGrid({ rect: { x0: -25, z0: -25, w: 50, h: 50 }, rows: 257, cols: 257, shouldCancel: () => ++cancellationChecks === 2 }),
  /cancelled/,
  "mid-grid cancellation was ignored",
);
assert(cancellation instanceof WaterFieldCancelledError && cancellationChecks === 2, "grid cancellation was not typed/polled in-loop");

// Near-budget legal basin geometry: 512-edge outer ring plus 32 disjoint 45-edge holes is the
// largest equal-hole construction below the canonical 2M topology-work ceiling (46 edges/hole
// crosses it). Exact edge-BVH distances must match brute force without scanning all 1,952 edges.
const complexBody = rectangle("complex-basin", 20, -1000, -1000, 1000, 1000, {
  kind: "reservoir",
  footprint: {
    points: regularRing(0, 0, 1000, WATER_LIMITS.ringPoints),
    holes: Array.from({ length: WATER_LIMITS.holes }, (_, index) =>
      regularRing((index % 8 - 3.5) * 180, (Math.floor(index / 8) - 1.5) * 180, 35, 45)),
  },
  depthZones: bands,
});
const complexTopology = inspectWaterBodyTopology([complexBody]);
assert(complexTopology.ok && complexTopology.workUnits === 1_967_086, `complex legal topology work changed: ${JSON.stringify(complexTopology)}`);
const overBudgetComplex = { ...complexBody, footprint: {
  points: complexBody.footprint.points,
  holes: Array.from({ length: WATER_LIMITS.holes }, (_, index) =>
    regularRing((index % 8 - 3.5) * 180, (Math.floor(index / 8) - 1.5) * 180, 35, 46)),
} };
const overBudgetTopology = inspectWaterBodyTopology([overBudgetComplex]);
assert(!overBudgetTopology.ok && overBudgetTopology.workUnits === WATER_LIMITS.topologyWorkUnits + 1, "complex topology ceiling control did not cross the exact work cap");
const complexBuildStart = globalThis.performance?.now() ?? Date.now();
const complexField = createWaterField(sealedMap([complexBody], -5));
const complexBuildMs = (globalThis.performance?.now() ?? Date.now()) - complexBuildStart;
assert(complexField.buildStats.edgeCount === 1_952, `complex retained edge count ${complexField.buildStats.edgeCount} != 1952`);
let complexSegmentTests = 0;
let complexEdgeNodes = 0;
let basinParityProbes = 0;
for (let probe = 0; probe < 96; probe++) {
  const angle = (probe + 0.37) * Math.PI * 2 / 96;
  const radius = 650 + (probe % 4) * 70;
  const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
  const queried = complexField.queryWithStats(x, z, 10);
  complexSegmentTests += queried.stats.segmentTests;
  complexEdgeNodes += queried.stats.edgeNodesVisited;
  assert((queried.result.type === "basin") === bruteContains(complexBody, x, z), `edge BVH membership diverged at complex probe ${probe}`);
  if (queried.result.type !== "basin") continue;
  basinParityProbes++;
  const expectedDistance = bruteShoreDistance(complexBody, x, z);
  assert(Math.abs(queried.result.shoreDistanceM! - expectedDistance) <= 1e-10, `edge BVH distance diverged at complex probe ${probe}`);
}
assert(basinParityProbes >= 80, `complex parity had only ${basinParityProbes} basin probes`);
assert(complexSegmentTests / 96 < complexField.buildStats.edgeCount / 2, "complex query scanned a broad fraction of shoreline edges");
const firstHoleBoundary = complexBody.footprint.holes![0][0];
assert(complexField.query(firstHoleBoundary[0], firstHoleBoundary[1], 30).type === "dry", "complex hole boundary policy changed");
const complexGridStart = globalThis.performance?.now() ?? Date.now();
const complexSample = complexField.sampleGrid({
  rect: { x0: -1000, z0: -1000, w: 2000, h: 2000 },
  rows: MAX_WATER_FIELD_ROWS,
  cols: MAX_WATER_FIELD_COLS,
  terrainSampler: () => 10,
});
const complexGridMs = (globalThis.performance?.now() ?? Date.now()) - complexGridStart;
assert(complexSample.bytes.length === MAX_WATER_FIELD_ROWS * MAX_WATER_FIELD_COLS * WATER_SAMPLE_RECORD_BYTES, "complex maximum sample byte length changed");

// Maximum hostile body count remains bounded and does not perform body-pair validation. Reuse it
// for the informational production-path benchmark: build + 100k queries + maximum grid sample.
const maximumBodies: Body[] = [];
for (let index = 0; index < WATER_LIMITS.bodies; index++) {
  const col = index % 64;
  const row = Math.floor(index / 64);
  const x = col * 20;
  const z = row * 20;
  maximumBodies.push(rectangle(`max-${String(index).padStart(4, "0")}`, 5 + index % 7, x, z, x + 8, z + 8));
}
const now = (): number => globalThis.performance?.now() ?? Date.now();
const runtimeProcess = (globalThis as unknown as { process?: { memoryUsage?: () => { rss: number } } }).process;
const rss = (): number | null => runtimeProcess?.memoryUsage?.().rss ?? null;
const rssBefore = rss();
const buildStart = now();
const maximumField = createWaterField(sealedMap(maximumBodies, -5));
const buildMs = now() - buildStart;
assert(maximumField.buildStats.bodyCount === WATER_LIMITS.bodies, "maximum body count did not build");
assert(maximumField.buildStats.nodeCount <= MAX_WATER_FIELD_BVH_NODES && maximumField.buildStats.maxLeafBodies <= 8, "BVH retained-node/leaf cap changed");
assert(maximumField.buildStats.edgeNodeCount <= maximumField.buildStats.retainedEdgeNodeCap, "edge BVH retained-node cap changed");
assert(maximumField.buildStats.bodyPairValidationWork === 0, "quadratic body-pair validation was introduced");
const tooManyMap = sealedMap([...maximumBodies, rectangle("overflow", 1, 2000, 2000, 2008, 2008)]);
rejects(() => createWaterField(tooManyMap), /0\.\.4096 entries/, "body count cap was not enforced");

let candidateSignals = 0;
let edgeSignals = 0;
let checksum = 0;
const queryStart = now();
for (let index = 0; index < 100_000; index++) {
  const col = (index * 17) & 63;
  const row = (index * 29) & 63;
  const x = col * 20 + (index % 11);
  const z = row * 20 + (index % 13);
  const queried = maximumField.queryWithStats(x, z, 0);
  candidateSignals += queried.stats.candidateBodies;
  edgeSignals += queried.stats.segmentTests;
  checksum += queried.result.type === "basin" ? 2 : queried.result.type === "ocean" ? 1 : 0;
}
const queryMs = now() - queryStart;
assert(candidateSignals < 100_000 * WATER_LIMITS.bodies / 100, "benchmark queries degenerated to broad body scans");
const gridStart = now();
const maximumSample = maximumField.sampleGrid({
  rect: { x0: 0, z0: 0, w: 1268, h: 1268 },
  rows: MAX_WATER_FIELD_ROWS,
  cols: MAX_WATER_FIELD_COLS,
  terrainSampler: (x: number, z: number) => ((Math.floor(x) + Math.floor(z)) & 1) === 0 ? 0 : 20,
});
const gridMs = now() - gridStart;
const rssAfter = rss();
const rssDelta = rssBefore === null || rssAfter === null ? null : Math.max(0, rssAfter - rssBefore);
assert(maximumSample.cells === MAX_WATER_FIELD_ROWS * MAX_WATER_FIELD_COLS, "maximum grid cell count changed");

console.log(
  `p_water_field OK: hash-verified canonical WaterBody input; immutable basin/ocean/dry queries; outer-wet/hole-dry boundaries; `
  + `half-open bands with final clamp; highest-level/id overlaps; BVH parity and bounded sampling proven. `
  + `Benchmark ${WATER_LIMITS.bodies} bodies/${maximumField.buildStats.edgeCount} edges/${maximumField.buildStats.nodeCount} nodes: `
  + `build ${buildMs.toFixed(3)} ms; 100k queries ${queryMs.toFixed(3)} ms `
  + `(avg candidates ${(candidateSignals / 100_000).toFixed(3)}, segment tests ${(edgeSignals / 100_000).toFixed(3)}); `
  + `257x257 sample ${gridMs.toFixed(3)} ms/${maximumSample.bytes.length} bytes; RSS delta ${rssDelta === null ? "n/a" : `${(rssDelta / (1024 * 1024)).toFixed(2)} MiB`}; checksum ${checksum}. `
  + `Complex legal basin ${complexField.buildStats.edgeCount} edges/${complexField.buildStats.edgeNodeCount} edge nodes at ${complexTopology.workUnits} topology units: `
  + `build ${complexBuildMs.toFixed(3)} ms; parity probes ${basinParityProbes}; avg segment tests ${(complexSegmentTests / 96).toFixed(3)}/edge nodes ${(complexEdgeNodes / 96).toFixed(3)}; `
  + `257x257 sample ${complexGridMs.toFixed(3)} ms/${complexSample.bytes.length} bytes.`,
);
