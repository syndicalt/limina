// Deterministic extraction of an axis-aligned, grid-aligned biome-field snapshot.
// A snapshot is a new canonical biome field artifact authority: cells outside the
// requested domain cannot expand its reachable content closure.

import {
  BIOME_FIELD_LIMITS,
  BIOME_FIELD_SCHEMA,
  BIOME_FIELD_VERSION,
  inspectBiomeField,
} from "./biome-field.mjs";

export class BiomeFieldSnapshotError extends Error {
  constructor(message) { super(message); this.name = "BiomeFieldSnapshotError"; }
}
function fail(message) { throw new BiomeFieldSnapshotError(message); }
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(`${label} must be a canonical finite number`);
  return value;
}
function boundsRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("biome field snapshot bounds must be a plain object");
  }
  const keys = Object.keys(value).sort();
  const expected = ["maxX", "maxZ", "minX", "minZ"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`biome field snapshot bounds must contain exactly: ${expected.join(", ")}`);
  }
  const bounds = {
    minX: finite(value.minX, "biome field snapshot minX"),
    minZ: finite(value.minZ, "biome field snapshot minZ"),
    maxX: finite(value.maxX, "biome field snapshot maxX"),
    maxZ: finite(value.maxZ, "biome field snapshot maxZ"),
  };
  if (bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ) fail("biome field snapshot bounds are inverted");
  return bounds;
}

export function cropBiomeFieldSnapshot(fieldInput, boundsInput) {
  const field = inspectBiomeField(fieldInput);
  const bounds = boundsRecord(boundsInput);
  const { origin, rows, cols, cellSizeM } = field.grid;
  const fieldMaxX = origin[0] + (cols - 1) * cellSizeM;
  const fieldMaxZ = origin[1] + (rows - 1) * cellSizeM;
  if (bounds.minX < origin[0] || bounds.minZ < origin[1] || bounds.maxX > fieldMaxX || bounds.maxZ > fieldMaxZ) {
    fail("biome field snapshot bounds exceed the source field");
  }

  // The snapshot contains exactly the source sample points inside the closed domain.
  const col0 = Math.ceil((bounds.minX - origin[0]) / cellSizeM);
  const row0 = Math.ceil((bounds.minZ - origin[1]) / cellSizeM);
  const col1 = Math.floor((bounds.maxX - origin[0]) / cellSizeM);
  const row1 = Math.floor((bounds.maxZ - origin[1]) / cellSizeM);
  if (col0 > col1 || row0 > row1) fail("biome field snapshot domain contains no source sample points");
  const snapshotRows = row1 - row0 + 1;
  const snapshotCols = col1 - col0 + 1;
  const cells = snapshotRows * snapshotCols;
  if (cells > BIOME_FIELD_LIMITS.cells) fail("biome field snapshot exceeds the supported cell limit");

  const length = cells * field.topN;
  const indices = new Uint16Array(length);
  const weights = new Uint16Array(length);
  for (let row = 0; row < snapshotRows; row++) {
    const sourceOffset = ((row0 + row) * cols + col0) * field.topN;
    const targetOffset = row * snapshotCols * field.topN;
    const width = snapshotCols * field.topN;
    indices.set(field.indices.subarray(sourceOffset, sourceOffset + width), targetOffset);
    weights.set(field.weights.subarray(sourceOffset, sourceOffset + width), targetOffset);
  }
  const outputBytes = length * 4;
  const snapshot = Object.freeze({
    schema: BIOME_FIELD_SCHEMA,
    version: BIOME_FIELD_VERSION,
    pack: Object.freeze({ id: field.pack.id, version: field.pack.version }),
    grid: Object.freeze({
      origin: Object.freeze([origin[0] + col0 * cellSizeM, origin[1] + row0 * cellSizeM]),
      rows: snapshotRows,
      cols: snapshotCols,
      cellSizeM,
    }),
    topN: field.topN,
    biomeIds: Object.freeze([...field.biomeIds]),
    indices,
    weights,
    diagnostics: Object.freeze({
      cells,
      workUnits: length,
      outputBytes,
      influences: field.diagnostics.influences,
      modifiers: field.diagnostics.modifiers,
    }),
  });
  return inspectBiomeField(snapshot);
}
