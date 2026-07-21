import {
  BIOME_FIELD_NONE,
  BIOME_FIELD_WEIGHT_TOTAL,
  inspectBiomeField,
} from "./biome-field.mjs";

function canonicalCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function quantize(entries, limit) {
  const selected = entries.slice(0, limit);
  const total = selected.reduce((sum, entry) => sum + entry.score, 0);
  if (!(total > 0)) return Object.freeze([]);
  const parts = selected.map((entry) => {
    const exact = entry.score / total * BIOME_FIELD_WEIGHT_TOTAL;
    const weightU16 = Math.floor(exact);
    return { ...entry, weightU16, remainder: exact - weightU16 };
  });
  let assigned = parts.reduce((sum, entry) => sum + entry.weightU16, 0);
  const byRemainder = [...parts].sort((left, right) =>
    right.remainder - left.remainder || (left.biomeId < right.biomeId ? -1 : left.biomeId > right.biomeId ? 1 : 0));
  for (let remaining = BIOME_FIELD_WEIGHT_TOTAL - assigned, index = 0; remaining > 0; remaining--, index++) {
    byRemainder[index % byRemainder.length].weightU16++;
    assigned++;
  }
  parts.sort((left, right) =>
    right.weightU16 - left.weightU16 || (left.biomeId < right.biomeId ? -1 : left.biomeId > right.biomeId ? 1 : 0));
  return Object.freeze(parts.map((entry) => Object.freeze({
    biomeId: entry.biomeId,
    weightU16: entry.weightU16,
    weight01: entry.weightU16 / BIOME_FIELD_WEIGHT_TOTAL,
  })));
}

/**
 * Build a validated world-coordinate sampler over one decoded biome field.
 * Bilinear interpolation blends the four neighboring ranked cells, then the
 * result is deterministically re-ranked and normalized to exactly 65535.
 */
export function createBiomeFieldSampler(input) {
  const field = inspectBiomeField(input);
  const { origin, rows, cols, cellSizeM } = field.grid;
  if (!Array.isArray(origin) || origin.length !== 2
      || !Number.isSafeInteger(rows) || rows < 1
      || !Number.isSafeInteger(cols) || cols < 1
      || typeof cellSizeM !== "number" || !Number.isFinite(cellSizeM) || !(cellSizeM > 0)) {
    throw new TypeError("biome field sampler requires a canonical finite grid");
  }
  const minX = origin[0], minZ = origin[1];
  const maxX = minX + (cols - 1) * cellSizeM;
  const maxZ = minZ + (rows - 1) * cellSizeM;
  const scores = new Float64Array(field.biomeIds.length);
  const touched = [];

  const addCell = (row, col, factor) => {
    if (!(factor > 0)) return;
    const offset = (row * cols + col) * field.topN;
    for (let rank = 0; rank < field.topN; rank++) {
      const biomeIndex = field.indices[offset + rank];
      if (biomeIndex === BIOME_FIELD_NONE) continue;
      if (scores[biomeIndex] === 0) touched.push(biomeIndex);
      scores[biomeIndex] += factor * field.weights[offset + rank];
    }
  };

  return Object.freeze({
    bounds: Object.freeze({ minX, minZ, maxX, maxZ }),
    sample(xInput, zInput) {
      const x = canonicalCoordinate(xInput, "biome sample x");
      const z = canonicalCoordinate(zInput, "biome sample z");
      if (x < minX || x > maxX || z < minZ || z > maxZ) return null;
      for (const index of touched) scores[index] = 0;
      touched.length = 0;

      const gx = cols === 1 ? 0 : (x - minX) / cellSizeM;
      const gz = rows === 1 ? 0 : (z - minZ) / cellSizeM;
      const col0 = Math.min(cols - 1, Math.floor(gx));
      const row0 = Math.min(rows - 1, Math.floor(gz));
      const col1 = Math.min(cols - 1, col0 + 1);
      const row1 = Math.min(rows - 1, row0 + 1);
      const tx = col1 === col0 ? 0 : gx - col0;
      const tz = row1 === row0 ? 0 : gz - row0;
      addCell(row0, col0, (1 - tx) * (1 - tz));
      addCell(row0, col1, tx * (1 - tz));
      addCell(row1, col0, (1 - tx) * tz);
      addCell(row1, col1, tx * tz);

      const ranked = touched.map((index) => ({ biomeId: field.biomeIds[index], score: scores[index] }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || (left.biomeId < right.biomeId ? -1 : left.biomeId > right.biomeId ? 1 : 0));
      const influences = quantize(ranked, field.topN);
      if (influences.length === 0) throw new Error("validated biome field produced an empty in-bounds sample");
      return Object.freeze({ dominantId: influences[0].biomeId, influences });
    },
  });
}
