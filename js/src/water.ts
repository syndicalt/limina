// RENDER-ONLY sea-level water surface. A single large horizontal plane at a
// configurable sea-level Y with a tasteful, WebGPU-safe water material so beaches
// / lakes / oceans actually read as water. It is PURELY COSMETIC: it never enters
// the physics world or the ECS/entity table, so it cannot affect the deterministic
// sim or replay. A world with water replays bit-identically to one without — the
// mesh is recomputed from the logged sea LEVEL (like prop scatter), never carried
// as instance bytes.
//
// The material is a TSL node graph over MeshStandardNodeMaterial (so it keeps full
// PBR lighting + picks up `scene.environment` reflections), tuned to read as a
// TROPICAL SEA:
//   - a turquoise-shallows → deep-blue body gradient driven by the view's facing
//     angle (top-down water reads shallow/turquoise, the grazing run-out toward the
//     horizon deepens and turns reflective — the classic open-water look, and it
//     needs no scene-depth buffer);
//   - a Fresnel term that makes the grazing horizon both more opaque and more
//     reflective of the sky IBL;
//   - GENTLE ANIMATED WAVES: a time-driven vertex ripple plus a roughness shimmer
//     that breaks up the reflection on the crests, and moving sun-glint sparkles.
// All animation is driven by the TSL `time` node — it lives ENTIRELY in the render
// graph (a per-frame GPU uniform), never in the sim/world-log, so determinism and
// replay parity are untouched. Refraction/caustics + a scene-depth shoreline foam
// remain a later upgrade (they need the scene depth/back buffers); the shoreline
// wet-edge/foam is rendered ground-truth on the sand surface (terrain/render.ts).

import * as THREE from "../build/three.bundle.mjs";

// TSL node graph helpers, bundled under the `TSL` namespace of the three webgpu
// build. Typed loosely (the fluent node API is dynamic: every op returns a chainable
// node) — the graph is validated by the live WebGPU shader compile (in-tab UAT).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

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

  // A flat XZ plane, tessellated so the time-driven vertex ripple has vertices to
  // move (PlaneGeometry is XY-facing; rotated flat like the baseline ground below).
  // Segment count scales with size but is capped — cheap even for a 400-unit ocean.
  const segments = Math.max(8, Math.min(128, Math.round(size / 4)));
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);

  // Body gradient endpoints in LINEAR render space. The requested sRGB `color` is the
  // DEEP water (so world.addWater(color) still tints the body); SHALLOW is a brighter,
  // greener turquoise derived from it — the two are blended by the view facing angle.
  const base = new THREE.Color(color); // ColorManagement → linear components
  const deepV = T.vec3(base.r, base.g, base.b);
  const shallowV = T.vec3(
    Math.min(1, base.r * 1.7 + 0.05),
    Math.min(1, base.g * 1.45 + 0.20),
    Math.min(1, base.b * 1.15 + 0.10),
  );

  // Low roughness + no metalness so the gradient-sky IBL (scene.environment) reflects
  // off the surface (a dielectric, not chrome). `transparent` lets the underwater sand
  // tint through; the node graph below drives color/roughness/opacity/emissive/position.
  const material = new THREE.MeshStandardNodeMaterial({
    color,
    roughness: 0.1,
    metalness: 0.0,
    transparent: true,
    opacity: 0.85,
  });

  // View facing: for a flat sea the surface normal is world-up, so the vertical
  // component of the view direction is the facing ratio (1 = looking straight down →
  // shallow/turquoise; →0 at the grazing horizon → deep + reflective). No depth buffer.
  const facing = T.clamp(T.cameraPosition.sub(T.positionWorld).normalize().y, 0, 1);
  const fresnel = T.oneMinus(facing).pow(4); // grazing → 1

  // Body colour: deep→shallow by facing (biased so most of the plane reads tropical,
  // deepening only toward the run-out toward the horizon).
  material.colorNode = T.mix(deepV, shallowV, facing.pow(0.55));

  // Animated micro-waves (render-graph only). Two crossing sinusoids in world XZ,
  // scrolled by the `time` node; reused for the roughness shimmer and the sun glint.
  const t = T.time;
  const wx = T.positionWorld.x;
  const wz = T.positionWorld.z;
  const waveA = wx.mul(0.22).add(wz.mul(0.15)).add(t.mul(0.6)).sin();
  const waveB = wx.mul(0.9).sub(wz.mul(0.7)).sub(t.mul(1.2)).sin();
  const wave01 = waveA.mul(0.5).add(0.5); // 0..1

  // Roughness shimmer: calm water is near-mirror; crests roughen so the sky IBL
  // reflection breaks up and travels — the cheapest WebGPU-safe way to animate a
  // reflection without touching normals.
  material.roughnessNode = T.float(0.05).add(wave01.mul(0.12)); // 0.05 .. 0.17

  // Opacity: more opaque + reflective at the grazing horizon, clearer top-down.
  material.opacityNode = T.float(0.72).add(fresnel.mul(0.27)); // 0.72 .. 0.99

  // Sun glint: sharp moving sparkles on the wave peaks (warm, small, additive).
  const sparkle = T.max(waveB, 0).pow(7);
  material.emissiveNode = T.vec3(1.0, 0.94, 0.78).mul(sparkle.mul(0.6));

  // Gentle vertex ripple along the plane's local normal (local Z → world up after the
  // -90° X rotation). Small amplitude: alive, never choppy. positionLocal.xy is the
  // in-plane coordinate; displacing local Z lifts/drops the surface.
  const lx = T.positionLocal.x;
  const ly = T.positionLocal.y;
  const ripple = lx.mul(0.16).add(t.mul(0.9)).sin()
    .add(ly.mul(0.2).sub(t.mul(0.7)).sin())
    .mul(0.07);
  material.positionNode = T.positionLocal.add(T.vec3(0, 0, ripple));

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
