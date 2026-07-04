// FULL PIPELINE on real terrain, in order: terrain → water(form) → climate → vegetation(nature) →
// structures(civilization, subtractive clear) → look. Composes the stage systems from
// js/src/world/pipeline and hands the consumer { scene, camera }.
import * as THREE from "three";
import { generateTerrain } from "/js/src/world/pipeline/terrain.mjs";
import { generateWater, applyClimateToWater } from "/js/src/world/pipeline/water.mjs";
import { resolveClimate } from "/js/src/world/pipeline/climate.mjs";
import { generateVegetation } from "/js/src/world/pipeline/vegetation.mjs";
import { buildVillage } from "/tools/preview/assets/village.mjs";

export async function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbdd3e6);
  scene.fog = new THREE.Fog(0xd2ddb9, 90, 300);

  // 2 · TERRAIN (eroded)
  const terrain = generateTerrain({ seed: 6, sizeM: 120, amplitude: 14, seaCoverage: 0.34, erosion: { rain: 1.5, thermal: 6 } });
  scene.add(terrain.object3d);

  // 3 · WATER (form from terrain) · 4 · CLIMATE (temperate autumn) sets state
  const climate = resolveClimate({ season: "autumn", temperatureC: 12, moisture01: 0.6 });
  const water = generateWater(terrain, {});
  applyClimateToWater(water, { temperatureC: climate.tempC, season: climate.season });
  scene.add(water.object3d);

  // 5 · VEGETATION (nature grows it, climate + terrain aware)
  const veg = generateVegetation(terrain, climate, { seed: 7 });

  // 6 · STRUCTURES — GENERIC buildVillage(terrain, direction, steering). Setting + per-building style
  // come from design-planning params (NOT hard-coded); the same fn would build a futuristic town.
  const direction = {
    setting: "medieval", artStyle: "stylized-realism",
    palette: { stone: "#9b9890", timber: "#5c4632", plaster: "#e6ddc8", thatch: "#b39a5e", slate: "#474d54", terracotta: "#9c5a34", trim: "#6f675e" },
    mood: "weathered, lived-in",
  };
  const steering = {
    buildings: [
      { role: "keep", style: "nordic castle", count: 1 },
      { role: "church", style: "romanesque", count: 1 },
      { role: "cottage", style: "wattle-and-daub", count: 8 },
      { role: "barn", style: "timber", count: 1 },
    ],
    layout: { focal: "keep on the high knoll", density: "loose" },
  };
  const village = await buildVillage(terrain, direction, steering);
  for (const o of village.objects) scene.add(o);
  const footprints = village.footprints;
  let cx = 0, cz = 0; for (const f of footprints) { cx += f.x; cz += f.z; } cx /= footprints.length || 1; cz /= footprints.length || 1;
  const cy = terrain.heightAt(cx, cz);
  let cleared = 0;
  for (const t of veg.trees) {
    let inFootprint = false;
    for (const f of footprints) { if (Math.hypot(t.x - f.x, t.z - f.z) < f.r) { inFootprint = true; break; } }
    if (inFootprint) { cleared++; continue; }
    scene.add(t.obj);
  }
  console.log(`[world] eroded terrain; ${veg.count} trees, ${cleared} cleared by ${footprints.length} structures at (${cx.toFixed(0)},${cz.toFixed(0)}); sea=${terrain.config.seaLevelM.toFixed(1)}`);

  // LOOK — golden-hour sun + fill. Intensities are tuned for sRGB albedo maps
  // (the pipeline sRGB-decodes baseColor to linear before lighting), so the world
  // preview reads at the same brightness as the exported/re-imported GLB assets.
  const sun = new THREE.DirectionalLight(0xfff0d2, 4.4);
  sun.position.set(-46, 44, 24); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 1; c.far = 240;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x4a5a30, 1.4));
  scene.add(new THREE.AmbientLight(0x556072, 0.42));

  // wide establishing shot — pull back + up so the WHOLE settlement + castle + church + lake read,
  // not the keep filling the frame.
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 700);
  camera.position.set(cx + 52, cy + 46, cz + 60);
  camera.lookAt(cx, cy + 1, cz);
  return { scene, camera };
}
