import {
  DERIVED_TERRAIN_RESIDENCY_SCHEMA,
  derivedTerrainResidencyKey,
  parseDerivedTerrainResidency,
  selectDerivedTerrainChunks,
} from "../src/browser/derived-terrain-residency.ts";
import { createTerrainGridSpec } from "../src/terrain/grid.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_terrain_residency FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let failure: unknown;
  try { fn(); } catch (error) { failure = error; }
  assert(failure instanceof Error && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not reject"}`);
}

const residency = { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 7 };
const parsed = parseDerivedTerrainResidency(residency);
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.center) && parsed.radius === 7, "residency was not canonical and immutable");
assert(derivedTerrainResidencyKey(parsed) === "0:0:0:7", "residency key changed");
const negativeZero = parseDerivedTerrainResidency({ ...residency, center: [-0, -0] });
assert(!Object.is(negativeZero.center[0], -0) && !Object.is(negativeZero.center[1], -0), "negative zero was not normalized");

for (const [value, pattern, label] of [
  [{ ...residency, extra: true }, /fields/, "extra field"],
  [{ ...residency, center: [0] }, /two-element/, "short center"],
  [{ ...residency, center: [0, Number.NaN] }, /finite/, "NaN center"],
  [{ ...residency, lod: 1 }, /invalid/, "non-LOD0"],
  [{ ...residency, radius: 8 }, /invalid/, "oversized radius"],
] as const) rejects(() => parseDerivedTerrainResidency(value), pattern, `${label} was accepted`);

const sparse = [0, 0];
delete sparse[1];
rejects(() => parseDerivedTerrainResidency({ ...residency, center: sparse }), /dense/, "sparse center was accepted");
const accessor = [0, 0];
Object.defineProperty(accessor, "1", { enumerable: true, get: () => 0 });
rejects(() => parseDerivedTerrainResidency({ ...residency, center: accessor }), /data values/, "accessor center was accepted");

const chunks = [];
for (let tz = -10; tz < 10; tz++) for (let tx = -10; tx < 10; tx++) {
  chunks.push(Object.freeze({ chunkId: `c:${tx}:${tz}`, lod: 0, tx, tz }));
}
chunks.push(Object.freeze({ chunkId: "lod1", lod: 1, tx: 0, tz: 0 }));
const grid = createTerrainGridSpec({ gridId: "test.surface", origin: [-32, -32], chunkSizeM: 64, defaultSamples: 3 });
const selected = selectDerivedTerrainChunks({ grid, chunks }, parsed);
assert(selected.length === 225 && Object.isFrozen(selected), "radius-7 window was not capped at exactly 225 chunks");
assert(selected.every((chunk) => chunk.lod === 0 && Math.abs(chunk.tx) <= 7 && Math.abs(chunk.tz) <= 7), "selection admitted an out-of-window chunk");
assert(selected.every((chunk, index) => chunks.indexOf(chunk) < chunks.indexOf(selected[index + 1] ?? chunks.at(-1)) || index === selected.length - 1),
  "selection did not preserve manifest order");
rejects(() => selectDerivedTerrainChunks(
  { grid, chunks },
  { ...residency, center: [1_000_000, 1_000_000] },
), /no manifest chunks/, "empty residency was accepted");

console.log("[js] p_derived_terrain_residency OK: strict versioned residency, finite dense centers, LOD0 square selection, exact 225 cap, order, and empty rejection proven");
