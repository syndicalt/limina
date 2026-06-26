// Phase 9.1 / workstream B — prop GEOMETRY. PURE math, no THREE, no DOM (mirrors
// mesh.ts): `propGeometry(kind)` turns a `PropKind` into flat typed arrays
// (positions / indices / normals / colors) for a low-poly procedural prop. The THREE
// InstancedMesh wrapper lives in props-render.ts so this module stays importable in
// the headless runtime (no THREE/DOM). The per-instance world transform comes from
// `scatterProps` (scatter.ts) — this is just the unit-ish base shape that each
// instance's (translate, yaw, uniform-scale) places on the terrain surface.
//
// Geometry is FLAT-SHADED: every triangle owns 3 fresh vertices and carries its own
// face normal, so normals are guaranteed unit-length and indices are the trivial
// sequence 0,1,2,…. Per-part VERTEX COLORS (brown trunk + green canopy, grey rock,
// green grass) so one InstancedMesh per kind still shows multi-material props.
//
// OUTWARD NORMALS: every face winds CCW-as-seen-from-OUTSIDE so single-sided
// FrontSide materials light the visible face (an earlier inward-winding bug rendered
// cones/rocks BLACK). These props are AXIS-SYMMETRIC about +Y and built WITHOUT
// horizontal cap faces, so "outward" == "away from the central vertical axis":
//   n · (faceCentroid − (0, faceCentroidY, 0)) > 0  for every face.
// That invariant is asserted for all kinds in js/test/p9_props.ts.

import { PropKind } from "./scatter.ts";

/** Flat geometry buffers for a prop, ready to drop onto a THREE BufferGeometry. */
export interface PropGeometry {
  /** xyz per vertex, length = vertCount*3. */
  positions: Float32Array;
  /** Triangle indices (sequential for flat shading), length = triCount*3. */
  indices: Uint32Array;
  /** Per-vertex unit face normals, length = vertCount*3. */
  normals: Float32Array;
  /** Per-vertex RGB color, length = vertCount*3 (per-part: trunk/canopy/rock/grass). */
  colors: Float32Array;
}

type RGB = readonly [number, number, number];

/** 0xRRGGBB -> normalized [r,g,b] in [0,1]. Pure. */
function hexRGB(hex: number): RGB {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

// Per-part colors (exactness is what the test pins).
const TRUNK = hexRGB(0x5b4636); // brown
const FOLIAGE = hexRGB(0x2f6d39); // green
const ROCKCOL = hexRGB(0x6f6f6a); // grey
const GRASSCOL = hexRGB(0x4f8a3f); // green

/** Mutable triangle-soup accumulator (flat shading: one face normal per triangle). */
interface Soup {
  pos: number[];
  nrm: number[];
  col: number[];
}

/** Push one triangle (a,b,c CCW from outside) with its unit face normal + a color. */
function addTri(
  s: Soup, color: RGB,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): void {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  s.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  s.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  const [r, g, b] = color;
  s.col.push(r, g, b, r, g, b, r, g, b);
}

/** Push a quad (a,b,c,d CCW from outside) as two triangles. */
function addQuad(
  s: Soup, color: RGB,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  addTri(s, color, ax, ay, az, bx, by, bz, cx, cy, cz);
  addTri(s, color, ax, ay, az, cx, cy, cz, dx, dy, dz);
}

/** Open box (4 SIDE faces, no top/bottom cap) centered (cx,cy,cz), half (hx,hy,hz). */
function addBoxSides(s: Soup, color: RGB, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
  const x0 = cx - hx, x1 = cx + hx;
  const y0 = cy - hy, y1 = cy + hy;
  const z0 = cz - hz, z1 = cz + hz;
  addQuad(s, color, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +Z
  addQuad(s, color, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // -Z
  addQuad(s, color, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +X
  addQuad(s, color, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // -X
}

/**
 * OPEN cone (`sides` side faces only, no base cap): a `sides`-gon ring at `baseY`,
 * radius `radius`, apex at `topY`. Wound CCW-from-outside -> outward (radial) normals.
 */
function addOpenCone(s: Soup, color: RGB, baseY: number, topY: number, radius: number, sides: number): void {
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([Math.cos(a) * radius, Math.sin(a) * radius]); // (x, z)
  }
  for (let i = 0; i < sides; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % sides];
    // (apex, ring[i+1], ring[i]) winds CCW from outside -> normal points radially out.
    addTri(s, color, 0, topY, 0, x1, baseY, z1, x0, baseY, z0);
  }
}

// A tree: a thin open-tube trunk + 3 stacked open cone tiers (a little pine).
function treeSoup(): Soup {
  const s: Soup = { pos: [], nrm: [], col: [] };
  addBoxSides(s, TRUNK, 0, 0.3, 0, 0.07, 0.3, 0.07); // trunk: y in [0, 0.6]
  addOpenCone(s, FOLIAGE, 0.45, 1.10, 0.50, 6); // bottom tier (widest)
  addOpenCone(s, FOLIAGE, 0.90, 1.55, 0.38, 6); // middle tier
  addOpenCone(s, FOLIAGE, 1.35, 2.00, 0.26, 6); // top tier
  return s;
}

// A rock: a flattened faceted octahedron (wider than tall -> reads as a boulder, not a
// spike). 8 slanted triangular faces, all radially outward.
function rockSoup(): Soup {
  const s: Soup = { pos: [], nrm: [], col: [] };
  // Asymmetric, squat half-extents (deterministic constants).
  const px = 0.60, nx = 0.52, py = 0.30, ny = 0.22, pz = 0.56, nz = 0.54;
  const top: [number, number, number] = [0, py, 0];
  const bot: [number, number, number] = [0, -ny, 0];
  const eq: Array<[number, number, number]> = [
    [px, 0, 0], [0, 0, pz], [-nx, 0, 0], [0, 0, -nz],
  ];
  for (let i = 0; i < 4; i++) {
    const a = eq[i], b = eq[(i + 1) % 4];
    // Upper faces (apex above): CCW-from-outside == (top, b, a).
    addTri(s, ROCKCOL, top[0], top[1], top[2], b[0], b[1], b[2], a[0], a[1], a[2]);
    // Lower faces (apex below): CCW-from-outside == (bot, a, b).
    addTri(s, ROCKCOL, bot[0], bot[1], bot[2], a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  return s;
}

// Grass: a small clump of 4 short tapered blades, each rooted at y=0 and oriented to
// face radially OUTWARD (so its normal points away from the clump axis). Double-sided
// material covers the back; max height ~0.6 of the unit so it never towers.
function grassSoup(): Soup {
  const s: Soup = { pos: [], nrm: [], col: [] };
  const rb = 0.06; // base offset from the axis (keeps the blade off-axis)
  const lean = 0.09; // outward lean of the tip
  const wb = 0.08; // base width (tangential)
  const wt = 0.012; // tip width (tapered to a near-point)
  const heights = [0.55, 0.48, 0.60, 0.50];
  for (let k = 0; k < 4; k++) {
    const th = (k / 4) * Math.PI * 2 + 0.4; // spread around the clump
    const rx = Math.cos(th), rz = Math.sin(th); // radial (outward) dir
    const tx = -Math.sin(th), tz = Math.cos(th); // tangential dir
    const h = heights[k];
    const blx = rb * rx - (wb / 2) * tx, blz = rb * rz - (wb / 2) * tz;
    const brx = rb * rx + (wb / 2) * tx, brz = rb * rz + (wb / 2) * tz;
    const tcx = (rb + lean) * rx, tcz = (rb + lean) * rz;
    const tlx = tcx - (wt / 2) * tx, tlz = tcz - (wt / 2) * tz;
    const trx = tcx + (wt / 2) * tx, trz = tcz + (wt / 2) * tz;
    // CCW from the OUTSIDE (+radial) so the front normal points radially out.
    addQuad(s, GRASSCOL, blx, 0, blz, tlx, h, tlz, trx, h, trz, brx, 0, brz);
  }
  return s;
}

function soupToGeometry(s: Soup): PropGeometry {
  const positions = new Float32Array(s.pos);
  const normals = new Float32Array(s.nrm);
  const colors = new Float32Array(s.col);
  const vertCount = positions.length / 3;
  const indices = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) indices[i] = i;
  return { positions, indices, normals, colors };
}

/**
 * Low-poly procedural geometry for a prop kind. Pure + deterministic: identical
 * `kind` → byte-identical buffers. Unit-ish base size; `PropInstance.scale` scales it.
 */
export function propGeometry(kind: number): PropGeometry {
  switch (kind) {
    case PropKind.Tree: return soupToGeometry(treeSoup());
    case PropKind.Rock: return soupToGeometry(rockSoup());
    case PropKind.Grass: return soupToGeometry(grassSoup());
    default: throw new Error(`propGeometry: unknown PropKind ${kind}`);
  }
}
