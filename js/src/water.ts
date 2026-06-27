// RENDER-ONLY sea-level water surface. A single large horizontal plane at a
// configurable sea-level Y with a tasteful, WebGPU-safe water material so beaches
// / lakes / oceans actually read as water. It is PURELY COSMETIC: it never enters
// the physics world or the ECS/entity table, so it cannot affect the deterministic
// sim or replay. A world with water replays bit-identically to one without — the
// mesh is recomputed from the logged sea LEVEL (like prop scatter), never carried
// as instance bytes.
//
// Reflections come from `scene.environment` (the render baseline's gradient-sky
// IBL) — a low-roughness PBR plane picks them up automatically through the node
// material. This first cut is a calm, tonemapped, slightly-transparent tinted
// plane. Animated waves, refraction/depth tint, and caustics are a LATER UPGRADE
// (they need a custom node graph + the scene depth/back buffers); the surface is
// shaped so that upgrade can swap the material without changing the skill contract.

import * as THREE from "../build/three.bundle.mjs";

/** Build-time options for a water surface. Only `level` (the sea-level world Y)
 *  is required; `size`/`color` have tasteful defaults. */
export interface WaterOptions {
  /** Sea-level world Y the surface sits at (heights below this read as underwater). */
  level: number;
  /** Side length (world units) of the square surface plane. Default: a large plane
   *  that reads as open water within the default camera's far range. */
  size?: number;
  /** Tint (sRGB hex) of the water body. Default: a deep ocean teal-blue. */
  color?: number;
}

/** A large plane so an ocean reads as endless within the default camera far (200). */
export const DEFAULT_WATER_SIZE = 400;
/** A deep, slightly-green ocean blue that looks like water under the gradient sky. */
export const DEFAULT_WATER_COLOR = 0x2b5d72;

/** The minimal THREE.Mesh surface this module returns (kept loose so a test stub or
 *  the real renderer both satisfy it). */
export interface WaterMesh {
  name: string;
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  rotation: { x: number };
  material: unknown;
  receiveShadow: boolean;
  castShadow: boolean;
}

/** Build a render-only water surface mesh at sea-level `level`. The returned mesh is
 *  ready to `scene.add(...)`; the caller owns adding/removing it. NO physics body, NO
 *  collider, NO ECS entity is created — it is a cosmetic surface only. Deterministic:
 *  identical options produce an identical surface. */
export function buildWaterSurface(opts: WaterOptions): WaterMesh {
  const size = opts.size ?? DEFAULT_WATER_SIZE;
  const color = opts.color ?? DEFAULT_WATER_COLOR;

  // A flat XZ plane (PlaneGeometry is XY-facing; rotate it flat like the baseline ground).
  const geometry = new THREE.PlaneGeometry(size, size);
  // Low roughness + no metalness so the gradient-sky IBL (scene.environment) reflects
  // crisply off the surface while the body color stays in the diffuse term (shallow
  // water still reads as water, not chrome); slight transparency tints what is
  // underwater without a full refraction pass (that is the later upgrade).
  const material = new THREE.MeshStandardNodeMaterial({
    color,
    roughness: 0.12,
    metalness: 0.0,
    transparent: true,
    opacity: 0.82,
  });

  const mesh = new THREE.Mesh(geometry, material) as unknown as WaterMesh;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, opts.level, 0);
  // Water does not cast/receive hard shadow maps in this first cut (it would read as
  // dirty); reflections + tone come from the IBL environment.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = "limina:water";
  return mesh;
}
