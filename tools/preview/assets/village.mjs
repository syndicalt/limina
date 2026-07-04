import * as THREE from "three";
import { planVillage } from "/js/src/world/pipeline/village-layout.mjs";
import { buildLaneGeometry, buildGroundPadGeometry } from "/js/src/world/pipeline/village-geometry.mjs";
// The procedural material factory (ashlar/oak/thatch/…/earth/cobble painted from the palette)
// now lives in the SHARED, THREE-agnostic module so the engine's village.build dresses its
// ground with the IDENTICAL earth/cobble look. THREE is passed in (see village-materials.mjs).
import { makeMaterials } from "/js/src/world/pipeline/village-materials.mjs";

// ---------------------------------------------------------------------------
// buildVillage — GENERIC, data-driven village composer.
//
//   const { objects, footprints } = await buildVillage(terrain, direction, steering);
//
// NOTHING about the setting or architecture is hard-coded here:
//   • WHAT gets built comes from steering.buildings[] (role / style / count).
//   • HOW it looks comes from direction.palette (role→hex) + direction.mood.
//   • WHERE it goes comes from steering.layout (focal + density) read against
//     the live terrain (heightAt / slopeAt / seaLevelM).
// Each architectural style is one entry in the `builders` map below — adding
// a style (sci-fi hab dome, brutalist block, …) is adding a builder function,
// never rewriting the composer. Unknown styles fall back to a neutral massing
// builder so a novel direction/steering still produces a coherent settlement.
//
// Deterministic: a single mulberry32 stream seeded from the inputs; no
// Math.random / Date anywhere.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------- randomness

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// FNV-1a — stable seed derived from the *inputs*, so the same direction +
// steering always yields the same village, and different inputs re-roll it.
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const R = (rng, a, b) => a + (b - a) * rng();

// The procedural textures + material factory (makeMaterials, paintAshlar/…/paintEarth/
// paintCobble, canvasTexture, normalFromCanvas) were EXTRACTED to the shared, THREE-agnostic
// js/src/world/pipeline/village-materials.mjs so the engine skill dresses its ground identically.
// buildVillage calls makeMaterials(THREE, direction, rng) below.

// ------------------------------------------------------------ geometry kit
// Small shared vocabulary the style-builders compose from.

// Shadowed mesh.
function M(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
const box = (w, h, d, mat) => M(new THREE.BoxGeometry(w, h, d), mat);

// Solid gable-roof prism. Ridge runs along local Z; base sits at y=0.
function gableRoof(span, length, rise, mat, overhang = 0.4) {
  const hw = span / 2 + overhang;
  const s = new THREE.Shape();
  s.moveTo(-hw, 0);
  s.lineTo(hw, 0);
  s.lineTo(0, rise);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: length + overhang * 2, bevelEnabled: false });
  geo.translate(0, 0, -(length / 2 + overhang));
  return M(geo, mat);
}

// Flat round-arched panel (rectangle + semicircular head), extruded `depth`.
// Used proud-of-wall for arched doors/windows (romanesque etc.).
function archPanel(w, h, depth, mat) {
  const r = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, h - r);
  s.absarc(0, h - r, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.closePath();
  return M(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }), mat);
}

// Battlements around a rectangular parapet (merlons on all four edges).
function addMerlonsRect(g, sx, sz, y, mat, mw = 0.6, mh = 0.7, mt = 0.35) {
  const edge = (len, place) => {
    const n = Math.max(2, Math.floor(len / (mw * 2)));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      g.add(place(t));
    }
  };
  const mk = (x, z, alongX) => {
    const m = box(alongX ? mw : mt, mh, alongX ? mt : mw, mat);
    m.position.set(x, y + mh / 2, z);
    return m;
  };
  edge(sx, (t) => mk(t, sz / 2, true));
  edge(sx, (t) => mk(t, -sz / 2, true));
  edge(sz, (t) => mk(sx / 2, t, false));
  edge(sz, (t) => mk(-sx / 2, t, false));
}

// Battlements around a circular tower top.
function addMerlonsRound(g, r, y, mat, n = 8) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const m = box(0.55, 0.65, 0.3, mat);
    m.position.set(Math.sin(a) * r, y + 0.325, Math.cos(a) * r);
    m.rotation.y = a;
    g.add(m);
  }
}

// ------------------------------------------------------------ style builders
// One builder per architectural style. Each returns a THREE.Group whose base
// sits on y=0, front facade faces local +Z, with .userData.radius set to the
// footprint radius. `ctx` = { rng, mats, role } — everything else it needs it
// must derive from those (keeps builders portable across settings).

const builders = {
  // NORMAN KEEP (great tower): one rectangular mass with thick walls, clasping
  // corner buttresses rising into small square turrets just above the
  // battlements, flat mid-wall buttresses, a crenellated parapet, mean window
  // slits below / small round-arched lights above, and a FOREBUILDING against
  // the front face protecting a raised first-floor entrance reached by an
  // external masonry stair. Broad, not spired; no round fairytale towers.
  "nordic castle"(ctx) {
    const { mats } = ctx;
    const g = new THREE.Group();
    const W = 10, D = 8.5, H = 9.5; // rectangular plan, broader than tall-ish

    // Battered plinth: two stepped courses spreading at the base
    const p1 = box(W + 2.4, 0.9, D + 2.4, mats.stone);
    p1.position.y = 0.45;
    g.add(p1);
    const p2 = box(W + 1.2, 0.9, D + 1.2, mats.stone);
    p2.position.y = 1.1;
    g.add(p2);

    // The great tower itself
    const body = box(W, H, D, mats.stone);
    body.position.y = H / 2;
    g.add(body);

    // Parapet slab + crenellations (merlons/crenels) around the wall-walk
    const parapet = box(W + 0.7, 0.55, D + 0.7, mats.stone);
    parapet.position.y = H + 0.27;
    g.add(parapet);
    addMerlonsRect(g, W + 0.7, D + 0.7, H + 0.55, mats.stone, 0.7, 0.75, 0.4);

    // Clasping corner buttresses → square turrets a little above the parapet
    const TS = 2.0, TT = H + 2.3; // turret side / top
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const t = box(TS, TT, TS, mats.stone);
      t.position.set(sx * (W / 2), TT / 2, sz * (D / 2));
      g.add(t);
      const cap = box(TS + 0.3, 0.35, TS + 0.3, mats.stone);
      cap.position.set(sx * (W / 2), TT + 0.17, sz * (D / 2));
      g.add(cap);
      const ring = new THREE.Group();
      ring.position.set(sx * (W / 2), 0, sz * (D / 2));
      addMerlonsRect(ring, TS + 0.3, TS + 0.3, TT + 0.35, mats.stone, 0.45, 0.5, 0.3);
      g.add(ring);
    }

    // Flat pilaster buttresses at the midpoint of each free face
    for (const [x, z, ry] of [
      [0, -D / 2 - 0.2, 0],            // rear
      [W / 2 + 0.2, 0, Math.PI / 2],   // east flank
      [-W / 2 - 0.2, 0, Math.PI / 2],  // west flank
    ]) {
      const b = box(1.3, H, 0.5, mats.stone);
      b.position.set(x, H / 2, z);
      b.rotation.y = ry;
      g.add(b);
    }

    // Openings: arrow slits low, small paired round-arched lights high
    for (const face of [0, 1, 2, 3]) {
      const put = (m, off, y) => {
        if (face === 0) m.position.set(off, y, D / 2 + 0.04);
        if (face === 1) { m.position.set(off, y, -D / 2 - 0.04); m.rotation.y = Math.PI; }
        if (face === 2) { m.position.set(W / 2 + 0.04, y, off); m.rotation.y = Math.PI / 2; }
        if (face === 3) { m.position.set(-W / 2 - 0.04, y, off); m.rotation.y = -Math.PI / 2; }
        g.add(m);
      };
      // front (+Z) face: only the side clear of the forebuilding gets openings
      const slitOffs = face === 0 ? [-2.9] : [-2.9, 2.9];
      const winOffs = face === 0 ? [-3.1, -2.2] : [-3.1, -2.2, 2.2, 3.1];
      for (const off of slitOffs) put(box(0.3, 1.3, 0.12, mats.opening), off, 3.4);
      for (const off of winOffs) {
        const w = archPanel(0.55, 1.5, 0.1, mats.opening);
        put(w, off, 0); // archPanel's own base is y=0 → lift after placing
        w.position.y += 6.6;
      }
    }

    // FOREBUILDING: lower block against the front (+Z) face, crenellated,
    // sheltering the raised first-floor entrance.
    const FW = 4.2, FD = 2.6, FH = 6.6, FX = 2.0;
    const fore = box(FW, FH, FD, mats.stone);
    fore.position.set(FX, FH / 2, D / 2 + FD / 2);
    g.add(fore);
    const fpar = box(FW + 0.4, 0.4, FD + 0.4, mats.stone);
    fpar.position.set(FX, FH + 0.2, D / 2 + FD / 2);
    g.add(fpar);
    const fring = new THREE.Group();
    fring.position.set(FX, 0, D / 2 + FD / 2);
    addMerlonsRect(fring, FW + 0.4, FD + 0.4, FH + 0.4, mats.stone, 0.5, 0.55, 0.3);
    g.add(fring);

    // Raised entrance: round-arched doorway in the forebuilding's stair-side
    // (-X) face, first-floor height — no door at ground level anywhere.
    const doorSurround = archPanel(2.0, 3.0, 0.25, mats.scaled("stone", 0.35));
    doorSurround.position.set(FX - FW / 2 - 0.22, 3.0, D / 2 + FD / 2);
    doorSurround.rotation.y = -Math.PI / 2;
    g.add(doorSurround);
    const door = archPanel(1.3, 2.4, 0.2, mats.scaled("timberDark", 0.6));
    door.position.set(FX - FW / 2 - 0.28, 3.15, D / 2 + FD / 2);
    door.rotation.y = -Math.PI / 2;
    g.add(door);

    // External masonry stair along the front face, climbing to the entrance.
    const steps = 9, riseTo = 3.1, stepW = 0.62, runX0 = FX - FW / 2 - stepW / 2;
    for (let i = 0; i < steps; i++) {
      const top = riseTo * ((i + 1) / steps);
      const s = box(stepW, top, 1.5, mats.stone);
      s.position.set(runX0 - (steps - 1 - i) * stepW, top / 2, D / 2 + 0.95);
      g.add(s);
    }
    // Landing slab in front of the raised door
    const landing = box(1.35, riseTo, 1.9, mats.stone);
    landing.position.set(FX - FW / 2 - 0.68, riseTo / 2, D / 2 + FD / 2);
    g.add(landing);
    // Low parapet wall guarding the stair's outer edge
    const stairWall = box(steps * stepW, 1.0, 0.3, mats.stone);
    stairWall.position.set(runX0 - (steps - 1) * stepW / 2, riseTo * 0.62, D / 2 + 1.78);
    g.add(stairWall);

    g.userData.radius = 9;
    return g;
  },

  // ROMANESQUE church on a LATIN-CROSS plan: a long nave taller than it is
  // wide, a transept crossing near the east end, a square TOWER OVER THE
  // CROSSING with a pyramidal cap, and a semicircular apse beyond. Round
  // (semicircular) arches only — nested-archivolt west portal, small arched
  // windows, a lombard arcaded band under the eaves, pilaster strips. Thick,
  // massive, small openings; nothing pointed.
  romanesque(ctx) {
    const { mats } = ctx;
    const g = new THREE.Group();
    const W = 6.5, D = 14, H = 6;      // nave: taller than wide; west front +Z
    const TL = 11.5, TD = 3.8;         // transept: total length (X) / depth (Z)
    const zT = -4.3;                   // transept centreline (near the east end)
    const rise = 3.2;

    const nave = box(W, H, D, mats.stone);
    nave.position.y = H / 2;
    g.add(nave);

    // Nave roof, ridge along Z + stone gable infill front/back
    const roof = gableRoof(W, D, rise, mats.terracotta, 0.45);
    roof.position.y = H;
    g.add(roof);
    for (const s of [1, -1]) {
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(0, rise); shape.closePath();
      const gable = M(new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false }), mats.scaled("stone", 0.35));
      gable.position.set(0, H, s * (D / 2) - 0.15);
      g.add(gable);
    }

    // TRANSEPT: the cross-arm, same wall height, gable roof ridge along X
    const transept = box(TL, H, TD, mats.stone);
    transept.position.set(0, H / 2, zT);
    g.add(transept);
    const tRoof = gableRoof(TD, TL, 2.3, mats.terracotta, 0.4);
    tRoof.rotation.y = Math.PI / 2; // ridge along X
    tRoof.position.set(0, H, zT);
    g.add(tRoof);
    for (const s of [1, -1]) { // transept gable infills + end windows
      const shape = new THREE.Shape();
      shape.moveTo(-TD / 2, 0); shape.lineTo(TD / 2, 0); shape.lineTo(0, 2.3); shape.closePath();
      const gable = M(new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false }), mats.scaled("stone", 0.35));
      gable.rotation.y = Math.PI / 2; // shape-X → world Z, extrude → world +X
      gable.position.set(s * (TL / 2) - 0.15, H, zT);
      g.add(gable);
      const w = archPanel(0.9, 2.2, 0.12, mats.opening);
      w.position.set(s * (TL / 2 + 0.05), 2.8, zT);
      w.rotation.y = s * Math.PI / 2;
      g.add(w);
    }

    // TOWER OVER THE CROSSING: square shaft, arched belfry lights, pyramid cap
    const TW = 4.0, TH = 11.2; // clears the nave ridge decisively
    const tower = new THREE.Group();
    tower.position.set(0, 0, zT);
    const shaft = box(TW, TH, TW, mats.stone);
    shaft.position.y = TH / 2;
    tower.add(shaft);
    const cap = M(new THREE.ConeGeometry(TW * 0.78, 2.6, 4), mats.scaled("slate", 3, 2));
    cap.position.y = TH + 1.3;
    cap.rotation.y = Math.PI / 4;
    tower.add(cap);
    for (let f = 0; f < 4; f++) {
      for (const dt of [-0.85, 0.85]) { // PAIRED round-arched belfry lights
        const o = archPanel(0.8, 1.9, 0.15, mats.opening);
        const a = (f * Math.PI) / 2;
        const ox = Math.cos(a) * dt, oz = -Math.sin(a) * dt;
        o.position.set(Math.sin(a) * (TW / 2 + 0.05) + ox, TH - 2.9, Math.cos(a) * (TW / 2 + 0.05) + oz);
        o.rotation.y = a;
        tower.add(o);
      }
    }
    g.add(tower);

    // Pilaster strips (lesenes) down the nave flanks, west of the transept
    const zN0 = zT + TD / 2 + 0.4, zN1 = D / 2; // nave stretch clear of transept
    for (let i = 0; i <= 3; i++) {
      const z = zN0 + ((zN1 - zN0) * i) / 3;
      for (const s of [1, -1]) {
        const p = box(0.5, H, 0.35, mats.stone);
        p.position.set(s * (W / 2 + 0.12), H / 2, z);
        g.add(p);
      }
    }

    // Lombard band: little blind arches in a row under the eaves (flanks)
    for (const s of [1, -1]) {
      const n = Math.floor((zN1 - zN0 - 0.6) / 0.72);
      for (let i = 0; i < n; i++) {
        const a = archPanel(0.42, 0.68, 0.07, mats.trim);
        a.position.set(s * (W / 2 + 0.04), H - 1.0, zN0 + 0.5 + i * 0.72);
        a.rotation.y = s * Math.PI / 2;
        g.add(a);
      }
    }

    // West portal: round-arched door inside two nested archivolt rings
    const arch2 = archPanel(3.2, 4.0, 0.35, mats.scaled("stone", 0.35));
    arch2.position.set(0, 0, D / 2 + 0.02);
    g.add(arch2);
    const arch1 = archPanel(2.5, 3.5, 0.4, mats.trim);
    arch1.position.set(0, 0, D / 2 + 0.1);
    g.add(arch1);
    const doorway = archPanel(1.8, 3.0, 0.42, mats.opening);
    doorway.position.set(0, 0, D / 2 + 0.18);
    g.add(doorway);
    // Small round window (oculus) in the west gable above the portal
    const oculus = M(new THREE.CylinderGeometry(0.7, 0.7, 0.12, 18), mats.opening);
    oculus.rotation.x = Math.PI / 2;
    oculus.position.set(0, H + 1.1, D / 2 + 0.08);
    g.add(oculus);

    // Small single round-arched windows in each nave bay (thick-wall scale)
    for (let i = 0; i < 3; i++) {
      const z = zN0 + 1.1 + i * ((zN1 - zN0 - 2.2) / 2);
      for (const s of [1, -1]) {
        const w = archPanel(0.7, 1.8, 0.15, mats.opening);
        w.position.set(s * (W / 2 + 0.05), 3.0, z);
        w.rotation.y = s * Math.PI / 2;
        g.add(w);
      }
    }

    // Semicircular APSE at the east end, half-cylinder + half-cone roof
    const AR = 2.4, AH = 4.2;
    const apse = M(new THREE.CylinderGeometry(AR, AR, AH, 14, 1, false, Math.PI / 2, Math.PI), mats.stone);
    apse.position.set(0, AH / 2, -D / 2);
    g.add(apse);
    const apseRoof = M(new THREE.ConeGeometry(AR + 0.3, 1.6, 14, 1, false, Math.PI / 2, Math.PI), mats.scaled("terracotta", 3, 2));
    apseRoof.position.set(0, AH + 0.8, -D / 2);
    g.add(apseRoof);

    g.userData.radius = 10;
    return g;
  },

  // WATTLE-AND-DAUB cottage: exposed dark timber frame (posts, sill/top
  // plates, mid rail, braces) with IRREGULAR, slightly bulging whitewashed
  // daub panels pillowing out between the timbers — no two panels sit on
  // quite the same plane. Steeply-pitched thatch OVERHANGS the walls at both
  // eaves and gables. Narrow single-storey footprint; humble.
  "wattle-and-daub"(ctx) {
    const { rng, mats } = ctx;
    const g = new THREE.Group();
    const W = R(rng, 4.2, 5.2);   // gable span (X) — narrow
    const D = R(rng, 5.6, 7.2);   // ridge length (Z)
    const H = R(rng, 2.3, 2.7);   // wall height — single storey
    const daub = mats.jitter(mats.plaster, 0.6); // per-cottage whitewash tint

    // Thin core wall the frame + panels dress (never visible proud)
    const body = box(W - 0.12, H, D - 0.12, daub);
    body.position.y = H / 2;
    g.add(body);

    const T = 0.17; // timber scantling
    const bays = 3; // structural bays down the length
    const bayL = D / bays;
    const midY = H * 0.52;

    // A slightly bulged daub panel proud of (or shy of) the frame plane —
    // thickness, protrusion and a tiny tilt all jittered per panel.
    const panel = (pw, ph, alongZ) => {
      const t = R(rng, 0.14, 0.3);
      const m = alongZ
        ? box(t, ph, pw, mats.jitter(daub, 0.5))
        : box(pw, ph, t, mats.jitter(daub, 0.5));
      m.rotation.x = R(rng, -0.025, 0.025);
      m.rotation.z = R(rng, -0.02, 0.02);
      return { m, t, out: R(rng, 0.0, 0.09) };
    };

    // Long walls (±X): posts at every bay line, plates, mid rail, braces,
    // and two tiers of bulging panels per bay.
    for (const s of [1, -1]) {
      const xFrame = s * (W / 2 + 0.03);
      for (let b = 0; b <= bays; b++) { // posts on the bay lines
        const post = box(T, H, T, mats.timber);
        post.position.set(xFrame, H / 2, -D / 2 + b * bayL);
        g.add(post);
      }
      for (const y of [0.1, midY, H - 0.09]) { // sill / mid rail / top plate
        const plate = box(T * 0.95, T, D + T, mats.timber);
        plate.position.set(xFrame, y, 0);
        g.add(plate);
      }
      for (const dz of [-D / 2 + bayL / 2, D / 2 - bayL / 2]) { // end braces
        const brace = box(T * 0.8, H * 0.62, T * 0.8, mats.timber);
        brace.position.set(xFrame, H * 0.5, dz);
        brace.rotation.x = (dz > 0 ? 1 : -1) * 0.55;
        g.add(brace);
      }
      for (let b = 0; b < bays; b++) { // the daub itself, two tiers per bay
        const zc = -D / 2 + (b + 0.5) * bayL;
        for (const [y0, y1] of [[0.16, midY - T / 2], [midY + T / 2, H - 0.16]]) {
          const ph = y1 - y0;
          const { m, t, out } = panel(bayL - T * 1.1, ph, true);
          m.position.set(s * (W / 2 - t / 2 + 0.02 + out), y0 + ph / 2, zc);
          g.add(m);
        }
      }
    }

    // Gable ends (±Z): studs + bulging panels; door replaces one front panel
    const studXs = [-W / 4, 0, W / 4];
    const doorX = (rng() < 0.5 ? -1 : 1) * (W / 8); // centre of an inner panel cell
    for (const s of [1, -1]) {
      const zFrame = s * (D / 2 + 0.03);
      for (const dx of studXs) {
        const stud = box(T * 0.9, H, T, mats.timber);
        stud.position.set(dx, H / 2, zFrame);
        g.add(stud);
      }
      const cells = [[-W / 2 + T, -W / 4 - T / 2], [-W / 4 + T / 2, -T / 2], [T / 2, W / 4 - T / 2], [W / 4 + T / 2, W / 2 - T]];
      for (const [x0, x1] of cells) {
        const xc = (x0 + x1) / 2;
        if (s > 0 && Math.abs(xc - doorX) < (x1 - x0) / 2) continue; // door cell
        const { m, t, out } = panel(x1 - x0, H - 0.3, false);
        m.position.set(xc, H / 2, s * (D / 2 - t / 2 + 0.02 + out));
        g.add(m);
      }
    }

    // Board door in the front gable end (+Z), low — you'd duck through it
    const door = box(0.95, 1.8, 0.14, mats.timberDark);
    door.position.set(doorX, 0.9, D / 2 + 0.09);
    g.add(door);

    // A shuttered window or two on the flanks
    const nWin = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < nWin; i++) {
      const s = rng() < 0.5 ? 1 : -1;
      const win = box(0.14, 0.6, 0.7, mats.opening);
      win.position.set(s * (W / 2 + 0.13), R(rng, 1.2, 1.5), R(rng, -D / 3, D / 3));
      g.add(win);
    }

    // Steep thatch, generous overhang past BOTH the eaves and the gables so
    // the drip line clears the daub. Sits low over the wall head.
    const rise = W * R(rng, 0.7, 0.82);
    const roof = gableRoof(W + 0.35, D, rise, mats.jitter(mats.thatch, 0.5), 0.8);
    roof.position.y = H - 0.12;
    g.add(roof);

    g.userData.radius = Math.max(W, D) / 2 + 1.4;
    return g;
  },

  // TITHE BARN: a long AISLED hall — tall central nave flanked by lower
  // lean-to side aisles (stepped silhouette), big timber A-frame trusses
  // expressed on the gable ends and as bay posts down the flanks, a
  // high-pitched roof, all resting on a low STONE PLINTH. The largest
  // agricultural building by a clear margin.
  timber(ctx) {
    const { rng, mats } = ctx;
    const g = new THREE.Group();
    const NW = 5.4, NH = 4.7;             // nave width / wall height
    const AW = 2.4, AH = 2.6;             // aisle width / eave height
    const D = R(rng, 15.5, 17.5);         // length — much longer than wide
    const P = 0.7;                        // stone plinth height
    const TW2 = NW / 2 + AW;              // half total width
    const rise = 3.7;                     // high-pitched nave roof

    // Low stone plinth the whole timber frame rests on
    const plinth = box(TW2 * 2 + 0.6, P, D + 0.6, mats.stone);
    plinth.position.y = P / 2;
    g.add(plinth);

    // Tall central nave + lower side aisles (the stepped aisled section)
    const barnWall = mats.scaled("timber", 5, 1.5); // long faces: ~3m board bays
    const nave = box(NW, NH, D, barnWall);
    nave.position.y = P - 0.1 + NH / 2;
    g.add(nave);
    for (const s of [1, -1]) {
      const aisle = box(AW, AH, D, barnWall);
      aisle.position.set(s * (NW / 2 + AW / 2), P - 0.1 + AH / 2, 0);
      g.add(aisle);
    }

    // Nave roof: steep gable, ridge along Z. Modest verge at the gables so
    // the exposed A-frame truss stays visible against the end wall.
    const roof = gableRoof(NW + 0.4, D, rise, mats.thatch, 0.2);
    roof.position.y = P + NH - 0.15;
    g.add(roof);

    // Aisle lean-to roofs: continuous slopes from the nave wall down over
    // the aisles — this is what makes the section read as aisled.
    const eaveOut = TW2 + 0.55;                    // drip past the aisle wall
    const yTop = P + NH + 0.15, yLow = P + AH + 0.2;
    const dx = eaveOut - NW / 2, dy = yTop - yLow;
    const slope = Math.atan2(dy, dx), len = Math.hypot(dx, dy) + 0.25;
    for (const s of [1, -1]) {
      const shed = box(len, 0.16, D + 0.4, mats.scaled("thatch", 1.2, 6));
      shed.position.set(s * (NW / 2 + dx / 2), (yTop + yLow) / 2, 0);
      shed.rotation.z = -s * slope; // outer edge drops toward the aisle eave
      g.add(shed);
    }

    // Bay posts down the aisle flanks — the repeated timber bays
    const bays = Math.max(4, Math.round(D / 2.9));
    for (const s of [1, -1]) {
      for (let b = 0; b <= bays; b++) {
        const post = box(0.22, AH, 0.22, mats.timberDark);
        post.position.set(s * (TW2 + 0.06), P - 0.1 + AH / 2, -D / 2 + (b * D) / bays);
        g.add(post);
      }
    }

    // Gable ends: big exposed A-frame truss — tie beam at aisle height,
    // principal rafters following the roof pitch, king post to the ridge.
    const rafterA = Math.atan2(rise, NW / 2 + 0.2);
    const rafterL = Math.hypot(rise, NW / 2 + 0.2) + 0.3;
    for (const s of [1, -1]) {
      const zF = s * (D / 2 + 0.28); // proud of the verge → reads as bargeboard truss
      const tie = box(NW * 0.96, 0.24, 0.2, mats.timberDark);
      tie.position.set(0, P + AH + 0.4, zF);
      g.add(tie);
      const king = box(0.22, NH - AH + rise - 0.6, 0.2, mats.timberDark);
      king.position.set(0, P + AH + 0.4 + (NH - AH + rise - 0.6) / 2, zF);
      g.add(king);
      for (const q of [1, -1]) {
        const raf = box(rafterL, 0.2, 0.18, mats.timberDark);
        raf.position.set(q * (NW / 4 + 0.05), P + NH + rise / 2 - 0.15, zF);
        raf.rotation.z = -q * rafterA;
        g.add(raf);
      }
    }

    // Dark battens (plank read) on the aisle walls and nave gable faces
    for (const s of [1, -1]) {
      const n = Math.floor(D / 1.2);
      for (let i = 0; i < n; i++) {
        const z = -D / 2 + (i + 0.5) * (D / n);
        const plank = box(0.09, AH * 0.92, 0.14, mats.timberDark);
        plank.position.set(s * (TW2 + 0.04), P - 0.1 + AH / 2, z);
        g.add(plank);
      }
    }

    // Tall double cart doors in the front gable (+Z), sill on the plinth
    for (const s of [1, -1]) {
      const leaf = box(1.5, 3.5, 0.18, mats.timberDark);
      leaf.position.set(s * 0.8, P + 1.75, D / 2 + 0.14);
      g.add(leaf);
    }

    g.userData.radius = D / 2 + 1.5;
    return g;
  },
};

// Neutral massing fallback so an unrecognized style (from any future
// direction/steering) still yields a plausible structure rather than a crash.
function genericBuilder(ctx) {
  const { rng, mats } = ctx;
  const g = new THREE.Group();
  const W = R(rng, 5, 7), D = R(rng, 6, 9), H = R(rng, 3, 4.5);
  const body = box(W, H, D, mats.stone);
  body.position.y = H / 2;
  g.add(body);
  const roof = gableRoof(W, D, W * 0.4, mats.slate, 0.4);
  roof.position.y = H;
  g.add(roof);
  const door = box(1.1, 2.0, 0.12, mats.opening);
  door.position.set(0, 1.0, D / 2 + 0.07);
  g.add(door);
  g.userData.radius = Math.max(W, D) / 2 + 1;
  return g;
}

// Fuzzy style lookup: exact key, then best token overlap, then generic.
function builderFor(style) {
  const key = String(style ?? "").toLowerCase().trim();
  if (builders[key]) return builders[key];
  const want = key.split(/[\s\-_]+/).filter(Boolean);
  let best = null, bestScore = 0;
  for (const k of Object.keys(builders)) {
    const have = k.split(/[\s\-_]+/);
    const score = want.filter((t) => have.includes(t)).length;
    if (score > bestScore) { best = builders[k]; bestScore = score; }
  }
  return best ?? genericBuilder;
}

// The terrain-aware LAYOUT (survey / focal + cluster + edge placement ordering /
// facing) now lives as a PURE, shared function in
// js/src/world/pipeline/village-layout.mjs (planVillage), so the preview and the
// engine's village.build skill run the SAME algorithm and never drift. This module
// keeps only what authors GEOMETRY at those transforms: the builders/materials
// above, plus the lane + ground pads below (which consume the returned placements).

// --------------------------------------------------------------------- lane
// The lane ribbon + ground-pad GEOMETRY now come from the PURE, shared brain
// js/src/world/pipeline/village-geometry.mjs (buildLaneGeometry / buildGroundPad-
// Geometry) so the preview and the engine's village.build author IDENTICAL ground
// with no drift. These thin wrappers wrap the returned flat buffers into THREE
// BufferGeometry + Mesh with this module's procedural earth/cobble materials.

// Winding rammed-earth ribbon that conforms to the terrain, threaded through
// a nearest-neighbour chain of the placed buildings starting at the focal.
function buildLane(terrain, placed, mats) {
  const g = buildLaneGeometry((x, z) => terrain.heightAt(x, z), placed);
  if (g === null) return { mesh: null };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2));
  geo.setIndex(g.indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.earth);
  mesh.receiveShadow = true; // flat ribbon: receives shadow, casting it would only z-fight
  return { mesh };
}

// -------------------------------------------------------------- ground pads

// Terrain-conforming disc of trodden ground under a building (or courtyard
// around the focal): the settled, lived-in ground that explains the cleared
// footprint. Geometry from the shared brain; material chosen by the caller.
function groundPad(terrain, x0, z0, r, mat, lift = 0.14) {
  const g = buildGroundPadGeometry((x, z) => terrain.heightAt(x, z), x0, z0, r, lift);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(g.positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uvs, 2));
  geo.setIndex(g.indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ compose

export async function buildVillage(terrain, direction, steering) {
  // One deterministic stream, seeded from the *inputs*: same brief in, same
  // village out; a different direction/steering re-seeds everything.
  const seedKey = JSON.stringify({
    s: direction?.setting, a: direction?.artStyle, m: direction?.mood,
    p: direction?.palette, b: steering?.buildings, l: steering?.layout,
  });
  const rng = mulberry32(hashStr(seedKey));
  const mats = makeMaterials(THREE, direction, rng);

  // -- 1) Expand steering.buildings into concrete instances and BUILD them at the
  //       origin first (so their real footprint radii drive the shared layout).
  const specs = steering?.buildings ?? [];
  const instances = []; // parallel to the layout's instance order (spec-by-spec, count times)
  specs.forEach((spec) => {
    const count = Math.max(1, spec.count ?? 1);
    for (let i = 0; i < count; i++) {
      const group = builderFor(spec.style)({ rng, mats, role: spec.role });
      instances.push({ group, radius: group.userData.radius ?? 6 });
    }
  });
  const radii = instances.map((i) => i.radius);

  // -- 2) Run the SHARED, pure terrain-aware layout. A tiny sampler wraps the
  //       preview terrain into the { heightAt, slopeAt, halfSize, seaLevel,
  //       amplitude } contract planVillage reads.
  const sampler = {
    heightAt: (x, z) => terrain.heightAt(x, z),
    slopeAt: (x, z) => terrain.slopeAt(x, z),
    halfSize: terrain.halfSize,
    seaLevel: terrain.config?.seaLevelM ?? 0,
    amplitude: terrain.config?.amplitude,
  };
  const { placements } = planVillage(sampler, direction, steering, radii);
  if (placements.length === 0) return { objects: [], footprints: [] };

  // Reconstruct the placed footprints (placements[0] is the focal) for the lane +
  // the ground pads, which stay here because they author GEOMETRY on the terrain.
  const placed = placements.map((p) => ({ x: p.x, z: p.z, r: radii[p.index] }));
  const { mesh: laneMesh } = buildLane(terrain, placed, mats);

  // -- 3) Seat + orient every building on the terrain at the planned transforms.
  const objects = [];
  const footprints = [];
  for (let k = 0; k < placements.length; k++) {
    const p = placements[k];
    const g = instances[p.index].group;
    // Bury the base slightly so sloped ground never shows a floating corner.
    g.position.set(p.x, terrain.heightAt(p.x, p.z) - 0.3, p.z);
    g.rotation.y = p.yaw; // planned facing (local +Z door → target)

    objects.push(g);
    footprints.push({ x: p.x, z: p.z, r: radii[p.index] });

    // Trodden ground under every building; the focal one (placements[0]) gets a
    // broad earth apron with a cobbled courtyard on top (kills bare-scree
    // readings around the high ground — the summit reads as a lived-in plaza).
    if (k === 0) {
      objects.push(groundPad(terrain, p.x, p.z, radii[p.index] + 15, mats.earth, 0.2));
      objects.push(groundPad(terrain, p.x, p.z, radii[p.index] + 5, mats.cobble, 0.32));
    } else {
      objects.push(groundPad(terrain, p.x, p.z, radii[p.index] * 1.15 + 1, mats.earth));
    }
  }
  if (laneMesh) objects.push(laneMesh);

  return { objects, footprints };
}

// Mint ONE building of `style` with materials from `direction`, standalone:
// base on y=0, front facade facing local +Z, no terrain/lane/pad. This is the
// unit the asset pipeline bakes to GLB and the engine re-consumes — the same
// builders + materials buildVillage uses, just one instance at the origin.
export function buildStandalone(style, direction = {}, seed = 1) {
  const rng = mulberry32((seed >>> 0) || 1);
  const mats = makeMaterials(THREE, direction, rng);
  return builderFor(style)({ rng, mats, role: style });
}
