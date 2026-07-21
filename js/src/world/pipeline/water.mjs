// PIPELINE STAGE 3 — WATER. Split into FORM and STATE, per the pipeline model:
//   • FORM (where water is) is DERIVED FROM TERRAIN — a surface at sea level; wherever the terrain
//     heightfield dips below it, water shows (lakes / sea in the basins), wherever it rises above,
//     it's dry land. So the terrain alone decides where water pools. Built here, right after terrain.
//   • STATE (liquid / frozen / seasonal level) is set LATER by CLIMATE via applyClimateToWater() —
//     climate acts on the already-placed water (freezes it, lowers it in drought) exactly the way it
//     acts on vegetation. The FORM never changes; only the material + level do, so water can TRANSITION
//     as climate changes (winter freeze → spring thaw) without re-deriving the lake.
import * as THREE from "three";

const LIQUID = () => new THREE.MeshStandardMaterial({ color: 0x2f6d92, transparent: true, opacity: 0.82, roughness: 0.14, metalness: 0.0 });
const FROZEN = () => new THREE.MeshStandardMaterial({ color: 0xcadfe8, transparent: true, opacity: 0.96, roughness: 0.35, metalness: 0.0 });

/** Build the water FORM from the terrain: a surface at (seaLevel + levelOffset). It's a full plane
 *  over the terrain footprint; the terrain pokes through it, so water only appears in the low basins.
 *  Returns { object3d, setState, level } — setState is how the CLIMATE stage drives liquid/frozen. */
export function generateWater(terrain, opts = {}) {
  const seaLevel = terrain.config.seaLevelM ?? 0.9;
  const levelOffsetM = opts.levelOffsetM ?? 0;
  const level = seaLevel + levelOffsetM;
  const size = terrain.config.sizeM;
  // A gently segmented plane so a frozen/liquid surface can later carry subtle relief if wanted.
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, LIQUID());
  mesh.position.y = level;
  mesh.receiveShadow = true;
  mesh.name = "water";

  // STATE hook the climate stage calls. frozen → ice material; level tweaks the seasonal height.
  function setState({ frozen = false, levelOffsetM: off = levelOffsetM } = {}) {
    mesh.material.dispose?.();
    mesh.material = frozen ? FROZEN() : LIQUID();
    mesh.material.needsUpdate = true;
    mesh.position.y = seaLevel + off;
  }

  // How much of the terrain is actually underwater — lets the pipeline skip water when there's none.
  let submerged = 0, samples = 0;
  const h = terrain.config.sizeM / 2;
  for (let x = -h; x <= h; x += size / 24) for (let z = -h; z <= h; z += size / 24) { samples++; if (terrain.heightAt(x, z) < level) submerged++; }
  return { object3d: mesh, setState, level, seaLevel, coverage01: submerged / samples };
}

/** CLIMATE → WATER STATE. Called by the climate stage (4) on the already-placed water (3). Freezes
 *  the water in a cold climate, and can lower the level in a dry one — a pure state change on stable
 *  geometry, so the same lake can freeze and thaw as climate changes. */
export function applyClimateToWater(water, climate) {
  const frozen = (climate?.temperatureC ?? 12) <= 0 || climate?.season === "winter" && (climate?.temperatureC ?? 12) < 4;
  const droughtDrop = climate?.aridity01 ? -0.6 * climate.aridity01 : 0;
  water.setState({ frozen, levelOffsetM: droughtDrop });
  return { frozen, levelOffsetM: droughtDrop };
}
