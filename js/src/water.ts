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
//   - DEPTH-FADED body colour + opacity by TRUE WATER-COLUMN DEPTH. When the caller
//     supplies the region's terrain heightfield (`opts.depth`), we bake it into a small
//     data texture and the shader reads, at each water fragment's WORLD (x,z), the
//     terrain surface height beneath it; the water column depth is `seaLevel − terrainY`.
//     Clear, light turquoise where the column is shallow (you see the wet sand at the
//     shore), darkening to an OPAQUE deep blue as the floor drops away — and the region's
//     finite edge / the void BEYOND the heightfield both read as deep sea ("island in
//     deep water", not "island on a square tile"). Because the band tracks the real
//     shoreline contour, there is no camera-distance "surf" ring and no hard square edge.
//     This is a deterministic geometric read of the SAME heightfield the terrain mesh is
//     built from — no GPU scene-depth buffer required. RENDER-ONLY: the baked field feeds
//     colour/opacity only; it is never captured into world state or compared by the sim
//     determinism gate, so it is deterministically re-derived but NOT required to be
//     byte-identical across authoring (analytic, bake-resolution) and replay (the cache's
//     sub-tile bilinear read) — only the cosmetic shading shifts imperceptibly.
//
//     WHY NOT a real scene-depth texture: it is feasible at the WebGPU primitive level
//     here (deno_webgpu 0.218 / wgpu-core 29 accept depth formats with TEXTURE_BINDING,
//     and three's WebGPU backend already allocates its depth textures sampleable), BUT
//     sampling scene depth from the water pass means restructuring the forward render
//     into a depth pre-pass / MRT (you cannot sample the depth attachment the current
//     transparent pass is writing). That is an unproven render-pipeline lift, whereas the
//     terrain heightfield gives the IDENTICAL "true water-column depth" with zero pipeline
//     risk and full determinism — so we take the terrain path. (If no terrain is supplied,
//     e.g. a bare lake, we fall back to the legacy VIEW-DISTANCE proxy below.)
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

/** Terrain-heightfield coupling for TRUE water-column-depth shading. The caller
 *  supplies a height query + the world-XZ rectangle it is valid over; the water
 *  surface bakes it (deterministically) into a data texture the shader samples at each
 *  fragment's world (x,z). Water column depth = `level − sampleHeight(x,z)`. RENDER-ONLY:
 *  this only feeds the render graph (colour/opacity) — it never touches physics/ECS/log. */
export interface WaterDepthOptions {
  /** Terrain surface world Y under world (x,z). MUST be the SAME field (source+seed+
   *  hints) the visible terrain mesh is built from, so the depth read matches the sand. */
  sampleHeight: (x: number, z: number) => number;
  /** The world-XZ rectangle `sampleHeight` covers (the generated region). Outside it the
   *  water reads as deep sea, dissolving the region's finite edge into open water. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Baked grid resolution per axis (samples). Default 256 (a 256×256 R8 texture, 64 KB);
   *  bilinearly filtered, so the shore gradient stays smooth between samples. */
  resolution?: number;
}

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
  /** OPTIONAL terrain coupling → TRUE water-column-depth shading (clear shallows →
   *  opaque deep by actual depth, with a clean shoreline). Omit for the legacy
   *  view-distance proxy (e.g. a bare lake with no heightfield to hand in). */
  depth?: WaterDepthOptions;
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

/** A baked region depth field: a single-channel texture of NORMALISED water-column
 *  depth (0 = at/above the waterline → 1 = the region's deepest floor) plus the world-XZ
 *  rectangle it covers, so the shader can map a fragment's world (x,z) → texel. */
interface BakedDepth {
  texture: unknown; // THREE.DataTexture (loose to satisfy the WaterMesh test stubs)
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

/** Bake the terrain heightfield into a normalised water-column-depth texture by sampling
 *  `depth.sampleHeight` on a regular grid over its bounds. Deterministic: identical inputs
 *  → identical bytes. Normalisation range = `seaLevel − (region min height)` (clamped to a
 *  small floor), so depth 1.0 is the deepest sampled floor and the shallow→deep gradient
 *  spans the real relief. R8 (256 levels) over a few-metre range is ~1 cm/step — finer than
 *  the wave ripple — and LINEAR filtering smooths it further.
 *
 *  EXPORTED for the depth UAT (js/test/p11_water_depth.ts): the returned texture's
 *  `image.data` is the row-major normalised depth (0 = at/above the waterline → 255 = the
 *  deepest sampled floor) — a FALSIFIABLE read of TRUE water-column depth, not a
 *  camera-distance proxy. */
export function bakeWaterDepth(depth: WaterDepthOptions, seaLevel: number): BakedDepth {
  const res = Math.max(8, Math.min(1024, Math.round(depth.resolution ?? 256)));
  const { minX, minZ, maxX, maxZ } = depth.bounds;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;

  // Pass 1: sample heights, find the deepest floor to set the normalisation range.
  const heights = new Float32Array(res * res);
  let minH = Infinity;
  for (let r = 0; r < res; r++) {
    const z = minZ + spanZ * (r / (res - 1));
    for (let c = 0; c < res; c++) {
      const x = minX + spanX * (c / (res - 1));
      const h = depth.sampleHeight(x, z);
      heights[r * res + c] = h;
      if (h < minH) minH = h;
    }
  }
  // Deepest column under the sea (>= a small floor so a near-flat lakebed still grades).
  const range = Math.max(0.5, seaLevel - minH);

  // Pass 2: quantise normalised depth into R8. Row-major, row r → world z (v = r/(res-1)),
  // col c → world x (u = c/(res-1)); DataTexture.flipY defaults false so (u,v)→(c,r).
  const data = new Uint8Array(res * res);
  for (let i = 0; i < heights.length; i++) {
    const d01 = Math.min(1, Math.max(0, (seaLevel - heights[i]) / range));
    data[i] = Math.round(d01 * 255);
  }
  const texture = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, bounds: depth.bounds };
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

  // ── Depth-based colour + opacity ──────────────────────────────────────────────────
  if (opts.depth !== undefined) {
    // TRUE WATER-COLUMN DEPTH from the terrain heightfield. Bake the region's floor into
    // a normalised-depth texture and read it at each fragment's WORLD (x,z): depth grows
    // as the floor drops away from the sea level, so the colour/opacity track the actual
    // shoreline contour (no camera-distance "surf" ring, no hard square shelf edge).
    const baked = bakeWaterDepth(opts.depth, opts.level);
    const { minX, minZ, maxX, maxZ } = baked.bounds;
    const u = T.positionWorld.x.sub(minX).div(maxX - minX);
    const v = T.positionWorld.z.sub(minZ).div(maxZ - minZ);
    const sampled = T.texture(baked.texture, T.vec2(u, v)).r; // 0 shallow → 1 deepest floor
    // Outside the baked region the floor is unknown → read it as deep open sea, so the
    // finite heightfield edge AND the void beyond it dissolve into uniform deep water.
    // A narrow feather (~0.025 of the region) avoids a hard line at the boundary.
    const outU = T.max(u.mul(-1), u.sub(1));
    const outV = T.max(v.mul(-1), v.sub(1));
    const oob = T.clamp(T.max(outU, outV).mul(40), 0, 1);
    const depth01 = T.mix(sampled, T.float(1.0), oob);

    // ── Shallow→deep ramp (TUNABLE; render-only). All thresholds are in normalised
    // water-column depth: 0 at the waterline → 1 at the region's deepest floor. ──────────
    //   SHADE_SHALLOW : below this depth the body stays clear turquoise — the wet-sand
    //                   shallows you can see straight through (holds the bright band so the
    //                   coast doesn't snap to blue right at the line).
    //   SHADE_DEEP    : by this depth the body is full deep blue. The turquoise→blue
    //                   transition spans SHADE_SHALLOW..SHADE_DEEP.
    //   FRESNEL_DEEPEN: extra deepening at the grazing horizon (more sky reflection, less
    //                   body transmission). Small so the shallows stay bright top-down.
    //   OPACITY_MIN   : the clear film at the waterline (you read the wet sand through it).
    //   OPACITY_DEEP_AT / OPACITY_MAX: depth at which — and the value to which — the body
    //                   becomes essentially opaque over the deep.
    const SHADE_SHALLOW = 0.05;
    const SHADE_DEEP = 0.42;
    const FRESNEL_DEEPEN = 0.25;
    const OPACITY_MIN = 0.22;
    const OPACITY_DEEP_AT = 0.55;
    const OPACITY_MAX = 0.97;

    // Colour: a clear turquoise shallows band (≤ SHADE_SHALLOW) → deep blue by SHADE_DEEP,
    // with a touch of grazing-Fresnel deepening on top (kept small so the shallows read
    // bright). Because depth tracks the real shoreline contour, the band hugs the coast.
    const colourDeep = T.smoothstep(SHADE_SHALLOW, SHADE_DEEP, depth01);
    const deepness = T.clamp(colourDeep.add(fresnel.mul(FRESNEL_DEEPEN)), 0, 1);
    material.colorNode = T.mix(shallowV, deepV, deepness);

    // Opacity: a clear film at the waterline (you see the wet sand) → opaque over the deep.
    // The shore reads soft+crisp because depth→0 smoothly up the beach slope, so the
    // transparency tapers along the real contour rather than a camera-distance ring.
    const opaque = T.smoothstep(0.0, OPACITY_DEEP_AT, depth01);
    material.opacityNode = T.float(OPACITY_MIN).add(opaque.mul(OPACITY_MAX - OPACITY_MIN));
  } else {
    // FALLBACK (no heightfield supplied, e.g. a bare lake): the legacy geometric proxy —
    // the water fragment's own VIEW DISTANCE stands in for depth. Clear near the camera,
    // darkening with distance + at the grazing horizon. No depth buffer, deterministic.
    const dist = T.positionView.z.mul(-1); // view-forward distance in world units
    const distFactor = T.smoothstep(6.0, 55.0, dist); // 0 near → 1 far
    const deepness = T.clamp(distFactor.mul(0.85).add(fresnel.mul(0.5)), 0, 1);
    material.colorNode = T.mix(shallowV, deepV, deepness);
    material.opacityNode = T.float(0.55).add(deepness.mul(0.43)); // 0.55 clear → 0.98 opaque
  }

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
