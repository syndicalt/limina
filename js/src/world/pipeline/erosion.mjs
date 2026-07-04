// Faithful browser port of limina's terrain erosion (js/src/terrain/erosion.ts): deterministic
// hydraulic droplets + thermal (Jacobi slump) + D8 flow accumulation. Pure math, no engine deps.
// Same field + params + seed → byte-identical result. Used by the TERRAIN pipeline stage to carve
// drainage channels/valleys ("1M years of water flow"), and by WATER to place rivers on the flow.

// hashLattice — from terrain/procedural.ts (verbatim).
export function hashLattice(seed, ix, iz) {
  let h = seed | 0;
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (iz | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DROPLET_INERTIA = 0.05, MIN_SLOPE = 0.0005, GRAVITY = 4, EVAPORATION = 0.02;
const EROSION_RADIUS = 2, INITIAL_WATER = 1, INITIAL_SPEED = 1;
const DROP_SALT = 0x7f4a7c15 | 0, JIT_X_SALT = 0x9e3779b9 | 0, JIT_Z_SALT = 0x6a09e667 | 0, EXTRA_SALT = 0xbf58476d | 0;

export const DEFAULT_EROSION = { rain: 1, thermal: 12, talus: 0.012, lifetime: 18, capacity: 6, deposition: 0.3, erosionRate: 0.35 };

function depositBrush(h, rows, cols, cx, cz, fx, fz, amount) {
  const ox = cx + fx, oz = cz + fz;
  let wsum = 0;
  for (let rz = -EROSION_RADIUS; rz <= EROSION_RADIUS; rz++) for (let rx = -EROSION_RADIUS; rx <= EROSION_RADIUS; rx++) {
    const bx = cx + rx, bz = cz + rz; if (bx < 0 || bz < 0 || bx >= cols || bz >= rows) continue;
    const dist = Math.hypot(bx - ox, bz - oz); if (dist >= EROSION_RADIUS) continue; wsum += EROSION_RADIUS - dist;
  }
  if (wsum <= 0) return;
  for (let rz = -EROSION_RADIUS; rz <= EROSION_RADIUS; rz++) for (let rx = -EROSION_RADIUS; rx <= EROSION_RADIUS; rx++) {
    const bx = cx + rx, bz = cz + rz; if (bx < 0 || bz < 0 || bx >= cols || bz >= rows) continue;
    const dist = Math.hypot(bx - ox, bz - oz); if (dist >= EROSION_RADIUS) continue;
    h[bz * cols + bx] += amount * (EROSION_RADIUS - dist) / wsum;
  }
}

function simulateDroplet(h, rows, cols, startX, startZ, p) {
  let px = startX, pz = startZ, dx = 0, dz = 0, speed = INITIAL_SPEED, water = INITIAL_WATER, sediment = 0;
  for (let step = 0; step < p.lifetime; step++) {
    const cx = Math.floor(px), cz = Math.floor(pz);
    if (cx < 0 || cz < 0 || cx >= cols - 1 || cz >= rows - 1) break;
    const fx = px - cx, fz = pz - cz, i00 = cz * cols + cx;
    const nw = h[i00], ne = h[i00 + 1], sw = h[i00 + cols], se = h[i00 + cols + 1];
    const gradX = (ne - nw) * (1 - fz) + (se - sw) * fz, gradZ = (sw - nw) * (1 - fx) + (se - ne) * fx;
    const oldH = nw * (1 - fx) * (1 - fz) + ne * fx * (1 - fz) + sw * (1 - fx) * fz + se * fx * fz;
    dx = dx * DROPLET_INERTIA - gradX * (1 - DROPLET_INERTIA);
    dz = dz * DROPLET_INERTIA - gradZ * (1 - DROPLET_INERTIA);
    const len = Math.hypot(dx, dz); if (len <= 1e-12) break; dx /= len; dz /= len; px += dx; pz += dz;
    const ncx = Math.floor(px), ncz = Math.floor(pz);
    if (ncx < 0 || ncz < 0 || ncx >= cols - 1 || ncz >= rows - 1) break;
    const nfx = px - ncx, nfz = pz - ncz, j00 = ncz * cols + ncx;
    const newH = h[j00] * (1 - nfx) * (1 - nfz) + h[j00 + 1] * nfx * (1 - nfz) + h[j00 + cols] * (1 - nfx) * nfz + h[j00 + cols + 1] * nfx * nfz;
    const dh = newH - oldH, capacity = Math.max(-dh, MIN_SLOPE) * speed * water * p.capacity;
    if (dh > 0 || sediment > capacity) {
      const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * p.deposition;
      sediment -= drop;
      h[i00] += drop * (1 - fx) * (1 - fz); h[i00 + 1] += drop * fx * (1 - fz);
      h[i00 + cols] += drop * (1 - fx) * fz; h[i00 + cols + 1] += drop * fx * fz;
    } else {
      const carve = Math.min((capacity - sediment) * p.erosionRate, -dh);
      depositBrush(h, rows, cols, cx, cz, fx, fz, -carve); sediment += carve;
    }
    speed = Math.sqrt(Math.max(0, speed * speed + dh * -GRAVITY)); water *= 1 - EVAPORATION; if (water <= 1e-4) break;
  }
}

function thermalPass(src, dst, rows, cols, talus) {
  dst.set(src);
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const i = z * cols + x, hc = src[i]; let totalExcess = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
    if (x > 0) { const d = hc - src[i - 1]; if (d > talus) { d0 = d - talus; totalExcess += d0; } }
    if (x < cols - 1) { const d = hc - src[i + 1]; if (d > talus) { d1 = d - talus; totalExcess += d1; } }
    if (z > 0) { const d = hc - src[i - cols]; if (d > talus) { d2 = d - talus; totalExcess += d2; } }
    if (z < rows - 1) { const d = hc - src[i + cols]; if (d > talus) { d3 = d - talus; totalExcess += d3; } }
    if (totalExcess <= 0) continue;
    const move = 0.5 * Math.max(d0, d1, d2, d3), scale = move / totalExcess;
    dst[i] -= move;
    if (d0 > 0) dst[i - 1] += d0 * scale; if (d1 > 0) dst[i + 1] += d1 * scale;
    if (d2 > 0) dst[i - cols] += d2 * scale; if (d3 > 0) dst[i + cols] += d3 * scale;
  }
}

/** Erode a heightfield grid in place-ish (returns a new array). Single-block (gr0=gc0=0). */
export function erodeBlock(raw, rows, cols, seed, p = DEFAULT_EROSION) {
  const h = new Float32Array(raw);
  if (p.rain > 0) {
    const whole = Math.floor(p.rain), frac = p.rain - whole;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const count = whole + (frac > 0 && hashLattice((seed ^ EXTRA_SALT) | 0, c, r) < frac ? 1 : 0);
      for (let d = 0; d < count; d++) {
        const salt = (DROP_SALT + Math.imul(d, 0x9e3779b1)) | 0;
        const jx = hashLattice((salt ^ JIT_X_SALT) | 0, c, r), jz = hashLattice((salt ^ JIT_Z_SALT) | 0, c, r);
        simulateDroplet(h, rows, cols, c + jx, r + jz, p);
      }
    }
  }
  if (p.thermal > 0) {
    let a = h, b = new Float32Array(h.length);
    for (let i = 0; i < p.thermal; i++) { thermalPass(a, b, rows, cols, p.talus); const t = a; a = b; b = t; }
    if (a !== h) h.set(a);
  }
  return h;
}

/** D8 flow accumulation → per-cell upstream count. High values = river channels. */
export function flowAccumulation(h, rows, cols) {
  const n = rows * cols, order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => (h[b] - h[a]) || (a - b));
  const acc = new Float32Array(n); acc.fill(1);
  const NB = [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1];
  for (let k = 0; k < n; k++) {
    const i = order[k], z = (i / cols) | 0, x = i - z * cols; let best = -1, bestDrop = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : d === 4 || d === 6 ? -1 : d === 5 || d === 7 ? 1 : 0);
      const nz = z + (d === 2 ? -1 : d === 3 ? 1 : d < 2 ? 0 : d < 6 ? -1 : 1);
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const j = i + NB[d], drop = h[i] - h[j]; if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return acc;
}
