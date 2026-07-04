import * as THREE from "three";

// ---------------------------------------------------------------------------
// createHouse — parametric, seeded, timber-framed medieval house.
// Returns a THREE.Group. Footprint is centred on (0,0), sits on y=0.
// Ridge runs along local X; the "front" (door) facade faces local +Z.
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

// Grounded, warm palette (hex sRGB).
const PLASTERS = [0xe9e0cc, 0xe6d8ba, 0xdfd6c4, 0xe5cda4, 0xdcd0b6];
const TIMBERS = [0x4a3524, 0x3e2e20, 0x55402c, 0x362a1e];
const ROOFS = [0x7a5b36, 0x6b4f30, 0x4e4a52, 0x5e4a38, 0x8a6a3c];
const STONES = [0x8a8478, 0x7d776b, 0x938c7e];
const TRIMS = [0x7a4032, 0x46543f, 0x3f4a5a, 0x6b4a2a];

function std(color, roughness = 0.9, metalness = 0.0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

// A facade-local group: children live in (u, v, out) coordinates where
// +out points away from the wall. axis "z"/"x", sign +1/-1, offset = wall
// surface distance from house centre.
function facade(parent, axis, sign, offset) {
  const g = new THREE.Group();
  if (axis === "z") {
    g.rotation.y = sign > 0 ? 0 : Math.PI;
    g.position.set(0, 0, sign * offset);
  } else {
    g.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.position.set(sign * offset, 0, 0);
  }
  parent.add(g);
  return g;
}

// Exposed timber framing on one facade (plates, posts, studs, braces).
// `avoid` = list of u-centres (windows/door) that studs must not cross.
function addFraming(fg, matTimber, width, height, yBase, avoid = [], braces = true) {
  const d = 0.095; // timber depth
  const p = 0.055; // protrusion of timber centre from wall plane
  const add = (bw, bh, u, v, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), matTimber);
    m.position.set(u, v, p);
    m.rotation.z = rz;
    fg.add(m);
  };
  add(width, 0.15, 0, yBase + 0.075); // sill plate
  add(width, 0.13, 0, yBase + height - 0.065); // top plate
  add(0.15, height, -(width / 2 - 0.075), yBase + height / 2); // corner posts
  add(0.15, height, width / 2 - 0.075, yBase + height / 2);
  const n = Math.max(0, Math.floor(width / 1.35) - 1);
  for (let i = 1; i <= n; i++) {
    const u = -width / 2 + (i * width) / (n + 1);
    if (avoid.some((a) => Math.abs(u - a) < 0.78)) continue;
    add(0.1, height - 0.26, u, yBase + height / 2);
  }
  if (braces && width > 2.6) {
    if (!avoid.some((a) => Math.abs(-(width / 2 - 0.72) - a) < 0.85))
      add(0.09, 1.3, -(width / 2 - 0.72), yBase + 0.72, 0.55);
    if (!avoid.some((a) => Math.abs(width / 2 - 0.72 - a) < 0.85))
      add(0.09, 1.3, width / 2 - 0.72, yBase + 0.72, -0.55);
  }
}

// Leaded window, centre-origin, facing local +Z.
function makeWindow(w, h, mats, lit, shutters) {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), lit ? mats.glassLit : mats.glass);
  g.add(glass);
  const f = 0.08;
  const frame = (bw, bh, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.12), mats.timber);
    m.position.set(x, y, 0.035);
    g.add(m);
  };
  frame(w + 2 * f, f, 0, h / 2 + f / 2);
  frame(w + 2 * f, f, 0, -h / 2 - f / 2);
  frame(f, h, -w / 2 - f / 2, 0);
  frame(f, h, w / 2 + f / 2, 0);
  const mull = (bw, bh) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.03), mats.timber);
    m.position.z = 0.035;
    g.add(m);
  };
  mull(0.045, h);
  mull(w, 0.045);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.24, 0.07, 0.18), mats.stone);
  sill.position.set(0, -h / 2 - f - 0.035, 0.05);
  g.add(sill);
  if (shutters) {
    for (const s of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.48, h * 0.98, 0.045), mats.trim);
      sh.position.set(s * (w / 2 + f + w * 0.24 + 0.02), 0, 0.02);
      g.add(sh);
    }
  }
  return g;
}

// Plank door with jambs + lintel, origin at bottom-centre, facing +Z.
function makeDoor(w, h, mats) {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), mats.door);
  slab.position.set(0, h / 2, 0);
  g.add(slab);
  for (const x of [-w / 6, w / 6]) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.03, h - 0.12, 0.02), mats.timber);
    groove.position.set(x, h / 2, 0.045);
    g.add(groove);
  }
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.13, h, 0.15), mats.timber);
    jamb.position.set(s * (w / 2 + 0.065), h / 2, 0.05);
    g.add(jamb);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.42, 0.15, 0.17), mats.timber);
  lintel.position.set(0, h + 0.075, 0.05);
  g.add(lintel);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), mats.iron);
  handle.position.set(w / 2 - 0.16, h * 0.47, 0.06);
  g.add(handle);
  return g;
}

export function createHouse({ seed = 1, width, depth, stories } = {}) {
  const rng = mulberry32((seed * 2654435761) >>> 0 || 1);
  const group = new THREE.Group();

  // ---- parameters -------------------------------------------------------
  const W = width ?? R(rng, 5.2, 7.6);
  const D = depth ?? R(rng, 4.3, 5.9);
  const nStories = stories ?? (rng() < 0.42 ? 2 : 1);
  const storyH = R(rng, 2.3, 2.55);
  const plinthH = 0.45;
  const pitch = R(rng, 0.62, 0.82); // roof angle, rad
  const jetty = nStories > 1 ? 0.36 : 0;

  const mats = {
    plaster: std(pick(rng, PLASTERS), 0.95),
    timber: std(pick(rng, TIMBERS), 0.78),
    stone: std(pick(rng, STONES), 0.96),
    roof: null,
    trim: std(pick(rng, TRIMS), 0.75),
    door: null,
    iron: std(0x2b2b2e, 0.45, 0.65),
    glass: std(0x232830, 0.3, 0.55),
    glassLit: std(0x2a2016, 0.4, 0.1, { emissive: 0xff9c4a, emissiveIntensity: 0.55 }),
  };
  const roofC = new THREE.Color(pick(rng, ROOFS));
  mats.roof = std(roofC.getHex(), 0.92);
  mats.roofDark = std(roofC.clone().multiplyScalar(0.82).getHex(), 0.92);
  mats.door = rng() < 0.5 ? mats.trim : std(0x5c4128, 0.8);

  const stoneGround = nStories > 1 ? rng() < 0.45 : rng() < 0.2;

  // Footprints per story (upper story jettied out slightly).
  const fw = [W], fd = [D];
  if (nStories > 1) { fw.push(W + jetty); fd.push(D + jetty); }
  const Wt = fw[fw.length - 1], Dt = fd[fd.length - 1];
  const wallTop = plinthH + nStories * storyH;
  const rise = Math.tan(pitch) * (Dt / 2);
  const ridgeY = wallTop + rise;

  // ---- plinth ------------------------------------------------------------
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, plinthH + 0.04, D + 0.2), mats.stone);
  plinth.position.y = (plinthH + 0.04) / 2 - 0.04;
  group.add(plinth);

  // ---- storey walls ------------------------------------------------------
  for (let s = 0; s < nStories; s++) {
    const wallMat = s === 0 && stoneGround ? mats.stone : mats.plaster;
    const box = new THREE.Mesh(new THREE.BoxGeometry(fw[s], storyH, fd[s]), wallMat);
    box.position.y = plinthH + s * storyH + storyH / 2;
    group.add(box);
  }
  if (nStories > 1) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(Wt + 0.1, 0.17, Dt + 0.1), mats.timber);
    beam.position.y = plinthH + storyH;
    group.add(beam);
  }

  // ---- gable triangles (on ±X ends of the top footprint) -----------------
  const tri = new THREE.Shape();
  tri.moveTo(-Dt / 2, 0);
  tri.lineTo(Dt / 2, 0);
  tri.lineTo(0, rise);
  tri.closePath();
  const gGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.18, bevelEnabled: false });
  for (const side of [1, -1]) {
    const gm = new THREE.Mesh(gGeo, mats.plaster);
    gm.rotation.y = Math.PI / 2; // shape plane -> ZY, extrusion along +X
    gm.position.set(side > 0 ? Wt / 2 - 0.18 : -Wt / 2, wallTop, 0);
    group.add(gm);
  }

  // ---- roof: two slabs with shingle course lines + ridge + fascia --------
  const ovX = 0.48, ovZ = 0.5;
  const A = pitch;
  const slopeLen = (Dt / 2 + ovZ) / Math.cos(A);
  const roofLenX = Wt + 2 * ovX;
  const eaveY = wallTop - Math.tan(A) * ovZ;
  for (const side of [1, -1]) {
    const slab = new THREE.Group();
    slab.rotation.x = side * A;
    slab.position.set(
      0,
      (ridgeY + eaveY) / 2 + 0.07 * Math.cos(A),
      side * ((Dt / 2 + ovZ) / 2 + 0.07 * Math.sin(A))
    );
    const main = new THREE.Mesh(new THREE.BoxGeometry(roofLenX, 0.13, slopeLen), mats.roof);
    slab.add(main);
    for (let z = -slopeLen / 2 + 0.5; z < slopeLen / 2 - 0.15; z += 0.62) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(roofLenX + 0.04, 0.05, 0.17), mats.roofDark);
      strip.position.set(0, 0.085, z);
      slab.add(strip);
    }
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(roofLenX, 0.17, 0.06), mats.timber);
    fascia.position.set(0, -0.03, slopeLen / 2 - 0.03);
    slab.add(fascia);
    group.add(slab);
  }
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(roofLenX + 0.06, 0.13, 0.36), mats.roofDark);
  ridge.position.y = ridgeY + 0.1;
  group.add(ridge);

  // ---- openings + framing, storey by storey -------------------------------
  const inner = W / 2 - 1.05;
  const nSlots = Math.max(2, Math.round(W / 2.0));
  const slots = [];
  for (let i = 0; i < nSlots; i++)
    slots.push(nSlots === 1 ? 0 : -inner + (i * 2 * inner) / (nSlots - 1));
  const doorIdx = Math.floor(rng() * nSlots);
  const doorW = 1.0, doorH = 2.05;

  for (let s = 0; s < nStories; s++) {
    const yBase = plinthH + s * storyH;
    const isStone = s === 0 && stoneGround;
    const shuttersHere = rng() < 0.55;

    // Front (+Z)
    const front = facade(group, "z", 1, fd[s] / 2);
    const frontAvoid = [];
    for (let i = 0; i < nSlots; i++) {
      const u = slots[i];
      if (s === 0 && i === doorIdx) {
        const door = makeDoor(doorW, doorH, mats);
        door.position.set(u, yBase, 0.02);
        front.add(door);
        // small pent-roof awning over some doors
        if (rng() < 0.55) {
          const aw = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.7, 0.07, 0.62), mats.roofDark);
          aw.position.set(u, yBase + doorH + 0.34, 0.3);
          aw.rotation.x = 0.42;
          front.add(aw);
        }
        frontAvoid.push(u);
      } else if (rng() < 0.85) {
        const win = makeWindow(s === 0 ? 0.85 : 0.8, s === 0 ? 1.05 : 0.95, mats, rng() < 0.3, shuttersHere && rng() < 0.7);
        win.position.set(u, yBase + storyH * 0.55, 0.03);
        front.add(win);
        frontAvoid.push(u);
      }
    }
    if (!isStone) addFraming(front, mats.timber, fw[s], storyH, yBase, frontAvoid);

    // Back (-Z)
    const back = facade(group, "z", -1, fd[s] / 2);
    const backAvoid = [];
    for (const u of [-inner * 0.55, inner * 0.55]) {
      if (rng() < 0.7) {
        const win = makeWindow(0.75, 0.9, mats, rng() < 0.2, false);
        win.position.set(u, yBase + storyH * 0.55, 0.03);
        back.add(win);
        backAvoid.push(u);
      }
    }
    if (!isStone) addFraming(back, mats.timber, fw[s], storyH, yBase, backAvoid);

    // Gable-end walls (±X)
    for (const side of [1, -1]) {
      const end = facade(group, "x", side, fw[s] / 2);
      const endAvoid = [];
      if (rng() < 0.5) {
        const win = makeWindow(0.7, 0.85, mats, rng() < 0.25, false);
        win.position.set(R(rng, -0.6, 0.6), yBase + storyH * 0.55, 0.03);
        end.add(win);
        endAvoid.push(win.position.x);
      }
      if (!isStone) addFraming(end, mats.timber, fd[s], storyH, yBase, endAvoid);
    }
  }

  // ---- gable trim + attic windows ----------------------------------------
  for (const side of [1, -1]) {
    const end = facade(group, "x", side, Wt / 2);
    // king post + collar (only reads well against plaster)
    const king = new THREE.Mesh(new THREE.BoxGeometry(0.1, Math.max(0.2, rise - 0.14), 0.095), mats.timber);
    king.position.set(0, wallTop + (rise - 0.14) / 2 + 0.02, 0.05);
    end.add(king);
    const collarW = Dt * (1 - 0.42) * 0.92;
    const collar = new THREE.Mesh(new THREE.BoxGeometry(collarW, 0.1, 0.095), mats.timber);
    collar.position.set(0, wallTop + rise * 0.42, 0.05);
    end.add(collar);
    if (rng() < 0.7) {
      const win = makeWindow(0.55, 0.6, mats, rng() < 0.35, false);
      win.position.set(0.32 * pick(rng, [-1, 1]), wallTop + rise * 0.3, 0.03);
      end.add(win);
    }
  }

  // ---- doorstep ------------------------------------------------------------
  const step = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.5, 0.5, 0.6), mats.stone);
  step.position.set(slots[doorIdx], 0.2, fd[0] / 2 + 0.22);
  group.add(step);

  // ---- chimney -------------------------------------------------------------
  if (rng() < 0.92) {
    const side = pick(rng, [1, -1]);
    const cz = R(rng, -0.4, 0.4);
    const cx = side * (Wt / 2 + 0.12);
    const chH = ridgeY + R(rng, 0.6, 0.95);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.95, Math.min(1.9, chH * 0.4), 0.95), mats.stone);
    base.position.set(cx, Math.min(1.9, chH * 0.4) / 2, cz);
    group.add(base);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.72, chH, 0.72), mats.stone);
    shaft.position.set(cx, chH / 2, cz);
    group.add(shaft);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.14, 1.0), mats.stone);
    cap.position.set(cx, chH + 0.07, cz);
    group.add(cap);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.32, 10), std(0x6a4436, 0.9));
    pot.position.set(cx, chH + 0.3, cz);
    group.add(pot);
  }

  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}
