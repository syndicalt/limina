// marching-squares.mjs — mask -> coastline polygons (Map Painter P1). PURE and dependency-free:
// the design-space frontend (live coast display, served via /shared/), the pure compiler
// (landmass mask -> WorldMap land[]), and the gate all import this one module, so the coast the
// user sees while painting IS the coast the world builds from.
//
// Contract: the mask is a u8 grid (row 0 = north, row-major — the reliefGrid convention) whose
// rect maps cell CENTERS to world meters exactly like reliefGridSampler: cell c spans
// x0 + (c/(w-1))*rect.w. Land = value >= threshold. The grid is virtually padded with one ring
// of ocean, so land painted to the rect edge closes into a coast at the edge (island-first
// authoring; landlocked interiors arrive with the P4 importer).
//
// Output: OUTER loops only (land boundaries; holes/lakes are dropped in P1 — water tools own
// them later), Chaikin-smoothed and decimated so a 512² coast stays a few hundred vertices —
// downstream rasterizer coast-distance queries are O(V) per sample, so V is a real cost.

/** Trace the land/ocean boundary loops of a padded binary field. Returns loops as arrays of
 *  [gx, gz] in PADDED-grid coordinates (0..w+1), each loop closed implicitly (last != first).
 *  Directed so that land is on the LEFT of travel: outer land loops wind one way, holes the
 *  other — the caller separates them by signed area. */
function traceLoops(w, h, land) {
  // Padded sample grid: (w+2) x (h+2), border = ocean.
  const W = w + 2, H = h + 2;
  const at = (gx, gz) => (gx >= 1 && gx <= w && gz >= 1 && gz <= h ? land[(gz - 1) * w + (gx - 1)] : 0);
  // For every 2x2 cell of the padded grid, emit directed segments (midpoint interpolation).
  // Segment endpoints are edge midpoints keyed by (edge orientation, position) so loops stitch
  // exactly. Case index: tl<<3 | tr<<2 | br<<1 | bl.
  const segs = new Map(); // startKey -> {sx, sz, ex, ez, used}
  const key = (x, z) => x * 4096 + z; // quantized: coordinates are k or k+0.5 → double to ints
  const K = (x, z) => key(Math.round(x * 2), Math.round(z * 2));
  const put = (sx, sz, ex, ez) => {
    const k = K(sx, sz);
    // Two segments can share a start point only at the ambiguous saddles, which we resolve
    // below to distinct corners — so a plain map is safe.
    segs.set(k, { sx, sz, ex, ez, used: false });
  };
  for (let cz = 0; cz < H - 1; cz++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const tl = at(cx, cz), tr = at(cx + 1, cz), br = at(cx + 1, cz + 1), bl = at(cx, cz + 1);
      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (idx === 0 || idx === 15) continue;
      const top = [cx + 0.5, cz], right = [cx + 1, cz + 0.5], bot = [cx + 0.5, cz + 1], left = [cx, cz + 0.5];
      // Directed segments with land on the left of travel.
      switch (idx) {
        case 1: put(bot[0], bot[1], left[0], left[1]); break;            // bl
        case 2: put(right[0], right[1], bot[0], bot[1]); break;          // br
        case 3: put(right[0], right[1], left[0], left[1]); break;        // bl+br
        case 4: put(top[0], top[1], right[0], right[1]); break;          // tr
        case 5: put(top[0], top[1], left[0], left[1]);                    // saddle tr+bl
                put(bot[0], bot[1], right[0], right[1]); break;
        case 6: put(top[0], top[1], bot[0], bot[1]); break;              // tr+br
        case 7: put(top[0], top[1], left[0], left[1]); break;            // all but tl
        case 8: put(left[0], left[1], top[0], top[1]); break;            // tl
        case 9: put(bot[0], bot[1], top[0], top[1]); break;              // tl+bl
        case 10: put(left[0], left[1], bot[0], bot[1]);                   // saddle tl+br
                 put(right[0], right[1], top[0], top[1]); break;
        case 11: put(right[0], right[1], top[0], top[1]); break;         // all but tr
        case 12: put(left[0], left[1], right[0], right[1]); break;       // tl+tr
        case 13: put(bot[0], bot[1], right[0], right[1]); break;         // all but br
        case 14: put(left[0], left[1], bot[0], bot[1]); break;           // all but bl
      }
    }
  }
  const loops = [];
  for (const seg of segs.values()) {
    if (seg.used) continue;
    const loop = [];
    let cur = seg;
    while (cur && !cur.used) {
      cur.used = true;
      loop.push([cur.sx, cur.sz]);
      cur = segs.get(K(cur.ex, cur.ez));
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/** One Chaikin corner-cutting pass on a closed loop. */
function chaikin(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    out.push([x1 * 0.75 + x2 * 0.25, z1 * 0.75 + z2 * 0.25]);
    out.push([x1 * 0.25 + x2 * 0.75, z1 * 0.25 + z2 * 0.75]);
  }
  return out;
}

/** Drop points closer than minDist to the last kept point (closed loop). */
function decimate(pts, minDist) {
  if (pts.length < 4) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [px, pz] = out[out.length - 1], [x, z] = pts[i];
    if (Math.hypot(x - px, z - pz) >= minDist) out.push(pts[i]);
  }
  return out;
}

/**
 * Landmass mask -> land polygons in WORLD coordinates (map units, same space as the mask rect).
 *
 * @param {{w:number,h:number,rect:{x0:number,z0:number,w:number,h:number},cells:Uint8Array|number[]}} mask
 * @param {{threshold?:number, smoothIters?:number, minAreaCells?:number, maxPoints?:number}} [opts]
 * @returns {Array<{points:[number,number][]}>} outer land loops, largest first
 */
export function maskToLandPolygons(mask, opts = {}) {
  const { w, h, rect } = mask;
  const threshold = opts.threshold ?? 128;
  const smoothIters = opts.smoothIters ?? 2;
  const minAreaCells = opts.minAreaCells ?? 4;
  const maxPoints = opts.maxPoints ?? 400;
  const land = new Uint8Array(w * h);
  for (let i = 0; i < land.length; i++) land[i] = mask.cells[i] >= threshold ? 1 : 0;
  const loops = traceLoops(w, h, land);
  const polys = [];
  for (const loop of loops) {
    const area = signedArea(loop);
    // With +z growing south (screen-down convention), land-on-left outer loops come out with
    // NEGATIVE shoelace area in grid coords; positive-area loops are holes (lakes) — dropped in P1.
    if (area >= 0 || Math.abs(area) < minAreaCells) continue;
    let pts = loop;
    for (let i = 0; i < smoothIters; i++) pts = chaikin(pts);
    // Decimate in grid units: start at ~0.6 cells and coarsen until the loop fits maxPoints.
    let minDist = 0.6;
    let dec = decimate(pts, minDist);
    while (dec.length > maxPoints) { minDist *= 1.5; dec = decimate(pts, minDist); }
    // Padded grid -> world: padded gx maps to cell (gx-1); cell centers span the rect.
    const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
    polys.push({
      points: dec.map(([gx, gz]) => [
        Math.round((rect.x0 + (gx - 1) * sx) * 100) / 100,
        Math.round((rect.z0 + (gz - 1) * sz) * 100) / 100,
      ]),
      areaCells: Math.abs(area),
    });
  }
  polys.sort((a, b) => b.areaCells - a.areaCells);
  return polys.map((p) => ({ points: p.points }));
}
