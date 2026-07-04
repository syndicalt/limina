// PIPELINE STAGE 5 — VEGETATION (climate- + terrain- + water-aware). Nature grows the forest: a small
// POOL of unique ez-trees (the tailored skill) is CLONED across the terrain (field tier — cheap +
// varied), only where the ground is valid: above the shoreline (not in water), below the tree line
// (not on snow peaks), not too steep. Species mix + foliage STATE (green/autumn/bare) come from the
// climate stage. Returns positioned trees + their (x,z) so the STRUCTURES stage can clear its footprint.
import * as THREE from "three";
import { Tree } from "@dgreenheck/ez-tree";

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeProto(kind, preset, seed, climate, rng) {
  const t = new Tree();
  t.loadPreset(preset);
  t.options.seed = seed;
  t.generate();
  // foliage STATE for deciduous trees (from climate).
  if (kind === "deciduous" && t.leavesMesh) {
    if (climate.deciduousState === "bare") t.leavesMesh.visible = false;
    else if (climate.deciduousState === "autumn") { t.leavesMesh.material = t.leavesMesh.material.clone(); t.leavesMesh.material.color.setHex(climate.autumnTints[Math.floor(rng() * climate.autumnTints.length)]); }
  }
  t.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  const box = new THREE.Box3().setFromObject(t);
  return { group: t, baseH: (box.max.y - box.min.y) || 1 };
}

export function generateVegetation(terrain, climate, opts = {}) {
  const cfg = terrain.config, half = terrain.halfSize, sea = cfg.seaLevelM, amp = cfg.amplitude;
  const treeLine = amp * climate.treeLineFrac;
  const rng = mulberry32(opts.seed ?? 2025);

  // Prototype pool: a handful of unique conifers + deciduous; cloned across the map.
  const conifers = [], deciduous = [];
  for (let i = 0; i < 4; i++) conifers.push(makeProto("conifer", rng() < 0.5 ? "Pine Large" : "Pine Medium", 100 + i * 13, climate, rng));
  for (let i = 0; i < 3; i++) deciduous.push(makeProto("deciduous", rng() < 0.5 ? "Oak Large" : "Aspen Large", 500 + i * 13, climate, rng));

  const trees = [];
  const attempts = Math.floor(420 * climate.density01);
  for (let i = 0; i < attempts; i++) {
    const x = (rng() * 2 - 1) * half * 0.94, z = (rng() * 2 - 1) * half * 0.94;
    const y = terrain.heightAt(x, z);
    if (y < sea + 0.8) continue;                 // in / at the water
    if (y > treeLine) continue;                  // above the tree line (snow)
    if (terrain.slopeAt(x, z) > 0.85) continue;  // too steep (cliff)
    // thin out toward the tree line for a natural upper edge
    if (rng() < (y - sea) / (treeLine - sea) * 0.35) continue;
    const wantConifer = rng() < climate.coniferShare;
    const pool = wantConifer ? conifers : deciduous;
    const proto = pool[Math.floor(rng() * pool.length)];
    const targetH = 8 + rng() * 5;
    const g = proto.group.clone(true);
    g.scale.setScalar(targetH / proto.baseH);
    g.position.set(x, y - 0.2, z);
    g.rotation.y = rng() * Math.PI * 2;
    trees.push({ obj: g, x, z });
  }
  return { trees, count: trees.length };
}
