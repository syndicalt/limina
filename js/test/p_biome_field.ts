import {
  BIOME_FIELD_NONE,
  BIOME_FIELD_WEIGHT_TOTAL,
  BiomeFieldCancelledError,
  compileBiomeField,
  inspectBiomeField,
  resolveBiomeFieldTarget,
} from "../src/world/biome-field.mjs";
import { BIOME_PACK_SCHEMA, parseBiomePack } from "../src/world/biome-ir.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_field FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(`${error.name}: ${error.message}`), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const selected = new Set(["alpine", "desert", "grassland"]);
const PACK = parseBiomePack({
  schema: BIOME_PACK_SCHEMA,
  id: "field-test",
  version: "1.0.0",
  definitions: BIOME_LIBRARY_V1.definitions.filter((definition: any) => selected.has(definition.id)),
  legacyAliases: [
    { legacyKind: "desert", biomeId: "desert" },
    { legacyKind: "grass", biomeId: "grassland" },
    { legacyKind: "mountain", biomeId: "alpine" },
  ],
  provenance: { sourceUri: "limina://tests/biome-field", licenseId: "CC0-1.0", authoredBy: "Limina Tests" },
});

const square = (minX: number, maxX: number) => [[minX, -10], [maxX, -10], [maxX, 10], [minX, 10]];
const DESERT_INFLUENCE = {
  id: "desert-east",
  target: { legacyKind: "desert" },
  polygon: square(0, 10),
  featherM: 4,
  strength: 2,
};
const ALPINE_RULE = {
  id: "alpine-high",
  target: { biomeId: "alpine" },
  strength: 2,
  elevationM: { min: 100, max: 200, feather: 50 },
  slope01: null,
  waterDistanceM: null,
};

function samples(cells: number, elevation = 0) {
  return {
    temperatureC: new Float32Array(cells).fill(10),
    moisture01: new Float32Array(cells).fill(0.4),
    elevationM: new Float32Array(cells).fill(elevation),
    slope01: new Float32Array(cells).fill(0.2),
    waterDistanceM: new Float32Array(cells).fill(50),
  };
}
function input(originX: number, cols: number, elevation = 0, influences = [DESERT_INFLUENCE], modifiers = [ALPINE_RULE]) {
  return {
    pack: PACK,
    grid: { origin: [originX, 0], rows: 1, cols, cellSizeM: 1 },
    samples: samples(cols, elevation),
    influences,
    modifiers,
    topN: 3,
    climateFeather: { temperatureC: 6, moisture01: 0.3 },
  };
}
function cellWeights(field: any, cell: number): Map<string, number> {
  const result = new Map<string, number>();
  for (let rank = 0; rank < field.topN; rank++) {
    const offset = cell * field.topN + rank;
    const index = field.indices[offset];
    if (index !== BIOME_FIELD_NONE) result.set(field.biomeIds[index], field.weights[offset]);
  }
  return result;
}

const field = compileBiomeField(input(-2, 5));
inspectBiomeField(field);
assert(Object.isFrozen(field) && Object.isFrozen(field.grid) && Object.isFrozen(field.biomeIds), "portable field metadata escaped mutable ownership");
for (let cell = 0; cell < 5; cell++) {
  let sum = 0;
  for (let rank = 0; rank < field.topN; rank++) sum += field.weights[cell * field.topN + rank];
  assert(sum === BIOME_FIELD_WEIGHT_TOTAL, `cell ${cell} did not normalize exactly to uint16 unity`);
}

// Feathered polygon influence must change continuously across the border, retaining multiple
// normalized contributors instead of switching a winner-take-all enum.
const desert = Array.from({ length: 5 }, (_, cell) => cellWeights(field, cell).get("desert") ?? 0);
assert(desert.every((weight) => weight > 0) && desert[0] < desert[1] && desert[1] < desert[2]
  && desert[2] < desert[3] && desert[3] < desert[4],
`polygon feather did not produce a continuous multi-biome border: ${desert.join(",")}`);
assert(Array.from({ length: 5 }, (_, cell) => cellWeights(field, cell).size).every((size) => size >= 2),
  "top-N field collapsed to winner-take-all at a feathered border");

// Adjacent independently compiled grids agree byte-for-byte at the shared world coordinate.
const left = compileBiomeField(input(-2, 3)); // -2,-1,0
const right = compileBiomeField(input(0, 3)); // 0,1,2
for (let rank = 0; rank < 3; rank++) {
  assert(left.indices[2 * 3 + rank] === right.indices[rank] && left.weights[2 * 3 + rank] === right.weights[rank],
    `shared-edge biome rank ${rank} diverged across independently compiled fields`);
}

// Canonical id sorting makes influence/rule insertion order irrelevant, including floating sums.
const secondInfluence = { ...DESERT_INFLUENCE, id: "desert-west", polygon: square(-10, 0), strength: 0.25 };
const secondRule = { ...ALPINE_RULE, id: "alpine-scree", strength: 0.35, elevationM: null, slope01: { min: 0.1, max: 0.5, feather: 0.1 } };
const ordered = compileBiomeField(input(-2, 5, 150, [DESERT_INFLUENCE, secondInfluence], [ALPINE_RULE, secondRule]));
const reversed = compileBiomeField(input(-2, 5, 150, [secondInfluence, DESERT_INFLUENCE], [secondRule, ALPINE_RULE]));
assert(JSON.stringify([...ordered.indices, ...ordered.weights]) === JSON.stringify([...reversed.indices, ...reversed.weights]),
  "influence/modifier insertion order changed field bytes");

// Elevation auto-rule is a continuous additive modifier and materially raises alpine weight.
const low = compileBiomeField(input(-2, 5, 0));
const high = compileBiomeField(input(-2, 5, 150));
assert((cellWeights(high, 0).get("alpine") ?? 0) > (cellWeights(low, 0).get("alpine") ?? 0),
  "elevation auto-rule did not raise its target biome weight");

// Explicit legacy aliases resolve to the same canonical definition id; missing aliases fail closed.
assert(resolveBiomeFieldTarget(PACK, { legacyKind: "desert" }) === "desert"
  && resolveBiomeFieldTarget(PACK, { biomeId: "desert" }) === "desert", "legacy/direct target resolution diverged");
rejects(() => resolveBiomeFieldTarget(PACK, { legacyKind: "water" }), /no explicit pack alias/, "missing legacy alias silently guessed a biome");

// Cancellation is checked before output allocation and once per row.
let cancelled = false;
try { compileBiomeField(input(0, 3), { signal: { aborted: true } }); } catch (error) { cancelled = error instanceof BiomeFieldCancelledError; }
assert(cancelled, "pre-cancelled field compilation did not stop with the domain cancellation error");
let cancellationChecks = 0;
cancelled = false;
try {
  compileBiomeField({ ...input(0, 3), grid: { origin: [0, 0], rows: 4, cols: 3, cellSizeM: 1 }, samples: samples(12) }, {
    signal: { get aborted() { return ++cancellationChecks >= 3; } },
  });
} catch (error) { cancelled = error instanceof BiomeFieldCancelledError; }
assert(cancelled && cancellationChecks === 3, "row-bounded cancellation was not observed during field work");
let callbackChecks = 0;
cancelled = false;
try {
  compileBiomeField(input(0, 3), { shouldCancel: () => ++callbackChecks === 2 });
} catch (error) { cancelled = error instanceof BiomeFieldCancelledError; }
assert(cancelled && callbackChecks === 2, "direct compiler cancellation was not polled during sample validation");

// The field dimensions and aggregate cell cap deliberately agree at the terrain compiler's
// canonical maximum master grid. This regression catches the former 1025x1025 vs 1024x1024 lie.
const maximumCells = 1025 * 1025;
const maximumField = compileBiomeField({
  pack: PACK,
  grid: { origin: [0, 0], rows: 1025, cols: 1025, cellSizeM: 1 },
  samples: samples(maximumCells),
  influences: [],
  modifiers: [],
  topN: 2,
  climateFeather: { temperatureC: 6, moisture01: 0.3 },
});
assert(maximumField.diagnostics.cells === maximumCells && maximumField.indices.length === maximumCells * 2,
  "canonical 1025x1025 terrain master grid was rejected or truncated");

// Hostile shapes and selectors fail before work begins.
rejects(() => compileBiomeField({ ...input(0, 3), influences: [{ ...DESERT_INFLUENCE, target: { biomeId: "unknown" } }] }), /unknown biome/, "unknown influence target was accepted");
rejects(() => compileBiomeField({ ...input(0, 3), influences: [{ ...DESERT_INFLUENCE, polygon: [[0, 0], [1, 1]] }] }), /at least three/, "degenerate polygon was accepted");
rejects(() => compileBiomeField({ ...input(0, 3), influences: [{ ...DESERT_INFLUENCE, polygon: [[0, 0], [1, 1], [2, 2]] }] }), /nonzero area/, "zero-area polygon was accepted");
rejects(() => compileBiomeField({ ...input(0, 3), modifiers: [{ ...ALPINE_RULE, elevationM: null }] }), /at least one sampled dimension/, "dimensionless modifier was accepted");
const accessorInfluence = { ...DESERT_INFLUENCE } as any;
Object.defineProperty(accessorInfluence, "strength", { enumerable: true, get() { throw new Error("must not execute"); } });
rejects(() => compileBiomeField({ ...input(0, 3), influences: [accessorInfluence] }), /data field/, "influence accessor was invoked or accepted");
rejects(() => compileBiomeField({ ...input(0, 3), extra: true } as any), /unknown field/, "unknown top-level field was accepted");
rejects(() => compileBiomeField({ ...input(0, 3), pack: { ...PACK, surprise: true } } as any), /unknown field/, "invalid biome pack bypassed canonical parsing");

// Work cap is computed before output allocation. A bounded 450x450 fixture with a 256-point
// influence exceeds the declared operation ceiling without approaching process memory limits.
const capCells = 450 * 450;
const ring = Array.from({ length: 256 }, (_, index) => {
  const angle = index / 256 * Math.PI * 2;
  return [Math.cos(angle) * 100, Math.sin(angle) * 100];
});
rejects(() => compileBiomeField({
  pack: BIOME_LIBRARY_V1,
  grid: { origin: [0, 0], rows: 450, cols: 450, cellSizeM: 1 },
  samples: samples(capCells),
  influences: [{ ...DESERT_INFLUENCE, target: { biomeId: "desert" }, polygon: ring }],
  modifiers: [],
  topN: 2,
  climateFeather: { temperatureC: 6, moisture01: 0.3 },
}), /work .* exceeds/, "adversarial work estimate crossed the hard cap");

// The portable inspector independently catches corrupt normalization.
const saved = field.weights[0];
field.weights[0] = 0;
rejects(() => inspectBiomeField(field), /invalid or unsorted|normalize exactly/, "corrupt portable weights passed inspection");
field.weights[0] = saved;

console.log(`p_biome_field OK: ${field.grid.cols} blended cells, exact uint16 normalization, feathered seams, canonical ordering, legacy aliases, modifiers, cancellation, hostile input, and work caps`);
