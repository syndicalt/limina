// B3 renderer-independent terrain surface publication. It resolves the immutable biome runtime
// publication onto a bounded grid while keeping one global, sorted content-addressed role table.
// The later TSL consumer can therefore use one graph/draw per tile with at most 16 samples.

export const BIOME_SURFACE_PLAN_SCHEMA = "limina.biome-surface-plan/v1";
export const BIOME_SURFACE_PLAN_NONE = 0xff;
export const BIOME_SURFACE_PLAN_LIMITS = Object.freeze({ rows: 1025, cols: 1025, cells: 1_050_625, roles: 32, slots: 16, bytes: 64 * 1024 * 1024 });

function integer(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`); return value; }
function finite(value, label) { if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must be a canonical finite number`); return value; }
function bindingKey(entry) { return `${entry.binding.assetId}\u0000${entry.binding.contentHash}\u0000${entry.role}\u0000${JSON.stringify(entry.rule)}`; }

export function buildBiomeSurfacePlan(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("biome surface input must be an object");
  const publication = input.publication;
  if (publication === null || typeof publication !== "object" || typeof publication.sample !== "function" || publication.disposed === true) {
    throw new TypeError("biome surface plan requires a live runtime publication");
  }
  const grid = input.grid;
  if (grid === null || typeof grid !== "object" || Array.isArray(grid)) throw new TypeError("biome surface grid must be an object");
  const origin = grid.origin;
  if (!Array.isArray(origin) || origin.length !== 2) throw new TypeError("biome surface grid.origin must be [x,z]");
  const originX = finite(origin[0], "biome surface grid.origin[0]"), originZ = finite(origin[1], "biome surface grid.origin[1]");
  const rows = integer(grid.rows, 1, BIOME_SURFACE_PLAN_LIMITS.rows, "biome surface grid.rows");
  const cols = integer(grid.cols, 1, BIOME_SURFACE_PLAN_LIMITS.cols, "biome surface grid.cols");
  const cellSizeM = finite(grid.cellSizeM, "biome surface grid.cellSizeM");
  if (!(cellSizeM > 0)) throw new RangeError("biome surface grid.cellSizeM must be positive");
  const cells = rows * cols, outputBytes = cells * BIOME_SURFACE_PLAN_LIMITS.slots * 3;
  if (!Number.isSafeInteger(cells) || cells > BIOME_SURFACE_PLAN_LIMITS.cells || outputBytes > BIOME_SURFACE_PLAN_LIMITS.bytes) {
    throw new RangeError("biome surface plan exceeds its bounded output");
  }
  const allowPartial = input.allowPartial === true;
  const samples = new Array(cells), roleMap = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col, sample = publication.sample(originX + col * cellSizeM, originZ + row * cellSizeM);
      if (sample === null) throw new Error(`biome surface cell ${cell} is outside the runtime publication`);
      if (!allowPartial && sample.status !== "fulfilled") throw new Error(`biome surface cell ${cell} contains unfulfilled content`);
      if (sample.surfaces.length === 0) throw new Error(`biome surface cell ${cell} resolved no bound surface content`);
      if (sample.surfaces.length > BIOME_SURFACE_PLAN_LIMITS.slots) throw new RangeError(`biome surface cell ${cell} exceeds ${BIOME_SURFACE_PLAN_LIMITS.slots} samples`);
      samples[cell] = sample.surfaces;
      for (const entry of sample.surfaces) roleMap.set(bindingKey(entry), Object.freeze({ binding: entry.binding, role: entry.role, rule: entry.rule }));
    }
  }
  const roleEntries = [...roleMap].sort((left, right) => left[0].localeCompare(right[0]));
  if (roleEntries.length > BIOME_SURFACE_PLAN_LIMITS.roles) throw new RangeError(`biome surface roles ${roleEntries.length} exceed cap ${BIOME_SURFACE_PLAN_LIMITS.roles}`);
  const roleIndex = new Map(roleEntries.map(([key], index) => [key, index]));
  const indices = new Uint8Array(cells * BIOME_SURFACE_PLAN_LIMITS.slots); indices.fill(BIOME_SURFACE_PLAN_NONE);
  const weights = new Uint16Array(cells * BIOME_SURFACE_PLAN_LIMITS.slots);
  for (let cell = 0; cell < cells; cell++) {
    const entries = samples[cell];
    let sum = 0;
    for (let slot = 0; slot < entries.length; slot++) {
      indices[cell * BIOME_SURFACE_PLAN_LIMITS.slots + slot] = roleIndex.get(bindingKey(entries[slot]));
      weights[cell * BIOME_SURFACE_PLAN_LIMITS.slots + slot] = entries[slot].weightU16;
      sum += entries[slot].weightU16;
    }
    if (sum !== 65_535) throw new Error(`biome surface cell ${cell} weights total ${sum}, expected 65535`);
  }
  return Object.freeze({ schema: BIOME_SURFACE_PLAN_SCHEMA,
    identity: Object.freeze({ fieldContentHash: publication.fieldContentHash, runtimePackContentHash: publication.runtimePackContentHash }),
    grid: Object.freeze({ origin: Object.freeze([originX, originZ]), rows, cols, cellSizeM }),
    slots: BIOME_SURFACE_PLAN_LIMITS.slots,
    roles: Object.freeze(roleEntries.map(([, entry], index) => Object.freeze({ index, role: entry.role, rule: entry.rule, ...entry.binding }))),
    indices, weights, diagnostics: Object.freeze({ cells, roles: roleEntries.length, outputBytes }) });
}
