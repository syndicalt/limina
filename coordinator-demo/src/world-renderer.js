// Live world renderer — a bright, sunny low-poly BEACH with glassy review markers.
// Driven by the world view-model (buildWorldModel): SOLID meshes for entities now
// in the world, translucent GHOST markers for held edits awaiting review. The sand
// reuses the Phase 9 terrain geometry (js/src/terrain/mesh.ts); the cottage, palms,
// and driftwood are authored here as low-poly models so the beach reads for real.
//
// The in-tab render is UAT (no GPU in CI). The view-model that feeds it — including
// the position-join that gives each entity its real kind/shape — is verified
// headlessly (js/test/p_coordinator_demo.ts); this module only paints it.

import * as THREE from "../../js/build/three.bundle.mjs";
import { terrainTileGeometry } from "../../js/src/terrain/mesh.ts";

// --- palette -------------------------------------------------------------
const SAND = 0xe9d3a0;
const SAND_WET = 0xcbb07c;
const SEA = 0x1fb4c6;
const FOAM = 0xeaf7f2;
const SKY_TOP = 0x8ecae6;
const SKY_HORIZON = 0xdff3fb;
// cottage
const C_WALL = 0xf1e7d3; // weathered cream
const C_ROOF = 0x55958b; // weathered teal
const C_DOOR = 0x6e4a2d;
const C_WIN = 0xbfe6f0;
const C_DECK = 0xcaa46b;
// palm
const PALM_TRUNK = 0xb1885a;
const PALM_FROND = 0x4aa05a;
const PALM_FROND2 = 0x3c8a4d;
const COCONUT = 0x5f4128;
// driftwood
const DRIFTWOOD = 0xab9d85;

const Std = THREE.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
const DS = THREE.DoubleSide;
const matSolid = (color, opts = {}) => new Std({ color, roughness: 0.8, metalness: 0.04, side: DS, ...opts });
const matGhost = (color) => new Std({ color, roughness: 0.6, metalness: 0.0, transparent: true, opacity: 0.42, side: DS });
/** A textured standard material — the canvas texture supplies colour, so tint white. */
const matTex = (tex, opts = {}) => new Std({ color: 0xffffff, map: tex, roughness: 0.82, metalness: 0.03, side: DS, ...opts });

/** A low-poly terrain tile mesh (heights -> typed arrays) centred at world origin. */
function tileGeometry(nrows, ncols, heights, size, originY) {
  const tile = { nrows, ncols, heights, origin: [0, originY, 0], scale: [size, 1, size] };
  const g = terrainTileGeometry(tile);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return geom;
}

/** A gable (pitched) roof as a triangular prism, ridge running along Z. */
function gableRoofGeometry(w, d, h) {
  const hw = w / 2, hd = d / 2;
  const A = [-hw, 0, hd], B = [hw, 0, hd], C = [0, h, hd]; // front gable
  const D = [-hw, 0, -hd], E = [hw, 0, -hd], F = [0, h, -hd]; // back gable
  const tris = [
    A, B, C, // front triangle
    E, D, F, // back triangle
    A, C, F, A, F, D, // left slope
    B, E, F, B, F, C, // right slope
  ];
  const pos = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) { pos[i * 3] = tris[i][0]; pos[i * 3 + 1] = tris[i][1]; pos[i * 3 + 2] = tris[i][2]; }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
}

// --- procedural textures -------------------------------------------------
// The N64/Dreamcast look leans on PROCEDURAL TEXTURES doing the heavy lifting.
// Each texture is rasterised ONCE into a 2D canvas and cached at module scope
// (render() rebuilds meshes, so we must never re-raster per frame/instance).
// Materials get rebuilt per render (cheap) but reference these cached textures;
// THREE.Material.dispose() does NOT dispose its maps, so the cache survives the
// _clear() sweep between paints.

const _texCache = Object.create(null);

/** Deterministic small PRNG so texture noise is stable across reloads. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Multiply a #rrggbb hex toward darker/lighter; returns an rgb() string. */
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${cl((n >> 16) & 255)},${cl((n >> 8) & 255)},${cl(n & 255)})`;
}

/** Build (or return cached) a CanvasTexture rastered by `draw(ctx, w, h)`. */
function makeTex(key, w, h, draw, repeat) {
  const hit = _texCache[key];
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  _texCache[key] = tex;
  return tex;
}

/** Weathered clapboard planks for the cottage walls. */
function plankTex() {
  return makeTex("plank", 256, 256, (ctx, w, h) => {
    const r = rng(7);
    ctx.fillStyle = "#efe4cf"; ctx.fillRect(0, 0, w, h);
    const rows = 9, rh = h / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * rh;
      ctx.fillStyle = shade("#e7dabd", 0.9 + r() * 0.16);
      ctx.fillRect(0, y, w, rh - 1);
      ctx.strokeStyle = "rgba(120,98,64,0.10)";
      for (let k = 0; k < 7; k++) {
        const yy = y + r() * rh;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy + (r() - 0.5) * 3); ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,251,238,0.30)"; ctx.fillRect(0, y, w, 1);          // top highlight
      ctx.fillStyle = "rgba(66,50,30,0.30)"; ctx.fillRect(0, y + rh - 2, w, 2);     // shadow reveal
    }
    ctx.strokeStyle = "rgba(80,60,38,0.16)";                                        // board seams
    for (let x = 32; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let i = 0; i < 5; i++) {                                                   // knots
      const kx = r() * w, ky = r() * h;
      ctx.strokeStyle = "rgba(90,68,42,0.5)"; ctx.beginPath();
      ctx.ellipse(kx, ky, 2 + r() * 3, 1 + r() * 2, 0, 0, 7); ctx.stroke();
    }
  }, [2, 2]);
}

/** Weathered teal shingles, brick-offset rows, for the cottage roof. */
function shingleTex() {
  return makeTex("shingle", 256, 256, (ctx, w, h) => {
    const r = rng(19);
    ctx.fillStyle = "#3f6f68"; ctx.fillRect(0, 0, w, h);
    const rows = 9, rh = h / rows, cols = 7, cw = w / cols;
    for (let i = 0; i < rows; i++) {
      const y = h - (i + 1) * rh;
      const off = (i % 2) * (cw / 2);
      for (let j = -1; j <= cols; j++) {
        const x = j * cw + off;
        ctx.fillStyle = shade("#55958b", 0.82 + r() * 0.3);
        ctx.fillRect(x + 1, y + 1, cw - 2, rh - 1);
        ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(x + 1, y + 1, cw - 2, 2);     // top catch-light
        ctx.fillStyle = "rgba(20,40,38,0.45)"; ctx.fillRect(x, y, cw, 2);                    // row shadow
        ctx.fillStyle = "rgba(20,40,38,0.35)"; ctx.fillRect(x, y, 1.5, rh);                  // tab gap
      }
    }
  }, [2, 2]);
}

/** Ringed/streaky palm bark. */
function barkTex() {
  return makeTex("bark", 128, 256, (ctx, w, h) => {
    const r = rng(31);
    ctx.fillStyle = "#9a6f44"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {                                                  // vertical fibre streaks
      const x = r() * w;
      ctx.strokeStyle = `rgba(${50 + r() * 40 | 0},${34 + r() * 30 | 0},20,0.18)`;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (r() - 0.5) * 6, h); ctx.stroke();
    }
    const rings = 6, rg = h / rings;
    for (let i = 0; i < rings; i++) {                                               // segment ring scars
      const y = i * rg + r() * 4;
      ctx.fillStyle = "rgba(58,38,20,0.55)"; ctx.fillRect(0, y, w, 4);
      ctx.fillStyle = "rgba(214,180,128,0.30)"; ctx.fillRect(0, y + 4, w, 2);
    }
  }, [2, 1]);
}

/** Green frond gradient: darker edges, a bright midrib, leaflet striations,
 *  lightening toward the tip (u→1). */
function frondTex() {
  return makeTex("frond", 64, 64, (ctx, w, h) => {
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#2c6531"); grd.addColorStop(0.5, "#5fae54"); grd.addColorStop(1, "#2c6531");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, w, h);
    const g2 = ctx.createLinearGradient(0, 0, w, 0);
    g2.addColorStop(0, "rgba(18,46,18,0.40)"); g2.addColorStop(1, "rgba(186,214,120,0.42)");
    ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(222,236,172,0.55)"; ctx.lineWidth = 2;                  // midrib
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.strokeStyle = "rgba(18,42,18,0.22)"; ctx.lineWidth = 1;                     // leaflet striations
    for (let i = 1; i < 16; i++) { const x = (i / 16) * w; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  });
}

/** Bleached driftwood: lengthwise grain, cracks, a couple of knots. */
function driftTex() {
  return makeTex("drift", 128, 256, (ctx, w, h) => {
    const r = rng(53);
    ctx.fillStyle = "#cabfa6"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {                                                  // lengthwise grain (along v)
      const x = r() * w;
      const a = 0.06 + r() * 0.14;
      ctx.strokeStyle = r() > 0.5 ? `rgba(150,138,112,${a})` : `rgba(232,225,206,${a})`;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + (r() - 0.5) * 10, h * 0.33, x + (r() - 0.5) * 10, h * 0.66, x + (r() - 0.5) * 8, h);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(96,86,66,0.55)"; ctx.lineWidth = 1.4;                   // checking cracks
    for (let i = 0; i < 5; i++) {
      const x = r() * w, y = r() * h, len = 30 + r() * 80;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 8, y + len); ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {                                                   // knots
      const kx = r() * w, ky = r() * h;
      ctx.strokeStyle = "rgba(110,98,74,0.6)";
      ctx.beginPath(); ctx.ellipse(kx, ky, 3 + r() * 3, 5 + r() * 4, 0, 0, 7); ctx.stroke();
    }
  }, [2, 1]);
}

/** Weathered red-brown brick, brick-offset rows, for the cottage chimney. */
function brickTex() {
  return makeTex("brick", 128, 128, (ctx, w, h) => {
    const r = rng(67);
    ctx.fillStyle = "#7d5a4a"; ctx.fillRect(0, 0, w, h); // mortar base
    const rows = 8, rh = h / rows, cols = 4, cw = w / cols;
    for (let i = 0; i < rows; i++) {
      const y = i * rh, off = (i % 2) * (cw / 2);
      for (let j = -1; j <= cols; j++) {
        const x = j * cw + off;
        ctx.fillStyle = shade("#b06a4e", 0.78 + r() * 0.34);
        ctx.fillRect(x + 1.5, y + 1.5, cw - 3, rh - 3);
        ctx.fillStyle = "rgba(255,230,210,0.10)"; ctx.fillRect(x + 1.5, y + 1.5, cw - 3, 1.5); // catch-light
        ctx.fillStyle = "rgba(40,22,16,0.22)"; ctx.fillRect(x + 1.5, y + rh - 3, cw - 3, 1.5); // shadow
      }
    }
  }, [1, 1]);
}

// --- procedural frond geometry -------------------------------------------
// A real frond silhouette (NOT a flat blade): a tapered central rachis ribbon
// that droops over its length, lined with serrated leaflets that sweep toward
// the tip and lift into a shallow V for volume. Built once for a unit-length
// frond; we cache the typed-array math and re-wrap it in fresh BufferAttributes
// per geometry so _clear()'s dispose() never strands a shared GPU buffer.

let _frondArr = null;
function frondArrays() {
  if (_frondArr) return _frondArr;
  const STATIONS = 13, DROOP = 0.5, spineHalf0 = 0.013;
  const pos = [], uv = [], idx = [];
  let vi = 0;
  const sp = [];
  for (let i = 0; i <= STATIONS; i++) { const t = i / STATIONS; sp.push([t, -DROOP * t * t, 0]); }
  // central rachis ribbon
  for (let i = 0; i < STATIONS; i++) {
    const t0 = i / STATIONS, t1 = (i + 1) / STATIONS;
    const hw0 = spineHalf0 * (1 - t0 * 0.85), hw1 = spineHalf0 * (1 - t1 * 0.85);
    const a = sp[i], b = sp[i + 1];
    pos.push(a[0], a[1], a[2] + hw0, a[0], a[1], a[2] - hw0, b[0], b[1], b[2] + hw1,
             a[0], a[1], a[2] - hw0, b[0], b[1], b[2] - hw1, b[0], b[1], b[2] + hw1);
    uv.push(t0, 0.5, t0, 0.5, t1, 0.5, t0, 0.5, t1, 0.5, t1, 0.5);
    idx.push(vi, vi + 1, vi + 2, vi + 3, vi + 4, vi + 5); vi += 6;
  }
  // serrated leaflets (both sides of each station)
  for (let i = 1; i <= STATIONS; i++) {
    const t = i / STATIONS, P = sp[i];
    const L = 0.17 * Math.pow(Math.sin(Math.PI * t), 0.6) + 0.02;
    const sweep = L * 0.5, lift = L * 0.35, rootHalf = 0.02 * (1 - t * 0.7);
    for (const side of [1, -1]) {
      pos.push(P[0] - rootHalf, P[1], P[2], P[0] + rootHalf, P[1], P[2], P[0] - sweep, P[1] + lift, P[2] + side * L);
      uv.push(t, 0.5, t, 0.5, t, side > 0 ? 0.04 : 0.96);
      idx.push(vi, vi + 1, vi + 2); vi += 3;
    }
  }
  _frondArr = {
    position: new Float32Array(pos),
    uv: new Float32Array(uv),
    index: new Uint16Array(idx),
  };
  return _frondArr;
}

/** A unit-length frond geometry (base at origin, extends +X, droops -Y). */
function makeFrondGeometry() {
  const a = frondArrays();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(a.position, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(a.uv, 2));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeVertexNormals();
  return g;
}

// extra weathered-beach palette for the richer models
const C_TRIM = 0xf6efe0;     // window/door frames, trim
const C_SHUTTER = 0x6e9a8f;  // muted teal shutters
const C_SILL = 0xcdbba1;      // window sills
const BRICK = 0xb06a4e;       // chimney
const GOLD = 0xd9b25a;        // door knob
const PALM_BOOT = 0x7a5a36;   // frond boot at the crown

// --- procedural model builders -------------------------------------------
// Module-level helpers so the model methods stay readable. Each returns fresh
// THREE objects (geometry is disposed by _clear between paints); the canvas
// textures they reference are module-cached, so rebuilds stay cheap.

const _up = new THREE.Vector3(0, 1, 0);
/** Lay a Y-axis mesh (cylinder/cone) along the segment from→to and size n/a. */
function orientSegment(mesh, from, to) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 1e-4;
  dir.divideScalar(len);
  mesh.quaternion.setFromUnitVectors(_up, dir);
  mesh.position.copy(from).addScaledVector(dir, len / 2);
  return len;
}

/** A flat triangle in the plane z=zc (for gable-end infill), UV'd for plank tiling. */
function gableTriGeom(halfW, baseY, peakY, zc) {
  const pos = new Float32Array([-halfW, baseY, zc, halfW, baseY, zc, 0, peakY, zc]);
  const uv = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** A framed window: glass + panes (muntins) + frame + sill + shutters. Faces +Z,
 *  centred at origin; the caller positions/rotates it onto a wall. */
function buildWindow(w, h) {
  const grp = new THREE.Group();
  const d = w * 0.16, t = Math.min(w, h) * 0.1;
  const trim = matSolid(C_TRIM, { roughness: 0.7 });
  const glass = matSolid(C_WIN, { roughness: 0.18, metalness: 0.12 });
  const pane = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, h * 0.82, d * 0.5), glass);
  pane.position.z = d * 0.12; grp.add(pane);
  const bar = (bw, bh, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), trim); m.position.set(x, y, d * 0.5); grp.add(m); };
  bar(w, t, 0, h / 2 - t / 2); bar(w, t, 0, -h / 2 + t / 2);          // top / bottom frame
  bar(t, h, -w / 2 + t / 2, 0); bar(t, h, w / 2 - t / 2, 0);          // left / right frame
  bar(w * 0.78, t * 0.4, 0, 0); bar(t * 0.4, h * 0.78, 0, 0);         // muntin cross
  const sill = new THREE.Mesh(new THREE.BoxGeometry(w * 1.18, t * 0.7, d * 1.7), matSolid(C_SILL, { roughness: 0.75 }));
  sill.position.set(0, -h / 2 - t * 0.2, d * 0.5); grp.add(sill);
  for (const sx of [-1, 1]) {                                         // shutters
    const sh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.34, h * 1.04, d * 0.5), matSolid(C_SHUTTER, { roughness: 0.7 }));
    sh.position.set(sx * (w / 2 + w * 0.17), 0, d * 0.18); grp.add(sh);
  }
  return grp;
}

/** A framed plank door with sill-step + knob. Faces +Z, base at local y=0. */
function buildDoor(w, h) {
  const grp = new THREE.Group();
  const d = w * 0.22, t = w * 0.12;
  const trim = matSolid(C_TRIM, { roughness: 0.7 });
  const door = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matTex(plankTex(), { roughness: 0.7 }));
  door.position.set(0, h / 2, d * 0.4); grp.add(door);
  const bar = (bw, bh, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d * 1.1), trim); m.position.set(x, y, d * 0.55); grp.add(m); };
  bar(w + t, t, 0, h - t / 2 + t * 0.5);                              // lintel
  bar(t, h + t, -w / 2 - t / 2, h / 2); bar(t, h + t, w / 2 + t / 2, h / 2); // jambs
  const knob = new THREE.Mesh(new THREE.SphereGeometry(w * 0.06, 7, 6), matSolid(GOLD, { roughness: 0.3, metalness: 0.5 }));
  knob.position.set(w * 0.32, h * 0.46, d * 0.9); grp.add(knob);
  const step = new THREE.Mesh(new THREE.BoxGeometry(w * 1.5, h * 0.1, w * 0.7), matSolid(C_DECK, { roughness: 0.8 }));
  step.position.set(0, h * 0.05, d + w * 0.32); grp.add(step);
  return grp;
}

/** A tapered weathered log with rounded ends. Lies along +X, base centred at origin. */
function buildLog(len, rad, mat) {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.82, rad, len, 9, 1), mat);
  body.rotation.z = Math.PI / 2; grp.add(body);
  const capA = new THREE.Mesh(new THREE.SphereGeometry(rad, 8, 6), mat);
  capA.position.x = len / 2; capA.scale.set(0.7, 1, 1); grp.add(capA);
  const capB = new THREE.Mesh(new THREE.SphereGeometry(rad * 0.82, 8, 6), mat);
  capB.position.x = -len / 2; capB.scale.set(0.7, 1, 1); grp.add(capB);
  return grp;
}

export class WorldRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.ready = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_HORIZON);

    // Hero camera framing the cottage cluster, the open water beyond it (+Z). A slow
    // sway (not a full spin) keeps the sea in frame from a flattering angle.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
    this.orbit = { center: new THREE.Vector3(0, 1.1, 4), radius: 21, height: 10, base: Math.PI, amp: 0.5, angle: Math.PI, t: 0 };
    this._applyCamera();

    // Bright tropical sky + warm sun + cool sky fill.
    this.scene.add(new THREE.HemisphereLight(SKY_TOP, SAND, 1.12));
    const sun = new THREE.DirectionalLight(0xfff0cf, 1.7);
    sun.position.set(34, 60, 22);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfe8ff, 0.35);
    fill.position.set(-30, 20, -24);
    this.scene.add(fill);

    this._buildBeach();

    this.solidGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.scene.add(this.solidGroup);
    this.scene.add(this.ghostGroup);
    this._t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

    // Free-fly state: WASD move, Q/E (or Shift/Space) down/up, drag to look, wheel to
    // dolly. Idle auto-sway plays until the user takes control with any movement input.
    this.keys = Object.create(null);
    this.fly = { active: false, pos: new THREE.Vector3(), yaw: 0, pitch: 0, speed: 16, drag: false, px: 0, py: 0 };
  }

  _forward() {
    const p = this.fly.pitch, y = this.fly.yaw;
    return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
  }

  /** Seed the free-fly pose from the current (orbit) camera so control hands off smoothly. */
  _initFly() {
    this.fly.pos.copy(this.camera.position);
    const f = new THREE.Vector3().subVectors(this.orbit.center, this.camera.position).normalize();
    this.fly.yaw = Math.atan2(f.x, f.z);
    this.fly.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  }

  _takeControl() { if (!this.fly.active) { this._initFly(); this.fly.active = true; } }

  /** Wire WASD + drag-look + wheel-dolly. Ignores keys while typing in a field. */
  _attachControls() {
    if (typeof window === "undefined") return;
    const MOVE = new Set(["w", "a", "s", "d", "q", "e", " ", "Shift"]);
    const typing = () => {
      const el = typeof document !== "undefined" ? document.activeElement : null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const onKey = (down) => (e) => {
      if (typing()) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!MOVE.has(k)) return;
      this.keys[k] = down;
      if (down) this._takeControl();
      if (k === " ") e.preventDefault();
    };
    window.addEventListener("keydown", onKey(true));
    window.addEventListener("keyup", onKey(false));
    this.canvas.addEventListener("mousedown", (e) => { this.fly.drag = true; this.fly.px = e.clientX; this.fly.py = e.clientY; });
    window.addEventListener("mouseup", () => { this.fly.drag = false; });
    window.addEventListener("mousemove", (e) => {
      if (!this.fly.drag) return;
      this._takeControl();
      const dx = e.clientX - this.fly.px, dy = e.clientY - this.fly.py;
      this.fly.px = e.clientX; this.fly.py = e.clientY;
      this.fly.yaw -= dx * 0.0026;
      this.fly.pitch = Math.max(-1.35, Math.min(1.35, this.fly.pitch - dy * 0.0026));
    });
    this.canvas.addEventListener("wheel", (e) => {
      this._takeControl();
      this.fly.pos.addScaledVector(this._forward(), -e.deltaY * 0.02);
      e.preventDefault();
    }, { passive: false });
  }

  _updateFly(dt) {
    const fwd = this._forward();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
    const v = new THREE.Vector3();
    const k = this.keys;
    if (k.w) v.add(fwd);
    if (k.s) v.addScaledVector(fwd, -1);
    if (k.d) v.add(right);
    if (k.a) v.addScaledVector(right, -1);
    if (k.e || k[" "]) v.y += 1;
    if (k.q || k.Shift) v.y -= 1;
    if (v.lengthSq() > 0) { v.normalize().multiplyScalar(this.fly.speed * dt); this.fly.pos.add(v); }
    this.camera.position.copy(this.fly.pos);
    this.camera.lookAt(this.fly.pos.clone().add(fwd));
  }

  _applyCamera() {
    const o = this.orbit;
    this.camera.position.set(
      o.center.x + o.radius * Math.sin(o.angle),
      o.height,
      o.center.z + o.radius * Math.cos(o.angle),
    );
    this.camera.lookAt(o.center);
  }

  /** A warm low-poly sand beach that SLOPES into tropical water toward +Z, with a
   *  foam line + wet-sand band at the shore — so the scene reads as a real beach.
   *  The cottage cluster (near the origin) sits on flat dry sand. */
  _buildBeach() {
    const SHORE = 6; // dry sand for z < SHORE; slopes underwater beyond
    const SEA_Y = -0.85;

    // Sea: a big tropical plane just below the dry sand; the sloped sand meets it.
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), matSolid(SEA, { roughness: 0.45 }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = SEA_Y;
    this.scene.add(sea);

    // Sand: a low-poly tile. Flat (~0) where the cottage sits, gentle dunes on the
    // dry sides, sloping down past the shoreline into the water. Deterministic.
    const N = 44, SIZE = 180;
    const heights = new Float32Array(N * N);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = (c / (N - 1) - 0.5) * SIZE;
        const z = (r / (N - 1) - 0.5) * SIZE;
        let h;
        if (z < SHORE) {
          const dist = Math.hypot(x, z);
          const sideDamp = Math.min(1, Math.max(0, (dist - 7) / 26));
          h = (0.6 * Math.sin(x * 0.16) * Math.cos(z * 0.13) + 0.35 * Math.sin((x - z) * 0.1)) * sideDamp;
        } else {
          h = -0.34 * (z - SHORE); // descend below the sea surface
        }
        heights[r * N + c] = h;
      }
    }
    this.scene.add(new THREE.Mesh(tileGeometry(N, N, heights, SIZE, -0.04), matSolid(SAND, { roughness: 0.97 })));

    // Wet-sand band just shoreward of the waterline (darker, damp).
    const wet = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, 5.5), matSolid(SAND_WET, { roughness: 0.9 }));
    wet.rotation.x = -Math.PI / 2;
    wet.position.set(0, -0.02, SHORE + 1.2);
    this.scene.add(wet);

    // Foam line at the waterline.
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, 2.2), matSolid(FOAM, { roughness: 0.4, transparent: true, opacity: 0.9 }));
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(0, -0.78, SHORE + 2.6);
    this.scene.add(foam);
  }

  /** Initialise the WebGPU renderer (async; falls back to its WebGL backend). */
  async init() {
    const Renderer = THREE.WebGPURenderer;
    this.renderer = new Renderer({ canvas: this.canvas, antialias: true, alpha: false });
    if (this.renderer.init) await this.renderer.init();
    this.resize();
    this._attachControls();
    this.ready = true;
    let last = this._t0;
    const loop = () => {
      if (!this.ready) return;
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dt = Math.min(50, now - last) / 1000; last = now;
      if (this.fly.active) {
        this._updateFly(dt);
      } else {
        this.orbit.t += dt;
        this.orbit.angle = this.orbit.base + this.orbit.amp * Math.sin(this.orbit.t * 0.12);
        this._applyCamera();
      }
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    if (this.renderer) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  _clear(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse?.((n) => {
        n.geometry?.dispose?.();
        if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
        else n.material?.dispose?.();
      });
    }
  }

  // --- models -----------------------------------------------------------

  /** A low-poly beach cottage: cream walls, a gable roof with overhang, a door,
   *  windows, and a little front porch. Base sits at local y=0. */
  _cottage(size, ghost) {
    const g = new THREE.Group();
    const s = size;
    const wallW = s, wallD = s * 0.9, wallH = s * 0.7;
    const rise = s * 0.5, ohX = s * 0.16, ohZ = s * 0.13;
    const top = wallH, peakY = top + rise;

    // GHOST: a cheap, readable translucent silhouette — box + gable shell, no texture.
    if (ghost) {
      const walls = new THREE.Mesh(new THREE.BoxGeometry(wallW, wallH, wallD), matGhost(C_WALL));
      walls.position.y = wallH / 2; g.add(walls);
      const roof = new THREE.Mesh(gableRoofGeometry(wallW * 1.2, wallD * 1.18, rise), matGhost(C_ROOF));
      roof.position.y = wallH; g.add(roof);
      return g;
    }

    // Clapboard walls.
    const walls = new THREE.Mesh(new THREE.BoxGeometry(wallW, wallH, wallD), matTex(plankTex()));
    walls.position.y = wallH / 2; g.add(walls);

    // Corner trim boards.
    const trimMat = matSolid(C_TRIM, { roughness: 0.7 });
    const cGeo = new THREE.BoxGeometry(s * 0.06, wallH, s * 0.06);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const c = new THREE.Mesh(cGeo, trimMat);
      c.position.set(sx * wallW / 2, wallH / 2, sz * wallD / 2); g.add(c);
    }

    // Gable-end infill triangles (clapboard) under the roof, front & back.
    const plankMat = matTex(plankTex());
    for (const sz of [1, -1]) {
      const tri = new THREE.Mesh(gableTriGeom(wallW / 2, top, peakY, sz * wallD / 2), plankMat);
      if (sz < 0) tri.rotation.y = Math.PI; // face outward
      g.add(tri);
    }

    // Pitched shingle roof: two overhanging slabs + ridge cap + eave fascia.
    const run = wallW / 2 + ohX, angle = Math.atan2(rise, run);
    const slabLen = Math.hypot(run, rise), slabThick = s * 0.05, slabDepth = wallD + 2 * ohZ;
    const shingleMat = matTex(shingleTex(), { roughness: 0.85 });
    for (const sx of [1, -1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(slabLen, slabThick, slabDepth), shingleMat);
      slab.rotation.z = -sx * angle;
      slab.position.set(sx * run / 2, (peakY + top) / 2 + slabThick * 0.5, 0);
      g.add(slab);
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(s * 0.05, s * 0.1, slabDepth), trimMat);
      fascia.position.set(sx * run, top - s * 0.04, 0); g.add(fascia);
    }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(s * 0.14, s * 0.1, slabDepth), shingleMat);
    ridge.rotation.z = Math.PI / 4; ridge.position.set(0, peakY + s * 0.01, 0); g.add(ridge);

    // Brick chimney poking through the +x slope.
    const chim = new THREE.Mesh(new THREE.BoxGeometry(s * 0.2, s * 0.62, s * 0.2), matTex(brickTex()));
    chim.position.set(wallW * 0.26, top + rise * 0.45, -wallD * 0.16); g.add(chim);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(s * 0.26, s * 0.05, s * 0.26), trimMat);
    cap.position.set(wallW * 0.26, top + rise * 0.45 + s * 0.32, -wallD * 0.16); g.add(cap);

    // Door (front), framed + step + knob.
    const front = wallD / 2;
    const door = buildDoor(s * 0.3, s * 0.52);
    door.position.set(0, 0, front); g.add(door);

    // Framed windows: two on the front flanking the door, one on each side.
    const w0 = s * 0.26, h0 = s * 0.3;
    for (const dx of [-s * 0.34, s * 0.34]) {
      const win = buildWindow(w0, h0); win.position.set(dx, s * 0.46, front); g.add(win);
    }
    for (const sx of [-1, 1]) {
      const win = buildWindow(w0, h0);
      win.position.set(sx * wallW / 2, s * 0.46, 0); win.rotation.y = sx * Math.PI / 2; g.add(win);
    }

    // Front porch: deck + railing posts + top rail.
    const deckMat = matTex(driftTex(), { roughness: 0.8 });
    const deckD = s * 0.5, deckZ = front + deckD / 2;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(wallW * 1.02, s * 0.1, deckD), deckMat);
    deck.position.set(0, s * 0.05, deckZ); g.add(deck);
    const postGeo = new THREE.CylinderGeometry(s * 0.04, s * 0.05, s * 0.46, 7);
    const railMat = matSolid(C_DECK, { roughness: 0.75 });
    const railZ = front + deckD;
    for (const k of [-1, -0.34, 0.34, 1]) {
      const p = new THREE.Mesh(postGeo, railMat);
      p.position.set(k * wallW * 0.5, s * 0.33, railZ); g.add(p);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(wallW * 1.04, s * 0.05, s * 0.05), railMat);
    rail.position.set(0, s * 0.54, railZ); g.add(rail);
    return g;
  }

  /** A low-poly palm: a leaning tapered trunk, a crown of drooping fronds, coconuts. */
  _palm(size, ghost) {
    const g = new THREE.Group();
    const s = Math.max(0.7, size);

    // GHOST: cheap silhouette — a few straight trunk segments + crude blade fronds.
    if (ghost) {
      const tg = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.12, s * 0.18, s * 2.6, 6), matGhost(PALM_TRUNK));
      tg.rotation.z = -0.18; tg.position.set(s * 0.24, s * 1.3, 0); g.add(tg);
      const crownG = new THREE.Vector3(s * 0.46, s * 2.55, 0);
      for (let i = 0; i < 6; i++) {
        const len = s * 1.5;
        const frond = new THREE.Mesh(new THREE.ConeGeometry(s * 0.16, len, 4), matGhost(i % 2 ? PALM_FROND2 : PALM_FROND));
        frond.geometry.translate(0, len / 2, 0); frond.scale.set(1, 1, 0.3);
        frond.rotation.z = -(Math.PI / 2 + 0.6);
        const pivot = new THREE.Group(); pivot.add(frond);
        pivot.rotation.y = (i / 6) * Math.PI * 2; pivot.position.copy(crownG); g.add(pivot);
      }
      return g;
    }

    // Naturally curved tapering trunk: stacked bark cylinders following an
    // accelerating lean with a slight S, oriented along the local tangent.
    const trunkMat = matTex(barkTex(), { roughness: 0.9 });
    const SEG = 8, H = s * 2.7, lean = s * 0.55;
    const pt = (t) => new THREE.Vector3(
      lean * t * t - s * 0.12 * Math.sin(t * Math.PI),  // S-curve lean toward +x
      H * t,
      s * 0.06 * Math.sin(t * Math.PI * 0.8),
    );
    let prev = pt(0);
    for (let i = 1; i <= SEG; i++) {
      const t0 = (i - 1) / SEG, t1 = i / SEG, cur = pt(t1);
      const r0 = s * (0.19 - 0.10 * t0), r1 = s * (0.19 - 0.10 * t1);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, prev.distanceTo(cur) * 1.04, 7, 1), trunkMat);
      orientSegment(seg, prev, cur); g.add(seg);
      prev = cur;
    }
    const crown = pt(1);

    // Frond boot (dark fibrous cluster where fronds emerge).
    const boot = new THREE.Mesh(new THREE.SphereGeometry(s * 0.16, 8, 6), matSolid(PALM_BOOT, { roughness: 0.95 }));
    boot.position.copy(crown); g.add(boot);

    // Crown of real-silhouette fronds: curved rachis + serrated leaflets, arching
    // up from the boot then drooping. Per-frond length/pitch/tint variation.
    const frondTexture = frondTex();
    const nF = 11;
    for (let i = 0; i < nF; i++) {
      const v = (i * 2.39996) % 1; // golden-angle scatter for variation
      const len = s * (1.5 + v * 0.5);
      const tint = 0.86 + v * 0.22;
      const frondMat = matTex(frondTexture, {
        color: new THREE.Color(PALM_FROND).multiplyScalar(tint),
        roughness: 0.75, side: DS,
      });
      const frond = new THREE.Mesh(makeFrondGeometry(), frondMat);
      frond.scale.set(len, len, len);
      frond.rotation.z = 0.55 - v * 0.7;          // lift the base; natural droop arcs it down
      frond.rotation.x = (v - 0.5) * 0.5;          // slight roll for volume
      const pivot = new THREE.Group();
      pivot.add(frond);
      pivot.rotation.y = (i / nF) * Math.PI * 2 + v * 0.4;
      pivot.position.copy(crown);
      g.add(pivot);
    }

    // Coconut cluster nestled under the crown.
    const cocoGeo = new THREE.SphereGeometry(s * 0.12, 7, 6);
    const cocoMat = matSolid(COCONUT, { roughness: 0.85 });
    for (const a of [0.3, 1.9, 3.4, 4.9]) {
      const c = new THREE.Mesh(cocoGeo, cocoMat);
      c.scale.set(1, 1.15, 1);
      c.position.set(crown.x + Math.cos(a) * s * 0.15 - s * 0.06, crown.y - s * 0.16, crown.z + Math.sin(a) * s * 0.15);
      g.add(c);
    }
    return g;
  }

  /** A couple of weathered driftwood logs lying on the sand. */
  _driftwood(size, ghost) {
    const g = new THREE.Group();
    const s = Math.max(0.6, size);

    // GHOST: two plain translucent cylinders — cheap, readable marker.
    if (ghost) {
      const mat = matGhost(DRIFTWOOD);
      const a = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.16, s * 0.13, s * 1.7, 6), mat);
      a.rotation.z = Math.PI / 2; a.rotation.y = 0.4; a.position.set(0, s * 0.16, 0); g.add(a);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.13, s * 0.1, s * 1.2, 6), mat);
      b.rotation.order = "ZYX"; b.rotation.z = Math.PI / 2; b.rotation.y = 1.3;
      b.position.set(s * 0.18, s * 0.13, s * 0.22); g.add(b);
      return g;
    }

    // Three bleached, bark-textured logs with rounded ends — one with a forked branch.
    const mat = matTex(driftTex(), { roughness: 0.85 });
    const place = (log, rad, ox, oz, yaw, roll) => {
      log.rotation.order = "YXZ";
      log.rotation.y = yaw; log.rotation.z = roll || 0;
      log.position.set(ox, rad * 0.92, oz); g.add(log);
    };
    place(buildLog(s * 1.8, s * 0.16, mat), s * 0.16, 0, 0, 0.42, 0.06);
    place(buildLog(s * 1.25, s * 0.13, mat), s * 0.13, s * 0.34, s * 0.26, 1.25, -0.05);

    // Forked stick: a slim log with two diverging branch tips.
    const fork = new THREE.Group();
    fork.add(buildLog(s * 1.1, s * 0.08, mat));
    for (const sgn of [1, -1]) {
      const br = buildLog(s * 0.5, s * 0.05, mat);
      br.position.set(s * 0.5, 0, 0);
      br.rotation.z = sgn * 0.5; br.rotation.y = sgn * 0.3; fork.add(br);
    }
    fork.rotation.order = "YXZ"; fork.rotation.y = -0.7;
    fork.position.set(-s * 0.3, s * 0.09, -s * 0.28); g.add(fork);
    return g;
  }

  /** Build a mesh for one renderable item (entity or ghost). Items are ground-seated
   *  (sit on the sand at y=0) so a ghost and its approved solid line up. */
  _meshFor(kind, position, opts = {}) {
    const x = position[0];
    const z = position[2];
    const size = opts.size ?? 1;
    const ghost = !!opts.ghost;

    if (kind === "ground") {
      // A held terrain region → a translucent sand patch; approved terrain tiles are
      // covered by the beach base, so a small flat marker is enough.
      const s = ghost ? (opts.size ?? 48) : 10;
      const mesh = new THREE.Mesh(
        tileGeometry(6, 6, new Float32Array(36), s, 0.02),
        ghost ? matGhost(SAND) : matSolid(SAND_WET, { roughness: 0.95 }),
      );
      mesh.position.set(x, 0, z);
      return mesh;
    }

    let node;
    if (kind === "structure") node = this._cottage(size, ghost);
    else if (kind === "prop") {
      const isWood = (opts.color ?? 0) === 0xa0522d; // brown driftwood vs green palm
      node = isWood ? this._driftwood(size, ghost) : this._palm(size, ghost);
    } else {
      node = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), ghost ? matGhost(opts.color ?? 0x6c8ebf) : matSolid(opts.color ?? 0x6c8ebf));
      node.position.y = size / 2;
      const wrap = new THREE.Group(); wrap.add(node); node = wrap;
    }
    node.position.set(x, 0, z);
    return node;
  }

  /** Paint the world from a view-model { entities, ghosts }. */
  render(model) {
    this._clear(this.solidGroup);
    this._clear(this.ghostGroup);
    for (const e of model.entities) {
      const size = typeof e.size === "number" ? e.size : (e.kind === "structure" ? 3 : 1);
      this.solidGroup.add(this._meshFor(e.kind, e.position, { size, color: e.color }));
    }
    for (const g of model.ghosts) {
      this.ghostGroup.add(this._meshFor(g.kind, g.position, { size: g.size ?? 1, color: g.color, ghost: true }));
    }
  }

  /** Reset all transient world geometry (on a new build). */
  reset() {
    this._clear(this.solidGroup);
    this._clear(this.ghostGroup);
  }
}
