// W2 — DETERMINISTIC, SEAM-CONSISTENT EROSION for the procedural terrain.
//
// This is an OPT-IN authoring-time bake (off the frame loop): when a tile request
// carries an `erode` hint, generateTile builds the tile's raw heightfield over a
// larger APRON block, runs hydraulic + thermal erosion on the block, and slices the
// interior back out. With NO `erode` hint nothing here runs and the output is
// BYTE-IDENTICAL to the pre-erosion field.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS SEAM-CONSISTENT *AND* CACHE-SAFE (the hard part)
// ─────────────────────────────────────────────────────────────────────────────
// The tile cache is keyed by (seed, tx, tz, lod, hints) ALONE — never by region
// bounds — so an eroded tile MUST be a pure function of those inputs, identical no
// matter which region (or how big a region) requested it. A naive "erode the whole
// region as one grid" would make a tile depend on the region's extent and break that
// contract. Instead we erode PER TILE over a fixed apron that is a function of the
// tile coordinate only, and we make the simulation itself position-addressed:
//
//   1. GLOBAL GRID. Every cell has a global integer coordinate (gr, gc) on a single
//      world lattice shared by all tiles: gc = tx*(RES-1) + c, gr = tz*(RES-1) + r.
//      Adjacent tiles share an edge column/row, so they share the SAME (gr,gc) there.
//      The raw height at a cell, the droplet seeded "at" a cell, and that droplet's
//      RNG jitter are all functions of (seed, gr, gc) — never of block-local indices.
//      => Two overlapping blocks compute identical raw heights and identical droplets
//         on their shared cells.
//
//   2. BOUNDED INFLUENCE + APRON. A droplet lives at most `lifetime` steps (≤1 cell
//      each) and writes within `brush` cells; thermal erosion moves material ≤1 cell
//      per pass over `thermal` passes. So a cell's eroded value depends only on the
//      raw field within radius R = max(lifetime+brush, thermal) of it. We erode a
//      block padded by an apron P ≥ R on every side, so every INTERIOR (kept) cell —
//      including the shared edge cells — sees its full R-neighborhood inside the block.
//      A neighbour tile's block contains that same R-neighborhood (it overlaps by 2P),
//      computes the same droplets over the same raw field in the same global order, and
//      therefore produces an IDENTICAL eroded value on the shared edge. Seam-consistent
//      to floating-point, independent of region bounds.
//
//   3. DETERMINISTIC ORDER. Droplets are simulated in ascending GLOBAL (gr,gc) order
//      (not block-local), so the relative order of any two droplets is the same in
//      every block; droplets unique to one block's far apron touch only far cells and
//      cannot perturb the shared interior. Thermal erosion is Jacobi (read a snapshot,
//      write a buffer) so it is order-independent by construction. No Map iteration, no
//      Math.random, no transcendental ops — same build ⇒ byte-identical twice.
//
// The falsification of (2)/(3) is the test's "no-apron variant diverges" control:
// erode each tile with apron=0 and the shared edges no longer match.

import { hashLattice } from "./procedural.ts";

/** Decoded erosion recipe (from the numeric `erode*` hints). All knobs default to a
 *  balanced, valley-carving preset; only `erode>0` is required to switch it on. */
export interface ErosionParams {
  /** Droplets seeded per grid cell (hydraulic intensity). Fractional values seed an
   *  extra droplet on a deterministic per-cell hash threshold. */
  rain: number;
  /** Thermal-erosion passes (material slumps toward the talus angle each pass). */
  thermal: number;
  /** Thermal talus threshold: the max stable height difference (elevation units) between
   *  4-neighbour cells; steeper slopes slump. Smaller ⇒ flatter talus / more slumping. */
  talus: number;
  /** Max steps a droplet travels before it dies (also bounds the apron). */
  lifetime: number;
  /** Sediment-carrying capacity per unit (slope·speed·water). Higher ⇒ deeper channels. */
  capacity: number;
  /** Fraction of excess sediment dropped when over capacity / going uphill. */
  deposition: number;
  /** Fraction of the free capacity carved from the bed when under capacity. */
  erosionRate: number;
}

const DROPLET_INERTIA = 0.05;       // 0 = pure gradient flow, 1 = pure momentum
const MIN_SLOPE = 0.0005;           // floor on carrying capacity so flats still move a little
const GRAVITY = 4;                  // speed gained per unit of downhill drop
const EVAPORATION = 0.02;           // water lost per step
const EROSION_RADIUS = 2;           // brush radius (cells) the bed is carved over
const INITIAL_WATER = 1;
const INITIAL_SPEED = 1;

// Decorrelated salts so the erosion RNG never aligns with the elevation lattice.
const DROP_SALT = 0x7f4a7c15 | 0;
const JIT_X_SALT = 0x9e3779b9 | 0;
const JIT_Z_SALT = 0x6a09e667 | 0;
const EXTRA_SALT = 0xbf58476d | 0;

/** Default knobs (a moderate, clearly-drainage-forming bake). */
export const DEFAULT_EROSION: ErosionParams = {
  rain: 1,
  thermal: 12,
  talus: 0.012,
  lifetime: 18,
  capacity: 6,
  deposition: 0.3,
  erosionRate: 0.35,
};

function clampPos(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/** Decode the OPT-IN erosion hints. Returns undefined when erosion is OFF (no hints, or
 *  `erode` <= 0) so the caller keeps the byte-identical default path. */
export function parseErosion(hints: Record<string, number> | undefined): ErosionParams | undefined {
  if (hints === undefined || !(hints.erode > 0)) return undefined;
  // `erodeIterations` is a friendly single dial mapped onto thermal passes; explicit
  // per-knob hints override it. All clamped to keep the apron (hence bake cost) bounded.
  const iter = hints.erodeIterations;
  return {
    rain: clampPos(hints.erodeRain ?? DEFAULT_EROSION.rain, 0, 8),
    thermal: Math.round(clampPos(hints.erodeThermal ?? iter ?? DEFAULT_EROSION.thermal, 0, 40)),
    talus: Math.max(1e-6, hints.erodeTalus ?? DEFAULT_EROSION.talus),
    lifetime: Math.round(clampPos(hints.erodeLifetime ?? DEFAULT_EROSION.lifetime, 1, 40)),
    capacity: Math.max(0.01, hints.erodeCapacity ?? DEFAULT_EROSION.capacity),
    deposition: clampPos(hints.erodeDeposition ?? DEFAULT_EROSION.deposition, 0, 1),
    erosionRate: clampPos(hints.erodeRate ?? DEFAULT_EROSION.erosionRate, 0, 1),
  };
}

/** The apron (cells of neighbour terrain padded on every side) needed so every kept
 *  cell sees its full influence radius. A pure function of the params ⇒ a tile's apron
 *  (and thus its eroded value) is independent of region bounds. */
export function apronFor(p: ErosionParams): number {
  const hydraulic = p.lifetime + EROSION_RADIUS;
  const thermal = p.thermal;
  return Math.max(hydraulic, thermal) + 2; // +2 safety margin
}

// ── Hydraulic erosion (deterministic droplets) ───────────────────────────────

/** Run one droplet over the block grid, mutating `h` (carve/deposit). Start position is
 *  in block-local float coords; RNG is keyed on the GLOBAL cell so it is shared across
 *  blocks. `rows`/`cols` are the block dims. */
function simulateDroplet(
  h: Float32Array, rows: number, cols: number,
  startX: number, startZ: number, p: ErosionParams,
): void {
  let px = startX, pz = startZ;
  let dx = 0, dz = 0;
  let speed = INITIAL_SPEED;
  let water = INITIAL_WATER;
  let sediment = 0;

  for (let step = 0; step < p.lifetime; step++) {
    const cx = Math.floor(px);
    const cz = Math.floor(pz);
    if (cx < 0 || cz < 0 || cx >= cols - 1 || cz >= rows - 1) break;
    const fx = px - cx;
    const fz = pz - cz;

    // Bilinear height + gradient from the 4 corners of the current cell.
    const i00 = cz * cols + cx;
    const nw = h[i00];
    const ne = h[i00 + 1];
    const sw = h[i00 + cols];
    const se = h[i00 + cols + 1];
    const gradX = (ne - nw) * (1 - fz) + (se - sw) * fz;
    const gradZ = (sw - nw) * (1 - fx) + (se - ne) * fx;
    const oldH = nw * (1 - fx) * (1 - fz) + ne * fx * (1 - fz) + sw * (1 - fx) * fz + se * fx * fz;

    // New direction: blend momentum with the downhill gradient, then normalize.
    dx = dx * DROPLET_INERTIA - gradX * (1 - DROPLET_INERTIA);
    dz = dz * DROPLET_INERTIA - gradZ * (1 - DROPLET_INERTIA);
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len <= 1e-12) break; // sitting in a pit with no gradient and no momentum
    dx /= len;
    dz /= len;
    px += dx;
    pz += dz;

    // Height at the new position (bilinear); dh<0 means we flowed downhill.
    const ncx = Math.floor(px);
    const ncz = Math.floor(pz);
    if (ncx < 0 || ncz < 0 || ncx >= cols - 1 || ncz >= rows - 1) break;
    const nfx = px - ncx;
    const nfz = pz - ncz;
    const j00 = ncz * cols + ncx;
    const newH = h[j00] * (1 - nfx) * (1 - nfz) + h[j00 + 1] * nfx * (1 - nfz)
      + h[j00 + cols] * (1 - nfx) * nfz + h[j00 + cols + 1] * nfx * nfz;
    const dh = newH - oldH;

    const capacity = Math.max(-dh, MIN_SLOPE) * speed * water * p.capacity;

    if (dh > 0 || sediment > capacity) {
      // Deposit: fill the pit we climbed into, or shed excess load. Drops onto the 4
      // corners of the OLD cell bilinearly (so it lands where the water actually is).
      const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * p.deposition;
      sediment -= drop;
      h[i00] += drop * (1 - fx) * (1 - fz);
      h[i00 + 1] += drop * fx * (1 - fz);
      h[i00 + cols] += drop * (1 - fx) * fz;
      h[i00 + cols + 1] += drop * fx * fz;
    } else {
      // Erode: carve up to the free capacity, but never more than the drop ahead (so we
      // don't dig below the next cell and invert the slope). Spread over a brush.
      const carve = Math.min((capacity - sediment) * p.erosionRate, -dh);
      depositBrush(h, rows, cols, cx, cz, fx, fz, -carve);
      sediment += carve;
    }

    speed = Math.sqrt(Math.max(0, speed * speed + dh * -GRAVITY));
    water *= 1 - EVAPORATION;
    if (water <= 1e-4) break;
  }
}

/** Add `amount` (negative = carve) to the bed over a radial brush centred near
 *  (cx+fx, cz+fz), weighted by (1 - dist/radius) and normalized to conserve `amount`. */
function depositBrush(
  h: Float32Array, rows: number, cols: number,
  cx: number, cz: number, fx: number, fz: number, amount: number,
): void {
  const ox = cx + fx;
  const oz = cz + fz;
  let wsum = 0;
  for (let rz = -EROSION_RADIUS; rz <= EROSION_RADIUS; rz++) {
    for (let rx = -EROSION_RADIUS; rx <= EROSION_RADIUS; rx++) {
      const bx = cx + rx, bz = cz + rz;
      if (bx < 0 || bz < 0 || bx >= cols || bz >= rows) continue;
      const ddx = bx - ox, ddz = bz - oz;
      const dist = Math.sqrt(ddx * ddx + ddz * ddz);
      if (dist >= EROSION_RADIUS) continue;
      wsum += EROSION_RADIUS - dist;
    }
  }
  if (wsum <= 0) return;
  for (let rz = -EROSION_RADIUS; rz <= EROSION_RADIUS; rz++) {
    for (let rx = -EROSION_RADIUS; rx <= EROSION_RADIUS; rx++) {
      const bx = cx + rx, bz = cz + rz;
      if (bx < 0 || bz < 0 || bx >= cols || bz >= rows) continue;
      const ddx = bx - ox, ddz = bz - oz;
      const dist = Math.sqrt(ddx * ddx + ddz * ddz);
      if (dist >= EROSION_RADIUS) continue;
      h[bz * cols + bx] += amount * (EROSION_RADIUS - dist) / wsum;
    }
  }
}

// ── Thermal erosion (Jacobi slump to the talus angle) ────────────────────────

/** One Jacobi pass: each cell sheds material to its lower 4-neighbours when the slope
 *  exceeds `talus`. Reads `src`, writes `dst` (order-independent ⇒ deterministic). */
function thermalPass(src: Float32Array, dst: Float32Array, rows: number, cols: number, talus: number): void {
  dst.set(src);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      const hc = src[i];
      let totalExcess = 0;
      // 4-neighbour slopes over the talus get half the excess moved downhill.
      let d0 = 0, d1 = 0, d2 = 0, d3 = 0;
      if (x > 0)        { const d = hc - src[i - 1];    if (d > talus) { d0 = d - talus; totalExcess += d0; } }
      if (x < cols - 1) { const d = hc - src[i + 1];    if (d > talus) { d1 = d - talus; totalExcess += d1; } }
      if (z > 0)        { const d = hc - src[i - cols]; if (d > talus) { d2 = d - talus; totalExcess += d2; } }
      if (z < rows - 1) { const d = hc - src[i + cols]; if (d > talus) { d3 = d - talus; totalExcess += d3; } }
      if (totalExcess <= 0) continue;
      // Move half the largest single excess, apportioned by each neighbour's share, so
      // the system relaxes toward the talus angle without overshooting/oscillating.
      const move = 0.5 * Math.max(d0, d1, d2, d3);
      const scale = move / totalExcess;
      dst[i] -= move;
      if (d0 > 0) dst[i - 1] += d0 * scale;
      if (d1 > 0) dst[i + 1] += d1 * scale;
      if (d2 > 0) dst[i - cols] += d2 * scale;
      if (d3 > 0) dst[i + cols] += d3 * scale;
    }
  }
}

/**
 * Erode a raw heightfield BLOCK in place-ish (returns a new array). `rows`/`cols` are the
 * full block dims (interior + 2*apron). (gr0, gc0) is the GLOBAL cell coordinate of block
 * cell (0,0) — this is what ties the simulation to world position so neighbouring blocks
 * agree on their overlap. Pure + deterministic for a given (block, gr0, gc0, seed, params).
 */
export function erodeBlock(
  raw: Float32Array, rows: number, cols: number,
  gr0: number, gc0: number, seed: number, p: ErosionParams,
): Float32Array {
  const h = new Float32Array(raw); // never mutate the caller's raw field

  // Hydraulic: seed droplets per cell in ascending GLOBAL order (gr outer, gc inner) so
  // the simulation order is identical across blocks. Skip the outermost ring (a droplet
  // there has no full cell to flow into).
  if (p.rain > 0) {
    const whole = Math.floor(p.rain);
    const frac = p.rain - whole;
    for (let r = 0; r < rows; r++) {
      const gr = gr0 + r;
      for (let c = 0; c < cols; c++) {
        const gc = gc0 + c;
        const count = whole + (frac > 0 && hashLattice((seed ^ EXTRA_SALT) | 0, gc, gr) < frac ? 1 : 0);
        for (let d = 0; d < count; d++) {
          // Per-droplet jitter within the cell, keyed on the global cell + droplet index.
          const salt = (DROP_SALT + Math.imul(d, 0x9e3779b1)) | 0;
          const jx = hashLattice((salt ^ JIT_X_SALT) | 0, gc, gr);
          const jz = hashLattice((salt ^ JIT_Z_SALT) | 0, gc, gr);
          simulateDroplet(h, rows, cols, c + jx, r + jz, p);
        }
      }
    }
  }

  // Thermal: Jacobi passes (double-buffered) so steep faces slump to the talus angle.
  if (p.thermal > 0) {
    let a = h;
    let b = new Float32Array(h.length);
    for (let i = 0; i < p.thermal; i++) {
      thermalPass(a, b, rows, cols, p.talus);
      const t = a; a = b; b = t;
    }
    if (a !== h) h.set(a); // ensure the result lives in `h`
  }

  return h;
}

// ── Drainage metric (D8 flow accumulation) — the falsifiable "it carved" probe ──

/**
 * D8 flow accumulation: route one unit of rain from every cell down its steepest descent
 * until it leaves the grid, summing the through-flow at each cell. A diffuse (un-eroded)
 * field spreads flow thinly; an eroded field concentrates it into channels, so the PEAK
 * (and high-percentile) accumulation rises sharply — a physical, falsifiable signature of
 * a drainage network. Deterministic: cells are processed high-to-low with index as a
 * stable tiebreak. Returns per-cell accumulation (unit = number of upstream cells + self).
 */
export function flowAccumulation(h: Float32Array, rows: number, cols: number): Float32Array {
  const n = rows * cols;
  const order = new Array<number>(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Descending height; stable index tiebreak ⇒ fully deterministic ordering.
  order.sort((a, b) => (h[b] - h[a]) || (a - b));

  const acc = new Float32Array(n);
  acc.fill(1);
  const NB = [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const z = (i / cols) | 0;
    const x = i - z * cols;
    let best = -1;
    let bestDrop = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : d === 4 || d === 6 ? -1 : d === 5 || d === 7 ? 1 : 0);
      const nz = z + (d === 2 ? -1 : d === 3 ? 1 : d < 2 ? 0 : d < 6 ? -1 : 1);
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const j = i + NB[d];
      const drop = h[i] - h[j];
      if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return acc;
}
