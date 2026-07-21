// Terrain brush kernel — THE single copy of the sculpt falloff/hash/lattice math.
// Consumers: the EditableTerrain path (skills/terrain-edit.ts applyBrush), the
// derived-lattice materializer (skills/terrain-edit.ts materializeTerrainBrushOp —
// a thin topology/coded-error shell over materializeLatticeBrushDeltas), and the
// editor's optimistic sculpt preview (editor/src/sculpt-preview.js, served the same
// functions through the vendor bundle export terrainBrushKernel). Forking this math
// breaks the preview==revision byte-identity the derived path relies on.
// Pure + deterministic: no Math.random, no transcendentals in hashNoise, so recorded
// dabs replay byte-identically across hosts.

/** t is 1 at the brush center, 0 at the rim. */
export function falloffWeight(kind, t) {
  if (kind === "constant") return 1;
  if (kind === "linear") return t;
  return t * t * (3 - 2 * t); // smoothstep
}

/** Deterministic value noise from integer grid coords — no Math.random/transcendentals,
 *  so a noise deform replays byte-identically across runs and platforms. */
export function hashNoise(col, row) {
  let h = (Math.imul(col, 374761393) + Math.imul(row, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Brush weight at one world-space sample; 0 outside the radius. The rim-inclusive
 *  `d2 > r2` test and the t-from-distance expression must stay bit-identical across
 *  every consumer (engine materializer AND editor preview), so both call THIS. */
export function brushWeightAt(kind, wx, wz, cx, cz, r) {
  const dx = wx - cx, dz = wz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return 0;
  const t = 1 - Math.sqrt(d2) / r;
  return falloffWeight(kind, t);
}

/** Port of the EditableTerrain brush stamp onto the global LOD0 sample lattice of a
 *  derived-terrain base topology: same weights, same arithmetic, expressed as sparse
 *  additive metre deltas (the durable edit-layer artifact — brush params are never
 *  replayed). `lattice` is terrainEditLatticeGeometry(baseTopology) (edit-layer.mjs).
 *  smooth/flatten read the CURRENT composed field through sampleHeightM (exact-base
 *  binding); noise keys the domain-relative lattice index, matching a brush stamp on
 *  a domain-spanning tile. Callers that need a coded error for a missing sampler
 *  (skill boundary) must check BEFORE calling — this throws a plain Error. */
export function materializeLatticeBrushDeltas(lattice, input, sampleHeightM) {
  const cols = lattice.maxGx - lattice.minGx; // last domain-relative column index
  const rows = lattice.maxGz - lattice.minGz;
  const x0 = lattice.minX, z0 = lattice.minZ;
  const step = lattice.stepM;
  const [cx, cz] = input.center;
  const r = input.radius;
  if ((input.mode === "smooth" || input.mode === "flatten") && sampleHeightM === undefined) {
    throw new Error(`terrain brush: ${input.mode} requires a composed-height sampler`);
  }
  // Enclosing-cell clamp, mirroring the EditableTerrain captureHeightPatch, so the
  // iteration rect covers exactly the samples the tile path can touch.
  const col0 = Math.min(cols, Math.max(0, Math.floor((cx - r - x0) / step)));
  const col1 = Math.max(0, Math.min(cols, Math.ceil((cx + r - x0) / step)));
  const row0 = Math.min(rows, Math.max(0, Math.floor((cz - r - z0) / step)));
  const row1 = Math.max(0, Math.min(rows, Math.ceil((cz + r - z0) / step)));
  const deltas = [];
  for (let row = row0; row <= row1; row++) {
    const wz = z0 + row * step;
    for (let col = col0; col <= col1; col++) {
      const wx = x0 + col * step;
      const f = brushWeightAt(input.falloff, wx, wz, cx, cz, r);
      // f === 0 covers both the out-of-radius skip and the zero-weight rim: every
      // mode's deltaM would be 0, and smooth/flatten must not sample out-of-radius.
      if (f === 0) continue;
      const gx = lattice.minGx + col, gz = lattice.minGz + row;
      let deltaM = 0;
      switch (input.mode) {
        case "raise": deltaM = input.delta * f; break;
        case "lower": deltaM = -(input.delta * f); break;
        case "flatten": deltaM = (input.delta - sampleHeightM(gx, gz)) * f; break;
        case "noise": deltaM = (hashNoise(col, row) * 2 - 1) * input.delta * f; break;
        case "smooth": {
          let sum = 0, cnt = 0;
          for (let rr = -1; rr <= 1; rr++) {
            const nr = row + rr; if (nr < 0 || nr > rows) continue;
            for (let cc = -1; cc <= 1; cc++) {
              const nc = col + cc; if (nc < 0 || nc > cols) continue;
              sum += sampleHeightM(lattice.minGx + nc, lattice.minGz + nr); cnt++;
            }
          }
          deltaM = (sum / cnt - sampleHeightM(gx, gz)) * f;
          break;
        }
        default: throw new Error(`terrain brush: unknown mode '${input.mode}'`);
      }
      if (deltaM === 0) continue; // the format rejects zero deltas; a zero weight is no edit
      deltas.push({ gx, gz, deltaM });
    }
  }
  return deltas;
}
