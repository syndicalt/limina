// ---------------------------------------------------------------------------
// village-layout — the PURE, terrain-aware settlement LAYOUT planner.
//
//   const { placements, center } = planVillage(sampler, direction, steering, radii);
//
// This is the shared brain both consumers run so there is ONE layout algorithm and
// no drift between them:
//   • tools/preview/assets/village.mjs (preview) authors THREE geometry at these
//     transforms — it passes each builder's userData.radius as the footprint radii.
//   • js/src/skills/village.ts (engine skill) places library GLBs at these transforms
//     — it passes each asset's GLB footprint radius (from its card boundsM).
//
// NOTHING about setting/architecture lives here — WHAT/HOW come from steering/direction
// upstream; this module only decides WHERE (and which way each building faces) by
// reading the terrain through a small SAMPLER contract:
//   sampler = { heightAt(x,z), slopeAt(x,z), halfSize, seaLevel, amplitude }.
//
// PURE: no THREE, no DOM, no geometry, no lane/pad authoring — just arithmetic over
// the sampler + steering. It is a DETERMINISTIC function of (sampler, steering, radii):
// the layout has no stochastic step, so the same inputs always yield the same
// placements (proven by js/test/p76_village_layout_determinism.ts). The seeded RNG
// primitives (mulberry32 + FNV-1a) are kept + exported for the skill layer's seed
// derivation; the placement math itself needs no random draw.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------- determinism
// A single mulberry32 stream seeded from a FNV-1a hash of the inputs — the shared
// deterministic seed primitive. The layout is already a pure function of the terrain
// + steering (no random draw), so these are exported for the engine skill to derive a
// stable seed for its recorded request; injecting randomness here would change the
// committed preview layout, so the placement math deliberately does not draw from it.
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------ terrain survey
// Sample the map into buildable candidate sites (above sea, not too steep), with a
// local-flatness measure for terracing decisions. Reads ONLY the sampler contract.
function surveySites(s, relax = 1) {
  const H = s.halfSize;
  const sea = s.seaLevel ?? 0;
  const step = clamp(H / 44, 3, 12);
  const maxSlope = 0.28 * relax;
  const out = [];
  for (let x = -H * 0.84; x <= H * 0.84; x += step) {
    for (let z = -H * 0.84; z <= H * 0.84; z += step) {
      const h = s.heightAt(x, z);
      if (h <= sea + 1.5) continue;
      const sl = s.slopeAt(x, z);
      if (sl > maxSlope) continue;
      // local flatness = worst slope in a small ring around the site
      let flat = sl;
      for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
        flat = Math.max(flat, s.slopeAt(x + dx, z + dz));
      }
      out.push({ x, z, h, flat });
    }
  }
  return out;
}

// Downhill direction at a point (unit XZ {x,z}), from finite differences.
function downhill(s, x, z) {
  const e = 2.5;
  const gx = s.heightAt(x + e, z) - s.heightAt(x - e, z);
  const gz = s.heightAt(x, z + e) - s.heightAt(x, z - e);
  let vx = -gx, vz = -gz;
  if (vx * vx + vz * vz > 1e-6) {
    const len = Math.sqrt(vx * vx + vz * vz);
    vx /= len; vz /= len;
  } else {
    vx = 0; vz = 1;
  }
  return { x: vx, z: vz };
}

// ------------------------------------------------------------------- layout

// steering.layout.density → minimum clear spacing between buildings (m).
function spacingFor(density) {
  const d = String(density ?? "").toLowerCase();
  if (/dense|tight|packed/.test(d)) return 8;
  if (/loose|sparse|scatter/.test(d)) return 18;
  return 12;
}

// Which role is focal, and does the wording ask for high ground? Read from
// steering.layout.focal — no role names are assumed.
export function parseFocal(steering) {
  const txt = String(steering?.layout?.focal ?? "").toLowerCase();
  const roles = (steering?.buildings ?? []).map((b) => String(b.role ?? ""));
  const focalRole = roles.find((r) => r && txt.includes(r.toLowerCase())) ?? roles[0] ?? null;
  const wantsHigh = /high|knoll|hill|summit|ridge|overlook|crag/.test(txt);
  return { focalRole, wantsHigh };
}

function farEnough(site, placed, minGap) {
  for (const p of placed) {
    const d = Math.hypot(site.x - p.x, site.z - p.z);
    if (d < Math.max(minGap, p.r + site.r + 3)) return false;
  }
  return true;
}

// Greedy best-scoring site pick with progressive constraint relaxation so a harsh
// map still seats every building.
function pickSite(cands, placed, radius, minGap, score) {
  for (let relax = 0; relax < 6; relax++) {
    const gap = minGap * (1 - relax * 0.13);
    let best = null, bestS = -Infinity;
    for (const c of cands) {
      const s = { ...c, r: radius };
      if (!farEnough(s, placed, gap)) continue;
      const sc = score(c, relax);
      if (sc > bestS) { bestS = sc; best = s; }
    }
    if (best) return best;
  }
  return null;
}

// ------------------------------------------------------------ authored anchors
// THE RULE (map-driven placement): an anchor PINS WHERE a building goes; the solver still
// decides HOW (facing, terrace order, cluster spread). siteNearAnchor runs the SAME
// buildability checks surveySites uses (above sea level + slope) but scoped to a small
// local search around the authored (ax,az) instead of the whole map — a spiral of rings
// out to `maxR`, biased toward a target distance band (clusters) or simply the closest
// buildable point (a lone pin). Mutual non-overlap with anything already placed (earlier
// anchors, cluster mates) is enforced via the SAME farEnough() the map-wide solver uses, so
// a cluster's members are guaranteed non-overlapping via their own footprint radii. Returns
// null (never a relocated/guessed site) when nothing buildable exists within maxR — the
// caller is expected to fail loudly, naming the anchor, rather than silently moving it.
function siteNearAnchor(sampler, ax, az, radius, maxR, placed, preferBand) {
  const sea = sampler.seaLevel ?? 0;
  for (let relax = 0; relax < 4; relax++) {
    // Same slope discipline as surveySites' `maxSlope = 0.28 * relax`, progressively relaxed —
    // the SEARCH RADIUS never grows (that would drift away from the authored pin); only the
    // terrain tolerance eases, exactly like the map-wide solver's own relaxation.
    const maxSlope = 0.28 * (1 + relax * 0.6);
    let best = null, bestScore = -Infinity;
    const ringSteps = 14;
    for (let ring = 0; ring <= ringSteps; ring++) {
      const r = (ring / ringSteps) * maxR;
      const angSteps = ring === 0 ? 1 : Math.max(6, Math.round(4 + ring * 1.6));
      for (let i = 0; i < angSteps; i++) {
        // Stagger each ring's phase so sample points don't align radially ring-to-ring.
        const theta = (i / angSteps) * Math.PI * 2 + ring * 0.37;
        const x = ax + r * Math.cos(theta);
        const z = az + r * Math.sin(theta);
        const h = sampler.heightAt(x, z);
        if (h <= sea + 1.5) continue;
        const sl = sampler.slopeAt(x, z);
        if (sl > maxSlope) continue;
        const site = { x, z, h, r: radius };
        if (!farEnough(site, placed, 0)) continue;
        const dist = Math.hypot(x - ax, z - az);
        // Clusters (preferBand=[lo,hi]) bias toward a spread band around the anchor; a lone pin
        // (preferBand=null) simply prefers the closest buildable point to its authored position.
        const bandScore = preferBand
          ? (dist < preferBand[0] ? -(preferBand[0] - dist) : dist > preferBand[1] ? -(dist - preferBand[1]) : 1)
          : -dist * 0.1;
        const sc = bandScore - sl * 2;
        if (sc > bestScore) { bestScore = sc; best = site; }
      }
    }
    if (best) return best;
  }
  return null;
}

// Nearest-neighbour chain starting at the focal (placed[0]) — the SAME order the
// preview lane threads, so chain-derived facing agrees with the drawn lane.
function chainFrom(placed) {
  if (placed.length === 0) return [];
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

/**
 * Plan a terrain-aware settlement.
 *
 * @param {{ heightAt:(x:number,z:number)=>number, slopeAt:(x:number,z:number)=>number,
 *           halfSize:number, seaLevel:number, amplitude:number }} sampler
 * @param {object} direction  Art direction (flavors materials upstream; not read here).
 * @param {object} steering    { buildings:[{ role, style, count }], layout:{ focal, density } }
 * @param {number[]} radii     Footprint radius PER INSTANCE, in the same order steering
 *                             expands (spec-by-spec, count times). `placements[k].index`
 *                             indexes this array.
 * @param {Array<{id:string, position:[number,number], instanceIndices:number[]}>} [anchors]
 *                             Authored placement pins (already resolved to instance indices by the
 *                             caller — this module stays agnostic of assetId/role matching). THE
 *                             RULE: an anchor pins WHERE; this solver still decides HOW (facing,
 *                             terrace order). `instanceIndices.length > 1` = a tight cluster sited
 *                             around the SAME anchor. Throws (naming the anchor id/position) if no
 *                             buildable site exists within its local search radius — never silently
 *                             relocated.
 * @returns {{ placements: Array<{role:string,style:string,index:number,x:number,z:number,yaw:number,anchorId?:string}>,
 *             center: {x:number,z:number} }}
 *          placements[0] is always the focal building (even when the focal itself is anchored).
 */
export function planVillage(sampler, direction, steering, radii, anchors) {
  void direction; // layout is driven by terrain + steering; direction only flavors materials

  // -- 1) Expand steering.buildings into concrete instances (spec-by-spec, count
  //       times) — the SAME order `radii` is provided in.
  const { focalRole, wantsHigh } = parseFocal(steering);
  const specs = steering?.buildings ?? [];
  const instances = [];
  specs.forEach((spec, listIndex) => {
    const count = Math.max(1, spec.count ?? 1);
    for (let i = 0; i < count; i++) {
      const index = instances.length;
      instances.push({
        role: spec.role, style: spec.style, listIndex, count, index,
        radius: (radii && radii[index] !== undefined) ? radii[index] : 6,
        focal: spec.role === focalRole && i === 0,
      });
    }
  });
  if (instances.length === 0) return { placements: [], center: { x: 0, z: 0 } };

  // -- 2) Survey buildable ground (relax the slope constraint if the map is harsh).
  let cands = surveySites(sampler, 1);
  if (cands.length < instances.length * 4) cands = surveySites(sampler, 1.5);
  if (cands.length === 0) return { placements: [], center: { x: 0, z: 0 } };
  const hMin = Math.min(...cands.map((c) => c.h));
  const hMax = Math.max(...cands.map((c) => c.h));
  const hSpan = Math.max(1, hMax - hMin);
  const spacing = spacingFor(steering?.layout?.density);
  const placed = []; // [{x,z,h,r,inst,anchorId?}]

  // -- 2.5) ANCHORS: site every anchored instance FIRST, at/near its authored position, before the
  //         map-wide solver runs. A lone pin (instanceIndices.length===1) searches ≤8 m for the
  //         closest buildable spot; a cluster (>1) searches ≤16 m, biasing each member into a 6–14 m
  //         band around the anchor while staying mutually non-overlapping (farEnough, shared with
  //         the solver below) with the anchor's own earlier members AND anything else already
  //         placed. Once anchored instances occupy `placed`, every subsequent pickSite() call below
  //         (focal/singles/cluster/edge) automatically avoids their footprints via the same
  //         farEnough() check — no separate "occupied" plumbing needed.
  const anchoredIdx = new Set();
  if (Array.isArray(anchors) && anchors.length > 0) {
    // Flatten to (anchor, instance) pairs and site LARGEST footprints first: a church with an
    // 11.7m footprint radius must claim its ground before 4.4m cottages hem it in — anchor
    // iteration order must never decide whether a big building fits.
    const jobs = [];
    for (const a of anchors) {
      const isCluster = a.instanceIndices.length > 1;
      for (const idx of a.instanceIndices) {
        const inst = instances[idx];
        if (inst === undefined) continue; // defensive: caller-resolved index out of range
        jobs.push({ a, idx, inst, isCluster });
      }
    }
    jobs.sort((x, y) => y.inst.radius - x.inst.radius || x.idx - y.idx); // radius desc, idx tiebreak (deterministic)
    for (const { a, idx, inst, isCluster } of jobs) {
      const [ax, az] = a.position;
      // The search radius scales with the building's OWN footprint: a fixed 8m can never site a
      // building whose footprint radius exceeds 8m (the map-proof monastery: church r≈11.7m).
      // Shifting ≤1.25× its own radius still reads as "at the anchor" on the map.
      const maxR = Math.max(isCluster ? 16 : 8, inst.radius * 1.25);
      const site = siteNearAnchor(sampler, ax, az, inst.radius, maxR, placed, isCluster ? [6, 14] : null);
      if (site === null) {
        throw new Error(
          `village.build: anchor '${a.id}' at [${ax}, ${az}] has no buildable site within ${maxR.toFixed(1)} m ` +
          `(footprint r=${inst.radius.toFixed(1)}m; sea level / slope reject, or footprint overlap) — refusing to silently relocate it`,
        );
      }
      site.inst = inst;
      site.anchorId = a.id;
      anchoredIdx.add(idx);
      placed.push(site);
    }
  }

  // -- 3) Focal building: the wording of steering.layout.focal decides the terrain
  //       preference — "high/knoll/…" biases hard toward elevated flat ground;
  //       otherwise central flat ground wins. If the focal itself was already sited by an
  //       anchor above, keep that site (an anchor pins WHERE even for the focal).
  const focalInst = instances.find((i) => i.focal) ?? instances[0];
  let focalSite = placed.find((p) => p.inst === focalInst);
  if (focalSite === undefined) {
    focalSite = pickSite(cands, placed, focalInst.radius, 0, (c, relax) => {
      const hN = (c.h - hMin) / hSpan;
      const flatness = 1 - Math.min(1, c.flat / (0.22 + relax * 0.05));
      const centrality = 1 - Math.hypot(c.x, c.z) / sampler.halfSize;
      return (wantsHigh ? hN * 2.2 : centrality * 0.8) + flatness * 1.4;
    });
    if (focalSite === null) return { placements: [], center: { x: 0, z: 0 } };
    focalSite.inst = focalInst;
    placed.push(focalSite);
  }
  // Keep the documented invariant "placements[0] is the focal" even when it was anchored — an
  // anchored focal may have landed anywhere in `placed` depending on anchor processing order.
  {
    const fi = placed.indexOf(focalSite);
    if (fi > 0) { placed.splice(fi, 1); placed.unshift(focalSite); }
  }

  // Placement ordering, derived from the steering list itself (role-agnostic):
  //   • singles (count==1) earlier in the list = closer to the focal (civic);
  //   • multi-count entries form the terraced cluster below the focal;
  //   • the LAST single is pushed to the settlement edge (out past the cluster).
  // Anchored (non-focal) instances are excluded here — they were already sited above, and already
  // occupy `placed` so the solver's own pickSite() calls avoid them.
  const singles = instances.filter((i) => !i.focal && i.count === 1 && !anchoredIdx.has(i.index));
  const cluster = instances.filter((i) => !i.focal && i.count > 1 && !anchoredIdx.has(i.index));
  const edgeSingle = singles.length > 1 || cluster.length ? singles.pop() : null;

  // -- 3a) Inner singles: good flat ground on a ring just below the focal.
  singles.forEach((inst, rank) => {
    const target = focalInst.radius + inst.radius + spacing * (1.2 + rank * 0.9);
    const site = pickSite(cands, placed, inst.radius, spacing, (c, relax) => {
      const d = Math.hypot(c.x - focalSite.x, c.z - focalSite.z);
      const ring = 1 - Math.min(1, Math.abs(d - target) / (spacing * (1.5 + relax)));
      const flatness = 1 - Math.min(1, c.flat / 0.18);
      const below = c.h <= focalSite.h ? 0.4 : 0; // sit below the focal
      return ring * 1.2 + flatness * 1.5 + below;
    });
    if (site) { site.inst = inst; placed.push(site); }
  });

  // -- 3b) The cluster (e.g. dwellings): terraced along a CONTOUR BAND below the
  //        focal — flattest pockets near one target elevation, real gaps enforced
  //        by the density spacing.
  const bandH = focalSite.h - hSpan * 0.3; // the terrace contour to follow
  const bandTol = Math.max(2.5, (sampler.amplitude ?? hSpan) * 0.06);
  const dMin = focalInst.radius + spacing * 1.2;
  const dMax = Math.min(sampler.halfSize * 0.78, dMin + spacing * (cluster.length + 2));
  for (const inst of cluster) {
    const site = pickSite(cands, placed, inst.radius, spacing, (c, relax) => {
      const d = Math.hypot(c.x - focalSite.x, c.z - focalSite.z);
      if (d < dMin || d > dMax * (1 + relax * 0.15)) return -Infinity;
      const onBand = 1 - Math.min(1, Math.abs(c.h - bandH) / (bandTol * (1 + relax)));
      const flatness = 1 - Math.min(1, c.flat / 0.16);
      // mild pull toward already-placed cluster mates → a connected terrace,
      // (spacing keeps it from clumping)
      let near = 0;
      for (const p of placed) {
        if (p.inst && p.inst.count > 1) {
          near = Math.max(near, 1 - Math.min(1, Math.hypot(c.x - p.x, c.z - p.z) / (spacing * 3)));
        }
      }
      return onBand * 1.6 + flatness * 1.8 + near * 0.5;
    });
    if (site) { site.inst = inst; placed.push(site); }
  }

  // -- 3c) The edge single (e.g. an outbuilding): beyond the cluster extent.
  if (edgeSingle) {
    const clusterMax = placed
      .filter((p) => p.inst?.count > 1)
      .reduce((m, p) => Math.max(m, Math.hypot(p.x - focalSite.x, p.z - focalSite.z)), dMin);
    const target = clusterMax + spacing * 1.4;
    const site = pickSite(cands, placed, edgeSingle.radius, spacing, (c, relax) => {
      const d = Math.hypot(c.x - focalSite.x, c.z - focalSite.z);
      const ring = 1 - Math.min(1, Math.abs(d - target) / (spacing * (2 + relax)));
      const flatness = 1 - Math.min(1, c.flat / 0.2);
      return ring * 1.4 + flatness * 1.4;
    });
    if (site) { site.inst = edgeSingle; placed.push(site); }
  }

  // -- 4) Settlement center (average of the placed footprints).
  let cx = 0, cz = 0;
  for (const p of placed) { cx += p.x; cz += p.z; }
  cx /= placed.length; cz /= placed.length;
  const center = { x: cx, z: cz };

  // -- 5) Facing (yaw about +Y so a building's local +Z front faces its target):
  //         • the focal looks out over the settlement center;
  //         • everyone else fronts the lane. The lane runs just outside each
  //           footprint toward the midpoint of its chain neighbours, so a building's
  //           nearest lane point IS that outward waypoint — i.e. it faces the
  //           midpoint of its neighbours. This is the pure form of the preview's
  //           "front the nearest lane sample" (which sampled that same curve).
  //         • degenerate → fall back to downhill.
  const chain = chainFrom(placed);
  const yawOf = (p) => {
    let fx = 0, fz = 0;
    if (p.inst.focal) {
      fx = center.x - p.x; fz = center.z - p.z;
    } else if (chain.length >= 2) {
      const i = chain.indexOf(p);
      const prev = chain[Math.max(0, i - 1)];
      const next = chain[Math.min(chain.length - 1, i + 1)];
      fx = (prev.x + next.x) / 2 - p.x;
      fz = (prev.z + next.z) / 2 - p.z;
    }
    if (fx * fx + fz * fz < 1e-6) { const d = downhill(sampler, p.x, p.z); fx = d.x; fz = d.z; }
    return Math.atan2(fx, fz);
  };

  const placements = placed.map((p) => ({
    role: p.inst.role, style: p.inst.style, index: p.inst.index,
    x: p.x, z: p.z, yaw: yawOf(p),
    ...(p.anchorId !== undefined ? { anchorId: p.anchorId } : {}),
  }));
  return { placements, center };
}
