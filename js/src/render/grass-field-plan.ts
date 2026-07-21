export const GRASS_FIELD_MAX_SLOTS = 1024;
// The cinematic 5x5 near window uses one independently modeled blade per fixed slot. 524,288
// keeps that complete 260-blade/m2 window under one explicit ceiling while lower quality tiers
// remain bounded by their substantially smaller package-owned blade budgets.
export const GRASS_FIELD_MAX_RESIDENT_SLOTS = 524_288;
export const GRASS_FIELD_PAGE_AXIS = 32;

export interface GrassFieldBounds { minX: number; minZ: number; maxX: number; maxZ: number }
export interface GrassFieldBlueNoisePlacement {
  readonly strategy: "world-matern-blue-noise/v1";
  /** Candidate-density multiplier. Runtime spacing is divided by sqrt(oversample). */
  readonly oversample: number;
  /** Hard minimum root distance measured in candidate-grid spacings. */
  readonly minimumDistanceMultiplier: number;
}
export type GrassFieldPlacement = GrassFieldBlueNoisePlacement;
export interface GrassFieldPlanInput {
  bounds: GrassFieldBounds;
  spacing: number;
  seed: number;
  /** Candidate-order density, 0..65535. Omit for an unconditional/full field. */
  density?: Uint16Array;
}
export interface GrassFieldPlan {
  readonly bounds: Readonly<GrassFieldBounds>;
  readonly spacing: number;
  readonly seed: number;
  readonly minGridX: number;
  readonly minGridZ: number;
  readonly columns: number;
  readonly rows: number;
  readonly slots: number;
  readonly gridCoordinates: Int32Array;
  readonly density: Uint16Array;
  readonly accepted: Uint8Array;
  readonly hash: string;
}

export interface GrassFieldCandidate {
  readonly gridX: number;
  readonly gridZ: number;
  readonly x: number;
  readonly z: number;
  readonly inside: boolean;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}
function u32(value: number): number { return value >>> 0; }
function gridQuotient(value: number, spacing: number): number {
  const quotient = value / spacing;
  const nearest = Math.round(quotient);
  return Math.abs(quotient - nearest) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8 ? nearest : quotient;
}
function gridFloor(value: number, spacing: number): number { return Math.floor(gridQuotient(value, spacing)); }
function gridCeil(value: number, spacing: number): number { return Math.ceil(gridQuotient(value, spacing)); }

interface GrassFieldGridShape {
  readonly spacing: number;
  readonly minGridX: number;
  readonly minGridZ: number;
  readonly maxGridX: number;
  readonly maxGridZ: number;
  readonly columns: number;
  readonly rows: number;
  readonly slots: number;
}

/** One authority for the tolerance-aware signed lattice shape. Counting and allocation must not
 * drift at negative or nominally grid-aligned floating-point bounds. */
function grassFieldGridShape(bounds: GrassFieldBounds, requestedSpacing: number): GrassFieldGridShape {
  const spacing = finite(requestedSpacing, "grass field spacing");
  if (spacing <= 0) throw new RangeError("grass field spacing must be positive");
  for (const [key, value] of Object.entries(bounds)) finite(value, `grass field bounds.${key}`);
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new RangeError("grass field bounds must be non-empty and half-open");
  const minGridX = gridFloor(bounds.minX, spacing);
  const minGridZ = gridFloor(bounds.minZ, spacing);
  const maxGridX = gridCeil(bounds.maxX, spacing);
  const maxGridZ = gridCeil(bounds.maxZ, spacing);
  for (const value of [minGridX, minGridZ, maxGridX, maxGridZ]) {
    if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("grass field signed grid coordinate exceeds int32");
  }
  const columns = maxGridX - minGridX, rows = maxGridZ - minGridZ;
  const slots = columns * rows;
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > GRASS_FIELD_MAX_SLOTS) {
    throw new RangeError(`grass field slots must be in [1, ${GRASS_FIELD_MAX_SLOTS}]`);
  }
  return Object.freeze({ spacing, minGridX, minGridZ, maxGridX, maxGridZ, columns, rows, slots });
}

/** Exact O(1) storage count for one canonical plan, with the same validation and signed-grid
 * snapping used by buildGrassFieldPlan. */
export function countGrassFieldPlanSlots(bounds: GrassFieldBounds, spacing: number): number {
  return grassFieldGridShape(bounds, spacing).slots;
}

/**
 * Split arbitrary half-open world bounds into canonical 32x32 lattice pages. Page identity is
 * anchored to the signed world grid, so negative coordinates, terrain-tile repartitioning, and
 * mount order cannot move a candidate between compute resources. Every returned bound builds a
 * plan with at most 1024 fixed slots at the same spacing.
 */
export function partitionGrassFieldBounds(bounds: GrassFieldBounds, spacing: number): ReadonlyArray<Readonly<GrassFieldBounds>> {
  const pitch = finite(spacing, "grass field spacing");
  if (pitch <= 0) throw new RangeError("grass field spacing must be positive");
  for (const [key, value] of Object.entries(bounds)) finite(value, `grass field bounds.${key}`);
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new RangeError("grass field bounds must be non-empty and half-open");
  const minGridX = gridFloor(bounds.minX, pitch), maxGridX = gridCeil(bounds.maxX, pitch);
  const minGridZ = gridFloor(bounds.minZ, pitch), maxGridZ = gridCeil(bounds.maxZ, pitch);
  for (const value of [minGridX, maxGridX, minGridZ, maxGridZ]) {
    if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("grass field signed grid coordinate exceeds int32");
  }
  const minPageX = Math.floor(minGridX / GRASS_FIELD_PAGE_AXIS), maxPageX = Math.floor((maxGridX - 1) / GRASS_FIELD_PAGE_AXIS);
  const minPageZ = Math.floor(minGridZ / GRASS_FIELD_PAGE_AXIS), maxPageZ = Math.floor((maxGridZ - 1) / GRASS_FIELD_PAGE_AXIS);
  const pages: Readonly<GrassFieldBounds>[] = [];
  for (let pageZ = minPageZ; pageZ <= maxPageZ; pageZ++) for (let pageX = minPageX; pageX <= maxPageX; pageX++) {
    const pageMinX = pageX * GRASS_FIELD_PAGE_AXIS * pitch;
    const pageMinZ = pageZ * GRASS_FIELD_PAGE_AXIS * pitch;
    pages.push(Object.freeze({
      minX: Math.max(bounds.minX, pageMinX), minZ: Math.max(bounds.minZ, pageMinZ),
      maxX: Math.min(bounds.maxX, pageMinX + GRASS_FIELD_PAGE_AXIS * pitch),
      maxZ: Math.min(bounds.maxZ, pageMinZ + GRASS_FIELD_PAGE_AXIS * pitch),
    }));
  }
  return Object.freeze(pages);
}

/** PCG-XSH-RR-derived 32-bit permutation used by Three's TSL hash, kept integer here. */
export function pcg32(value: number): number {
  const state = u32(Math.imul(u32(value), 747796405) + 2891336453);
  const word = u32(Math.imul(u32((state >>> ((state >>> 28) + 4)) ^ state), 277803737));
  return u32((word >>> 22) ^ word);
}

/** Signed-grid, seed, and substream mixer; every output depends only on canonical coordinates. */
export function grassFieldRandom(seed: number, gridX: number, gridZ: number, stream: number): number {
  let mixed = u32(seed);
  mixed = u32(mixed ^ Math.imul(gridX | 0, 0x9e3779b1));
  mixed = u32(mixed ^ Math.imul(gridZ | 0, 0x85ebca77));
  mixed = u32(mixed ^ Math.imul(stream | 0, 0xc2b2ae3d));
  return pcg32(mixed);
}

function placementPoint(seed: number, gridX: number, gridZ: number): readonly [number, number] {
  const jitter = grassFieldRandom(seed, gridX, gridZ, 1);
  return Object.freeze([
    gridX + (jitter & 0xffff) / 65536,
    gridZ + (jitter >>> 16) / 65536,
  ] as const);
}

/** Deterministic Matérn-II thinning over the infinite signed world grid. A candidate competes
 * against neighbors outside its current page/tile, so repartitioning cannot move or revive it. */
export function grassFieldPlacementAccepts(seed: number, gridX: number, gridZ: number,
  placement?: GrassFieldPlacement): boolean {
  if (placement === undefined) return true;
  if (placement.strategy !== "world-matern-blue-noise/v1"
      || !Number.isSafeInteger(placement.oversample) || placement.oversample < 1 || placement.oversample > 4
      || !Number.isFinite(placement.minimumDistanceMultiplier)
      || placement.minimumDistanceMultiplier < 0.5 || placement.minimumDistanceMultiplier > 2) {
    throw new RangeError("grass field placement is invalid");
  }
  const [x, z] = placementPoint(seed, gridX, gridZ);
  const priority = grassFieldRandom(seed, gridX, gridZ, 3);
  const radius = Math.ceil(placement.minimumDistanceMultiplier) + 1;
  const minimumDistance2 = placement.minimumDistanceMultiplier ** 2;
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx === 0 && dz === 0) continue;
    const neighborX = gridX + dx, neighborZ = gridZ + dz;
    const [nx, nz] = placementPoint(seed, neighborX, neighborZ);
    if ((nx - x) ** 2 + (nz - z) ** 2 >= minimumDistance2) continue;
    const neighborPriority = grassFieldRandom(seed, neighborX, neighborZ, 3);
    if (neighborPriority < priority || (neighborPriority === priority
        && (neighborZ < gridZ || (neighborZ === gridZ && neighborX < gridX)))) return false;
  }
  return true;
}

export function densityAccepts(density: number, draw: number): boolean {
  if (!Number.isSafeInteger(density) || density < 0 || density > 0xffff) throw new RangeError("density must be uint16");
  if (density === 0xffff) return true;
  return (draw & 0xffff) < density;
}

/** Canonical jittered point inside one world-anchored grid cell. Boundary cells can overlap two
 * plan bounds, but the point belongs to exactly one half-open bound, preventing duplicates. */
export function grassFieldCandidate(plan: Pick<GrassFieldPlan, "bounds" | "spacing" | "seed" | "gridCoordinates">, slot: number): GrassFieldCandidate {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot * 2 + 1 >= plan.gridCoordinates.length) throw new RangeError("grass field slot is out of range");
  const gridX = plan.gridCoordinates[slot * 2], gridZ = plan.gridCoordinates[slot * 2 + 1];
  const jitter = grassFieldRandom(plan.seed, gridX, gridZ, 1);
  const x = (gridX + 0.5) * plan.spacing + ((jitter & 0xffff) / 65536 - 0.5) * plan.spacing;
  const z = (gridZ + 0.5) * plan.spacing + ((jitter >>> 16) / 65536 - 0.5) * plan.spacing;
  return Object.freeze({
    gridX, gridZ, x, z,
    inside: x >= plan.bounds.minX && x < plan.bounds.maxX && z >= plan.bounds.minZ && z < plan.bounds.maxZ,
  });
}

function hashPlan(plan: Omit<GrassFieldPlan, "hash">): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const feed = (value: number) => {
    let word = BigInt(value >>> 0);
    for (let i = 0; i < 4; i++) { hash = (hash ^ (word & 0xffn)) * prime & 0xffffffffffffffffn; word >>= 8n; }
  };
  const feedFloat = (value: number) => {
    const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, true);
    feed(view.getUint32(0, true)); feed(view.getUint32(4, true));
  };
  feed(plan.seed); feed(plan.minGridX); feed(plan.minGridZ); feed(plan.columns); feed(plan.rows);
  feedFloat(plan.spacing);
  feedFloat(plan.bounds.minX); feedFloat(plan.bounds.minZ); feedFloat(plan.bounds.maxX); feedFloat(plan.bounds.maxZ);
  for (let i = 0; i < plan.density.length; i++) feed(plan.density[i]);
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/** World-anchored, half-open candidate grid. Repartitioning cannot change a cell's identity. */
export function buildGrassFieldPlan(input: GrassFieldPlanInput): GrassFieldPlan {
  const b = input.bounds;
  if (!Number.isSafeInteger(input.seed) || input.seed < -0x80000000 || input.seed > 0x7fffffff) {
    throw new RangeError("grass field seed must be an int32");
  }
  // Grid coordinates identify cells [g*spacing,(g+1)*spacing). Include every cell overlapping
  // the requested bounds; the jittered candidate's half-open inside test assigns boundary cells.
  const { spacing, minGridX, minGridZ, maxGridX, maxGridZ, columns, rows, slots } = grassFieldGridShape(b, input.spacing);
  if (input.density !== undefined && (Object.getPrototypeOf(input.density) !== Uint16Array.prototype || input.density.length !== slots)) {
    throw new RangeError(`grass field density must be a Uint16Array of length ${slots}`);
  }
  const density = input.density?.slice() ?? new Uint16Array(slots).fill(0xffff);
  const coords = new Int32Array(slots * 2), accepted = new Uint8Array(slots);
  let slot = 0;
  for (let z = minGridZ; z < maxGridZ; z++) for (let x = minGridX; x < maxGridX; x++, slot++) {
    coords[slot * 2] = x; coords[slot * 2 + 1] = z;
  }
  const planBase = Object.freeze({
    bounds: Object.freeze({ ...b }), spacing, seed: input.seed | 0, minGridX, minGridZ,
    columns, rows, slots, gridCoordinates: coords, density, accepted,
  });
  for (let index = 0; index < slots; index++) {
    const candidate = grassFieldCandidate(planBase, index);
    accepted[index] = candidate.inside && densityAccepts(density[index], grassFieldRandom(input.seed, candidate.gridX, candidate.gridZ, 0)) ? 1 : 0;
  }
  return Object.freeze({ ...planBase, hash: hashPlan(planBase) });
}

export function validateGrassFieldResidentSlots(slotCounts: readonly number[]): number {
  let total = 0;
  for (const count of slotCounts) {
    if (!Number.isSafeInteger(count) || count < 0 || count > GRASS_FIELD_MAX_SLOTS) throw new RangeError("resident grass field slot count is invalid");
    total += count;
    if (total > GRASS_FIELD_MAX_RESIDENT_SLOTS) throw new RangeError(`resident grass field slots exceed ${GRASS_FIELD_MAX_RESIDENT_SLOTS}`);
  }
  return total;
}
