// PIPELINE STAGE 6 — STRUCTURES (terrain-aware place + SUBTRACTIVE clear). A BEST-EFFORT default (an
// agent can override this whole stage — it is not locked logic): civilization settles a flat-ish
// coastal area, and instead of a rigid circle, houses take the FLATTEST pockets within that area,
// spaced apart, each ORIENTED to face downhill — so a hillside village follows the terrain. Reuses
// the exported library asset (tier-2). Returns footprints so the composer clears the vegetation it lands on.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Deterministic scan for the general village AREA — a flat shelf a few metres above sea level. */
function findVillageArea(terrain) {
  const half = terrain.halfSize, sea = terrain.config.seaLevelM;
  let best = { x: 0, z: 0, y: sea + 3 }, bestScore = 1e9;
  for (let z = -half * 0.72; z <= half * 0.72; z += 4) for (let x = -half * 0.72; x <= half * 0.72; x += 4) {
    const y = terrain.heightAt(x, z);
    if (y < sea + 1.2 || y > sea + 8) continue;
    let slope = 0, n = 0;
    for (let dz = -12; dz <= 12; dz += 6) for (let dx = -12; dx <= 12; dx += 6) { slope += terrain.slopeAt(x + dx, z + dz); n++; }
    slope /= n;
    const score = slope * 12 + Math.abs(y - (sea + 3));
    if (score < bestScore) { bestScore = score; best = { x, z, y }; }
  }
  return best;
}

export async function generateStructures(terrain, opts = {}) {
  const proto = (await new GLTFLoader().loadAsync("/assets/library/medieval-house.glb")).scene;
  const sea = terrain.config.seaLevelM;
  const area = opts.center ?? findVillageArea(terrain);
  // Spread the hamlet: houses want real gaps (yards) between them, over a wider settling area — a
  // village isn't a row of touching buildings. minSpacing >> house width (~8.5m).
  const regionR = opts.regionR ?? 34, minSpacing = opts.minSpacing ?? 19, want = opts.count ?? 6;
  const rng = mulberry32(opts.seed ?? 91);

  // Candidate pockets within the area, scored by LOCAL FLATNESS.
  const cands = [];
  for (let z = area.z - regionR; z <= area.z + regionR; z += 3) for (let x = area.x - regionR; x <= area.x + regionR; x += 3) {
    if (Math.hypot(x - area.x, z - area.z) > regionR) continue;
    const y = terrain.heightAt(x, z);
    if (y < sea + 0.9) continue;                 // not in / at the water
    let s = 0, n = 0;
    for (let dz = -6; dz <= 6; dz += 3) for (let dx = -6; dx <= 6; dx += 3) { s += terrain.slopeAt(x + dx, z + dz); n++; }
    s /= n;
    if (s > 0.55) continue;                       // too steep to build on
    cands.push({ x, z, y, flat: s + rng() * 0.02 }); // tiny jitter breaks ties deterministically
  }
  cands.sort((a, b) => a.flat - b.flat);          // flattest first

  // Greedily settle houses on the flattest pockets, keeping them spaced apart.
  const houses = [], footprints = [], placed = [];
  for (const c of cands) {
    if (placed.length >= want) break;
    if (placed.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < minSpacing)) continue;
    // Orient to face DOWNHILL (a hillside dwelling faces down the slope toward the light/water).
    const gx = terrain.heightAt(c.x + 2, c.z) - terrain.heightAt(c.x - 2, c.z);
    const gz = terrain.heightAt(c.x, c.z + 2) - terrain.heightAt(c.x, c.z - 2);
    const yaw = (Math.abs(gx) + Math.abs(gz) > 0.05 ? Math.atan2(-gx, -gz) : rng() * Math.PI * 2) + (rng() - 0.5) * 0.4;
    const h = proto.clone(true);
    h.position.set(c.x, c.y, c.z); h.rotation.y = yaw;
    h.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    houses.push(h); footprints.push({ x: c.x, z: c.z, r: 7 }); placed.push(c);
  }
  return { houses, footprints, center: area };
}
