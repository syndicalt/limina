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
//   - DEPTH-FADED body colour + opacity: clear, light turquoise near the camera (the
//     foreground shore — you see the wet sand), darkening to an OPAQUE deep blue with
//     distance + at the grazing horizon. This dissolves the finite tile region's hard
//     underwater shelf edge AND the void beyond the tiles into uniform deep sea
//     ("island in deep water", not "island on a square tile"). The depth proxy is the
//     water fragment's own VIEW DISTANCE — the deno_webgpu backend exposes no usable
//     scene-depth texture (no depth-attachment/sampling path in the render crate; the
//     bootstrap is all texture-UPLOAD workarounds), so a true water-column-depth read
//     isn't reliable here; the geometric proxy needs no depth buffer and no terrain.
//   - ANIMATED WAVE NORMALS: a summed field of four crossing directional waves drives
//     a true bump `normalNode` (+ a matching vertex displacement), so the surface
//     visibly undulates and the sky-IBL reflection breaks up and travels across it.
//     Cellular (no single direction) → no candy-cane stripes. Plus a faint roughness
//     shimmer. All animation is driven by the TSL `time` node — it lives ENTIRELY in
//     the render graph (a per-frame GPU uniform), never in the sim/world-log, so
//     determinism and replay parity are untouched. Refraction/caustics + a true
//     scene-depth read remain a later upgrade (a backend depth-texture path); the
//     shoreline wet-edge/foam is rendered ground-truth on the sand (terrain/render.ts).

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
  // component of the view direction is the facing ratio (1 = looking straight down,
  // →0 at the grazing horizon). The Fresnel term off it drives the deep-water blend.
  const facing = T.clamp(T.cameraPosition.sub(T.positionWorld).normalize().y, 0, 1);
  const fresnel = T.oneMinus(facing).pow(4); // grazing → 1

  // ── Animated surface (render-graph only, scrolled by the `time` node) ──────────────
  // A summed field of FOUR crossing directional waves (non-axis-aligned, different
  // wavelengths + speeds) → a cellular, travelling surface with no single direction
  // (no candy-cane stripes). We carry both the HEIGHT and its analytic SLOPE (∂h/∂u,
  // ∂h/∂v in the plane's local UV) so the same field drives a true bump NORMAL and a
  // matching vertex displacement — the surface visibly undulates and the sky-IBL
  // reflection breaks up and travels across it like real water.
  const t = T.time;
  const lx = T.positionLocal.x; // plane-local U (world X)
  const ly = T.positionLocal.y; // plane-local V (world Z, before the -90° X rotation)
  const waves = [
    { dx: 0.80, dy: 0.60, f: 0.30, s: 0.90, a: 1.00 },
    { dx: -0.60, dy: 0.80, f: 0.42, s: 1.10, a: 0.80 },
    { dx: 0.50, dy: -0.85, f: 0.55, s: 0.70, a: 0.60 },
    { dx: -0.90, dy: -0.40, f: 0.68, s: 1.30, a: 0.45 },
  ];
  // deno-lint-ignore no-explicit-any
  let height: any = null, slopeU: any = null, slopeV: any = null;
  for (const w of waves) {
    const phase = lx.mul(w.dx * w.f).add(ly.mul(w.dy * w.f)).add(t.mul(w.s));
    const sinP = phase.sin();
    const cosP = phase.cos();
    height = height === null ? sinP.mul(w.a) : height.add(sinP.mul(w.a));
    slopeU = slopeU === null ? cosP.mul(w.a * w.f * w.dx) : slopeU.add(cosP.mul(w.a * w.f * w.dx));
    slopeV = slopeV === null ? cosP.mul(w.a * w.f * w.dy) : slopeV.add(cosP.mul(w.a * w.f * w.dy));
  }

  // Bump normal: tilt the plane's local +Z face normal by the wave slope, then take it
  // to view space so MeshStandardNodeMaterial lights + reflects off the rippled surface.
  // Strength tuned so it reads as water, not chop.
  const NORMAL_STRENGTH = 0.34;
  const bumpN = T.vec3(slopeU.mul(-NORMAL_STRENGTH), slopeV.mul(-NORMAL_STRENGTH), 1).normalize();
  material.normalNode = T.transformNormalToView(bumpN);

  // Gentle vertex displacement from the SAME height field (local Z → world up after the
  // -90° X rotation) so the silhouette/grazing edge undulates in step with the normals.
  material.positionNode = T.positionLocal.add(T.vec3(0, 0, height.mul(0.06)));

  // Roughness: near-mirror calm tropical water with a faint shimmer off the wave height
  // so the IBL reflection has extra life. Small range → clean.
  const h01 = T.clamp(height.mul(0.18).add(0.5), 0, 1);
  material.roughnessNode = T.float(0.05).add(h01.mul(0.07)); // 0.05 .. 0.12

  // ── Depth-based colour + opacity (geometric: the deno_webgpu backend has no usable
  // scene-DEPTH texture, so we use the water fragment's own view distance as the depth
  // proxy). Near the camera (the foreground shore) the water is clear turquoise and you
  // see the wet sand; it darkens to an OPAQUE deep blue with distance + at the grazing
  // horizon. Result: the finite tile region's hard underwater shelf edge — and the void
  // beyond the tiles — both dissolve into uniform deep sea ("island in deep water",
  // not "island on a square tile"). No depth buffer, no terrain coupling, deterministic.
  const dist = T.positionView.z.mul(-1); // view-forward distance in world units
  const distFactor = T.smoothstep(6.0, 55.0, dist); // 0 near → 1 far
  const deepness = T.clamp(distFactor.mul(0.85).add(fresnel.mul(0.5)), 0, 1);
  material.colorNode = T.mix(shallowV, deepV, deepness);
  material.opacityNode = T.float(0.55).add(deepness.mul(0.43)); // 0.55 clear → 0.98 opaque

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
