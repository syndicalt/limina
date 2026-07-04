// ---------------------------------------------------------------------------
// village-geometry — the PURE, shared authoring of the settlement GROUND: the
// winding rammed-earth LANE threaded through the placed buildings, and the
// terrain-conforming GROUND PADS (earth aprons + the focal cobbled courtyard)
// under them.
//
//   const lane = buildLaneGeometry(heightAt, placed);              // → {positions,uvs,indices} | null
//   const pad  = buildGroundPadGeometry(heightAt, x, z, r, lift);  // → {positions,uvs,indices}
//
// Like village-layout.mjs, this is a SHARED BRAIN both consumers run so there is
// ONE algorithm and no drift:
//   • tools/preview/assets/village.mjs (preview) wraps these buffers into THREE
//     BufferGeometry + Mesh with its procedural earth/cobble materials.
//   • js/src/skills/village.ts (engine skill) wraps the SAME buffers into meshes
//     and spawns them as recorded entities (like terrain.create).
//
// NO THREE, NO DOM, NO scene coupling — just arithmetic over a `heightAt(x,z)`
// sampler + placement data, returning flat geometry buffers the caller wraps in
// its own renderer's BufferGeometry. The centripetal Catmull-Rom below is ported
// VERBATIM from three's CatmullRomCurve3 (getPoint/getTangent, curveType
// "centripetal", open) so the lane is byte-identical to the preview's prior
// THREE-authored ribbon.
//
// DETERMINISTIC: pure math, no Math.random / Date. The same (terrain, placements)
// always yield the same ground geometry.
// ---------------------------------------------------------------------------

// ---- centripetal Catmull-Rom (ported verbatim from three CatmullRomCurve3) ----
// A cubic-poly segment with non-uniform (centripetal) tangents. The arithmetic
// mirrors three's CubicPoly so the sampled curve matches the preview exactly.
function cubicPoly() {
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
  const init = (x0, x1, t0, t1) => {
    c0 = x0;
    c1 = t0;
    c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
    c3 = 2 * x0 - 2 * x1 + t0 + t1;
  };
  return {
    initNonuniform(x0, x1, x2, x3, dt0, dt1, dt2) {
      let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
      let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
      t1 *= dt1;
      t2 *= dt1;
      init(x1, x2, t1, t2);
    },
    calc(t) {
      const t2 = t * t, t3 = t2 * t;
      return c0 + c1 * t + c2 * t2 + c3 * t3;
    },
  };
}

const distSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
// three's endpoint extrapolation: p0 = points[0] - points[1] + points[0].
const extrapolate = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y, z: 2 * a.z - b.z });

// Evaluate an OPEN centripetal Catmull-Rom over `points` at parameter t∈[0,1].
function curvePoint(points, t) {
  const l = points.length;
  const p = (l - 1) * t;
  let intPoint = Math.floor(p);
  let weight = p - intPoint;
  if (weight === 0 && intPoint === l - 1) { intPoint = l - 2; weight = 1; }

  const p1 = points[intPoint];
  const p2 = points[intPoint + 1];
  const p0 = intPoint > 0 ? points[intPoint - 1] : extrapolate(points[0], points[1]);
  const p3 = intPoint + 2 < l ? points[intPoint + 2] : extrapolate(points[l - 1], points[l - 2]);

  const pow = 0.25; // centripetal
  let dt0 = Math.pow(distSq(p0, p1), pow);
  let dt1 = Math.pow(distSq(p1, p2), pow);
  let dt2 = Math.pow(distSq(p2, p3), pow);
  if (dt1 < 1e-4) dt1 = 1.0;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;

  const px = cubicPoly(), py = cubicPoly(), pz = cubicPoly();
  px.initNonuniform(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
  py.initNonuniform(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
  pz.initNonuniform(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
  return { x: px.calc(weight), y: py.calc(weight), z: pz.calc(weight) };
}

// three Curve.getTangent: central finite difference (delta 0.0001), normalized.
function curveTangent(points, t) {
  const delta = 0.0001;
  let t1 = t - delta, t2 = t + delta;
  if (t1 < 0) t1 = 0;
  if (t2 > 1) t2 = 1;
  const a = curvePoint(points, t1);
  const b = curvePoint(points, t2);
  let vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const inv = 1 / (len || 1); // three normalize = divideScalar(length()||1)
  return { x: vx * inv, y: vy * inv, z: vz * inv };
}

// Nearest-neighbour chain: focal (placed[0]) first, then always hop to the nearest
// unvisited building — the SAME order village-layout.mjs's chainFrom threads, so the
// lane brushes past the doors the buildings are planned to face.
function chainFrom(placed) {
  const chain = [placed[0]];
  const rest = placed.slice(1);
  while (rest.length) {
    const cur = chain[chain.length - 1];
    let bi = 0, bd = Infinity;
    rest.forEach((p, i) => {
      const d = Math.hypot(p.x - cur.x, p.z - cur.z);
      if (d < bd) { bd = d; bi = i; }
    });
    chain.push(rest.splice(bi, 1)[0]);
  }
  return chain;
}

// ------------------------------------------------------------------- the lane
// Centerline of the winding rammed-earth lane: the door-brushing waypoints (`pts`) and the
// densely-sampled centripetal Catmull-Rom curve (`samples`, world {x,y,z} on the terrain).
// Factored out of buildLaneGeometry so BOTH the ribbon mesh AND the footprint-exclusion
// carve-out (village.build) read the SAME centerline — one algorithm, no drift. Returns null
// for fewer than 2 buildings (no lane).
export function laneCenterline(heightAt, placed) {
  if (placed.length < 2) return null;

  const chain = chainFrom(placed);

  // Waypoints sit just OUTSIDE each footprint, nudged toward the neighbours, so the
  // lane brushes past doors instead of tunnelling through walls.
  const pts = chain.map((p, i) => {
    const prev = chain[Math.max(0, i - 1)];
    const next = chain[Math.min(chain.length - 1, i + 1)];
    let mx = (prev.x + next.x) / 2 - p.x;
    let mz = (prev.z + next.z) / 2 - p.z;
    if (mx * mx + mz * mz < 1e-6) { mx = 1; mz = 0; }
    const len = Math.sqrt(mx * mx + mz * mz);
    const inv = 1 / (len || 1);
    mx *= inv; mz *= inv;         // normalize
    mx *= p.r + 2.5; mz *= p.r + 2.5; // then scale (two steps, matching three's op order)
    const x = p.x + mx, z = p.z + mz;
    return { x, y: heightAt(x, z), z };
  });

  const n = Math.max(64, pts.length * 24);
  const samples = [];
  for (let i = 0; i <= n; i++) samples.push(curvePoint(pts, i / n));
  return { pts, samples, n };
}

// Winding rammed-earth ribbon conforming to the terrain, threaded through the
// nearest-neighbour chain of the placed buildings starting at the focal. `placed`
// is [{ x, z, r }] (focal first). Returns flat {positions,uvs,indices} (or null if
// fewer than 2 buildings). Consumers wrap it + call computeVertexNormals().
export function buildLaneGeometry(heightAt, placed) {
  const centerline = laneCenterline(heightAt, placed);
  if (centerline === null) return null;
  const { pts, samples, n } = centerline;

  // Ribbon: two vertices per sample, each re-seated on the terrain. UVs run in metres
  // (u across, v along the arc) to match the earth texture tiling.
  const halfW = 1.4;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx = [];
  let arc = 0;
  for (let i = 0; i <= n; i++) {
    const pp = samples[i];
    if (i > 0) {
      const q = samples[i - 1];
      arc += Math.sqrt((pp.x - q.x) ** 2 + (pp.y - q.y) ** 2 + (pp.z - q.z) ** 2);
    }
    let t = curveTangent(pts, i / n);
    // flatten to XZ + renormalize (matching the preview's t.y=0; t.normalize())
    let ty0 = 0;
    if (t.x * t.x + t.z * t.z < 1e-6) { t = { x: 0, y: 0, z: 1 }; ty0 = 0; }
    else {
      const l = Math.sqrt(t.x * t.x + ty0 * ty0 + t.z * t.z);
      const inv = 1 / (l || 1);
      t = { x: t.x * inv, y: 0, z: t.z * inv };
    }
    // side = cross(up(0,1,0), t) * halfW = (t.z, 0, -t.x) * halfW
    const sideX = t.z * halfW, sideZ = -t.x * halfW;
    for (const s of [1, -1]) {
      const x = pp.x + sideX * s, z = pp.z + sideZ * s;
      const o = (i * 2 + (s > 0 ? 0 : 1)) * 3;
      pos[o] = x;
      pos[o + 1] = heightAt(x, z) + 0.07; // float just above ground
      pos[o + 2] = z;
      const u = (i * 2 + (s > 0 ? 0 : 1)) * 2;
      uv[u] = s > 0 ? 0 : halfW * 2;
      uv[u + 1] = arc;
    }
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return { positions: pos, uvs: uv, indices: idx };
}

// -------------------------------------------------------------- ground pads
// Terrain-conforming disc of trodden ground under a building (or the courtyard/
// apron around the focal): a polar grid re-seated on the terrain, outer ring
// tucked slightly INTO the ground so the edge feathers away instead of floating.
// Returns flat {positions,uvs,indices}; consumers wrap it + computeVertexNormals().
export function buildGroundPadGeometry(heightAt, x0, z0, r, lift = 0.14) {
  const rings = Math.min(16, Math.max(6, Math.round(r / 1.8)));
  const seg = 36;
  const pos = [x0, heightAt(x0, z0) + lift, z0];
  const uv = [x0, z0];
  const idx = [];
  for (let i = 1; i <= rings; i++) {
    const rad = (r * i) / rings;
    const sink = i === rings ? -0.4 : lift; // feather the rim under the turf
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const x = x0 + Math.cos(a) * rad, z = z0 + Math.sin(a) * rad;
      pos.push(x, heightAt(x, z) + sink, z);
      uv.push(x, z); // metre-space UVs → matches the earth/cobble tiling
    }
  }
  const at = (ring, s) => 1 + (ring - 1) * seg + (((s % seg) + seg) % seg);
  for (let s = 0; s < seg; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let ring = 1; ring < rings; ring++) {
    for (let s = 0; s < seg; s++) {
      idx.push(at(ring, s), at(ring, s + 1), at(ring + 1, s));
      idx.push(at(ring, s + 1), at(ring + 1, s + 1), at(ring + 1, s));
    }
  }
  return { positions: pos, uvs: uv, indices: idx };
}
