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
import { buildVariableRiverRibbonGeometry, buildWaterFootprintGeometry, type WaterPoint2 } from "./render/water/geometry.ts";
import { createWaterMaterial, type WaterDepthTextureBinding } from "./render/water/material.ts";

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
  /** Overview PEEK render: from 2 km up the whole coarse-grid plane is in frame, so the near-mirror
   *  sky reflection aliases into a grid of specular glints ("sun-glitter" fireflies). In peek mode the
   *  surface goes calmer + rougher so the reflection is diffuse (no glint grid) — mirror detail is
   *  invisible at that distance anyway. Absent/false keeps the pretty near-mirror eye-level water. */
  peek?: boolean;
  /** Optional plane center in world XZ. Legacy calls remain centered at the origin. */
  center?: readonly [number, number];
  /** Execution-quality tessellation override. Omission preserves the legacy size-derived value. */
  segments?: number;
  /** Execution-quality wave count in [0,4]. Omission preserves the four-wave look. */
  waveCount?: number;
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
export interface BakedDepth {
  texture: THREE.DataTexture;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  coverageChannel?: boolean;
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
  const segments = Math.max(8, Math.min(256, Math.round(opts.segments ?? size / 4)));
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  let baked: BakedDepth | undefined;
  let material: THREE.Material | undefined;
  try {
    baked = opts.depth === undefined ? undefined : bakeWaterDepth(opts.depth, opts.level);
    material = createWaterMaterial({
      color,
      kind: "ocean",
      orientation: "xy",
      depth: baked === undefined ? undefined : { ...baked, outsideAsDeep: true },
      peek: opts.peek,
      waveCount: opts.waveCount,
    });
    const mesh = new THREE.Mesh(geometry, material) as unknown as WaterMesh;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(opts.center?.[0] ?? 0, opts.level, opts.center?.[1] ?? 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    (mesh as unknown as THREE.Mesh).renderOrder = 1;
    mesh.name = "limina:water";
    return mesh;
  } catch (error) {
    material?.dispose();
    baked?.texture.dispose();
    geometry.dispose();
    throw error;
  }
}

export interface WaterBodySurfaceOptions {
  id: string;
  kind: string;
  level: number;
  footprint: {
    points: readonly WaterPoint2[];
    holes?: readonly (readonly WaterPoint2[])[];
  };
  color?: number;
  depth?: WaterDepthTextureBinding;
  waveCount?: number;
}

/** Build one authored standing-water polygon. Geometry is feature-local for large-world precision. */
export function buildWaterBodySurface(options: WaterBodySurfaceOptions): THREE.Mesh {
  let built: ReturnType<typeof buildWaterFootprintGeometry> | undefined;
  let material: THREE.Material | undefined;
  try {
    built = buildWaterFootprintGeometry({ outer: options.footprint.points, holes: options.footprint.holes });
    material = createWaterMaterial({
      color: options.color ?? DEFAULT_WATER_COLOR,
      kind: "basin",
      orientation: "xz",
      depth: options.depth,
      waveCount: options.waveCount,
    });
    const mesh = new THREE.Mesh(built.geometry, material);
    mesh.position.set(built.origin[0], options.level, built.origin[1]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.name = "limina:water-body";
    mesh.userData.waterBodyId = options.id;
    mesh.userData.waterBodyKind = options.kind;
    mesh.userData.waterBounds = built.bounds;
    return mesh;
  } catch (error) {
    material?.dispose();
    built?.geometry.dispose();
    options.depth?.texture.dispose();
    throw error;
  }
}

/** Options for one river ribbon (see buildRiverRibbon). */
export interface RiverOptions {
  /** Channel centerline in world meters, [[x,z], ...] (>= 2 points). */
  points: [number, number][];
  /** Water surface width (meters). Slightly narrower than the terrain carve so the
   *  ribbon's edges tuck into the banks instead of floating past them. */
  widthM: number;
  /** Optional canonical per-point widths. When present, length must match points. */
  widthsM?: readonly number[];
  /** Tint (sRGB hex). Default: the sea surface color. */
  color?: number;
  /** Terrain surface height at (x,z) — the CARVED channel floor along the centerline. */
  sampleHeight: (x: number, z: number) => number;
  /** Canonical per-point water surface elevations. Supplying this bypasses the legacy lift. */
  surfaceElevationsM?: readonly number[];
  /** Sea plane Y. Near/below it the ribbon drops to just above the plane (no lip at the mouth). */
  seaLevel: number;
  waveCount?: number;
  class?: "river" | "stream";
  order?: number;
}

/** Build a RENDER-ONLY river: a triangle-strip ribbon draped along the channel the map
 *  rasterizer carved, its surface floating ~1.2 m above the LOCAL channel floor (i.e. below
 *  the banks), descending with the terrain. Same contract as buildWaterSurface: purely
 *  cosmetic, recomputed from the logged request on replay, never sim state. A flat sea
 *  plane cannot render a river crossing elevated ground — this is the water system's
 *  terrain-following counterpart. */
export function buildRiverRibbon(opts: RiverOptions): WaterMesh {
  const widthsM = opts.widthsM ?? opts.points.map(() => opts.widthM);
  // Compatibility only: legacy scalar callers supplied a carved-floor sampler but no water-surface
  // channel. Verified map paths now supply exact sampled elevations and never enter this branch.
  const surfaceElevationsM = opts.surfaceElevationsM ?? opts.points.map(([x, z]) => {
    const legacy = opts.sampleHeight(x, z) + 2.2;
    return legacy < opts.seaLevel + 0.45 ? opts.seaLevel + 0.03 : legacy;
  });
  const built = buildVariableRiverRibbonGeometry({ points: opts.points, widthsM, surfaceElevationsM });
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({
      color: opts.color ?? DEFAULT_WATER_COLOR,
      kind: "river",
      orientation: "xz",
      waveCount: opts.waveCount,
    });
    const mesh = new THREE.Mesh(built.geometry, material) as unknown as WaterMesh;
    mesh.position.set(built.origin[0], built.origin[1], built.origin[2]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    (mesh as unknown as THREE.Mesh).renderOrder = 3;
    mesh.name = "limina:river";
    const object = mesh as unknown as THREE.Mesh;
    object.userData.waterwayClass = opts.class ?? "river";
    if (opts.order !== undefined) object.userData.waterwayOrder = opts.order;
    object.userData.waterwayLengthM = built.lengthM;
    object.userData.waterwayPointCount = built.pointCount;
    return mesh;
  } catch (error) {
    material?.dispose();
    built.geometry.dispose();
    throw error;
  }
}
