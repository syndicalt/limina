import * as THREE from "../../build/three.bundle.mjs";
import {
  DEFAULT_RENDER_QUALITY_PROFILES,
  type RenderQualityTier,
  type WaterRenderQuality,
} from "../render/quality.ts";
import {
  mountGeneratedWaterResource,
  generatedWaterCoversPoint,
  type GeneratedWaterRenderMount,
} from "../render/water/generated-water-renderer.ts";
import { VisibleWaterManager } from "../render/water/visible-water-manager.ts";
import {
  TERRAIN_ELEVATION_ALBEDO_HEX,
  buildTerrainMesh,
  disposeTerrainMesh,
} from "../terrain/render.ts";
import { TERRAIN_PAINT_ALBEDO_HEX } from "../terrain/material-palette.ts";
import { tileKey } from "../terrain/stream.ts";
import type { TerrainTile } from "../terrain/types.ts";
import { selectDerivedTerrainChunks } from "./derived-terrain-residency.ts";
export { DerivedLod0TerrainIndex } from "./derived-terrain-index.ts";
import { searchNavigationIndexPrefix } from "../world/compiler/navigation-index-artifact.mjs";
import { encodeBiomeFieldArtifact } from "../world/compiler/biome-field-artifact.mjs";
import {
  buildBiomeSurfaceMaterial,
  type BiomeSurfaceMaterialMount,
} from "../terrain/biome-surface-material.ts";
import { plainRecord } from "./derived-plain-data.ts";
import {
  MAX_DETACHED_DERIVED_TERRAIN_MESHES,
  assertVerifiedTransferredDerivedSnapshot,
  type DetachedDerivedPopulationPlan,
  type ParsedTransferredDerivedSnapshot,
  type ParsedTransferredSurfaceComposite,
  type VerifiedBiomeContentBundle,
} from "./derived-runtime-verify.ts";

// Verification/decoding of a transferred snapshot lives in derived-runtime-verify.ts
// (the ONE verifier — worker-loadable, no `three`/DOM). This module is MOUNTING only;
// it re-exports the verify surface for its existing importers, and its constructor
// accepts only the verify module's branded output (verify-before-construct).
export {
  DETACHED_DERIVED_POPULATION_PLAN_SCHEMA,
  MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES,
  MAX_DETACHED_DERIVED_TERRAIN_MESHES,
  MAX_DETACHED_DERIVED_TERRAIN_RADIUS,
  parseTransferredDerivedRuntimeSnapshot,
} from "./derived-runtime-verify.ts";
export type {
  DetachedDerivedPopulationPlacement,
  DetachedDerivedPopulationPlan,
  ParsedGeneratedWaterResource,
  ParsedTransferredBiomePopulation,
  ParsedTransferredDerivedSnapshot,
  ParsedTransferredSurfaceComposite,
  VerifiedBiomeContentBundle,
} from "./derived-runtime-verify.ts";

// ── Derived-mount phase instrumentation (C2 measurement seam) ──────────────────
// performance.mark/measure spans around the main-thread phases of derived-revision
// activation (browser-entry `activateDerivedRevision`). Render-realm instrumentation
// only: the entries never feed world state or any skill, and the helpers no-op where
// the host exposes no mark/measure (the native bootstrap shims only performance.now).
// Each begin clears that phase's previous entries so the timeline buffer stays
// bounded across repeated activations. Names are shared with the measurement harness
// (tools/derived/mount-cost-measure.mjs) — keep both in sync.
export const DERIVED_MOUNT_PHASE = Object.freeze({
  verifyAwait: "limina:derived-mount:verify-await",
  construct: "limina:derived-mount:construct",
  stagePrep: "limina:derived-mount:stage-prep",
  heightfields: "limina:derived-mount:heightfields",
  sceneAdd: "limina:derived-mount:scene-add",
} as const);
export type DerivedMountPhase = keyof typeof DERIVED_MOUNT_PHASE;

type PhasePerformance = Pick<Performance, "mark" | "measure" | "clearMarks" | "clearMeasures">;
const phasePerf: PhasePerformance | undefined = ((): PhasePerformance | undefined => {
  const candidate = (globalThis as { performance?: Partial<Performance> }).performance;
  return candidate !== undefined
      && typeof candidate.mark === "function"
      && typeof candidate.measure === "function"
      && typeof candidate.clearMarks === "function"
      && typeof candidate.clearMeasures === "function"
    ? candidate as PhasePerformance
    : undefined;
})();

export function beginDerivedMountPhase(phase: DerivedMountPhase): void {
  if (phasePerf === undefined) return;
  const name = DERIVED_MOUNT_PHASE[phase];
  try {
    phasePerf.clearMeasures(name);
    phasePerf.clearMarks(`${name}:start`);
    phasePerf.clearMarks(`${name}:end`);
    phasePerf.mark(`${name}:start`);
  } catch { /* instrumentation must never fail an activation */ }
}

export function endDerivedMountPhase(phase: DerivedMountPhase): void {
  if (phasePerf === undefined) return;
  const name = DERIVED_MOUNT_PHASE[phase];
  try {
    phasePerf.mark(`${name}:end`);
    phasePerf.measure(name, `${name}:start`, `${name}:end`);
  } catch { /* an end without its begin (aborted activation) must not throw */ }
}

export interface DetachedDerivedRenderCandidateOptions {
  readonly quality?: RenderQualityTier;
  readonly maxTerrainMeshes?: number;
}

export interface DerivedPresentationStatus {
  readonly groundCover: "unfulfilled" | "ready" | "empty";
  readonly groundCoverTiles: number;
  readonly groundCoverBlades: number;
  readonly climateProfiles: readonly string[];
  readonly canopy: "unfulfilled" | "ready" | "empty";
  readonly canopyReason: string;
  readonly groundCoverReason: string;
  readonly populationPlacements: number;
}

export interface DetachedDerivedPopulationMount {
  readonly canopyInstances: number;
  readonly groundCoverTiles: number;
  readonly groundCoverBlades: number;
  dispose(): void;
}

export type DetachedDerivedPopulationFactory = (input: Readonly<{
  plan: DetachedDerivedPopulationPlan;
  content: VerifiedBiomeContentBundle;
  root: THREE.Group;
  terrainWindow: readonly DetachedDerivedTerrainWindowEntry[];
  biomeField: Readonly<{ bytes: Uint8Array; contentHash: string }>;
  runtimePack: Readonly<{ bytes: Uint8Array; semanticContentHash: string }>;
  waterCoverageAt: (x: number, z: number) => boolean;
}>) => Promise<DetachedDerivedPopulationMount>;

export interface DetachedDerivedTerrainWindowEntry {
  readonly key: string;
  readonly tx: number;
  readonly tz: number;
  readonly tile: TerrainTile;
  readonly surface?: ParsedTransferredSurfaceComposite;
}

export type DerivedNavigationSearchResult = Readonly<{
  designRef: Readonly<{ schema: string; mapId: string; kind: string; id: string }>;
  position: readonly [number, number];
  label: string;
  kind: string;
  searchKeys: readonly string[];
  radiusM?: number;
}>;

/** Search only the main-realm index reconstructed by snapshot verification. */
export function searchTransferredDerivedNavigation(
  snapshot: Pick<ParsedTransferredDerivedSnapshot, "navigationIndex"> | null,
  prefix: string,
  limit = 20,
): readonly DerivedNavigationSearchResult[] {
  if (snapshot?.navigationIndex === null || snapshot?.navigationIndex === undefined) return Object.freeze([]);
  return searchNavigationIndexPrefix(snapshot.navigationIndex, prefix, { limit }) as readonly DerivedNavigationSearchResult[];
}

export interface DetachedWorldOverviewBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  return plainRecord(value, label);
}

function hexRgb(hex: number): readonly [number, number, number] {
  return Object.freeze([((hex >>> 16) & 0xff) / 255, ((hex >>> 8) & 0xff) / 255, (hex & 0xff) / 255]);
}

const OVERVIEW_PAINT_COLORS = Object.freeze(TERRAIN_PAINT_ALBEDO_HEX.map((hex) => (
  hex === null ? null : hexRgb(hex)
)));
const OVERVIEW_GRASS = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.grass);
const OVERVIEW_GRASS_DARK = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.grassDark);
const OVERVIEW_ROCK = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.rock);

function buildWorldOverviewMesh(
  overview: NonNullable<ParsedTransferredDerivedSnapshot["worldOverview"]>,
  terrainWindow: readonly DetachedDerivedTerrainWindowEntry[],
): Readonly<{ mesh: THREE.Mesh; bounds: Readonly<DetachedWorldOverviewBounds> }> {
  const { grid } = overview;
  const count = grid.rows * grid.cols;
  const positions = new Float32Array(count * 3);
  // Native WebGPU requires every vertex-buffer stride to be 4-byte aligned. A packed RGB8
  // attribute has a 3-byte stride and is accepted by WebGL but rejected by wgpu; RGBA8 keeps
  // the same normalized colour while satisfying both backends.
  const colors = new Uint8Array(count * 4);
  let minY = Infinity, maxY = -Infinity;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cell = row * grid.cols + col;
      const vertex = cell * 3;
      const color = cell * 4;
      positions[vertex] = col * grid.stepM;
      positions[vertex + 1] = grid.heights[cell];
      positions[vertex + 2] = row * grid.stepM;
      minY = Math.min(minY, grid.heights[cell]);
      maxY = Math.max(maxY, grid.heights[cell]);
      const left = grid.heights[row * grid.cols + Math.max(0, col - 1)]!;
      const right = grid.heights[row * grid.cols + Math.min(grid.cols - 1, col + 1)]!;
      const top = grid.heights[Math.max(0, row - 1) * grid.cols + col]!;
      const bottom = grid.heights[Math.min(grid.rows - 1, row + 1) * grid.cols + col]!;
      const slope = Math.min(1, Math.hypot(right - left, bottom - top) / (2 * grid.stepM));
      const worldX = grid.origin[0] + col * grid.stepM;
      const worldZ = grid.origin[1] + row * grid.stepM;
      const mottle = (Math.sin(worldX * 0.2 + worldZ * 0.2) * 0.5 + 0.5) * 0.3;
      const rockWeight = Math.min(1, Math.max(0, (slope * 1.2 - 0.18) / 0.32));
      const unpainted = [0, 1, 2].map((channel) => {
        const grass = OVERVIEW_GRASS[channel]! + (OVERVIEW_GRASS_DARK[channel]! - OVERVIEW_GRASS[channel]!) * mottle;
        return grass + (OVERVIEW_ROCK[channel]! - grass) * rockWeight;
      });
      const paint = OVERVIEW_PAINT_COLORS[grid.paintMaterial[cell]] ?? null;
      const weight = grid.paintWeight[cell] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const value = paint === null ? unpainted[channel]! : unpainted[channel]! + (paint[channel]! - unpainted[channel]!) * weight;
        colors[color + channel] = Math.round(255 * value);
      }
      colors[color + 3] = 255;
    }
  }
  // Fine chunks own the proxy quad whose centre lies inside their footprint. This bounds overlap
  // to half a proxy cell while avoiding the visible holes caused by removing every intersecting quad.
  const quadCols = grid.cols - 1, quadRows = grid.rows - 1;
  const covered = new Uint8Array(quadCols * quadRows);
  for (const entry of terrainWindow) {
    const halfX = entry.tile.scale[0] / 2, halfZ = entry.tile.scale[2] / 2;
    const localMinX = entry.tile.origin[0] - halfX - grid.origin[0];
    const localMaxX = entry.tile.origin[0] + halfX - grid.origin[0];
    const localMinZ = entry.tile.origin[2] - halfZ - grid.origin[1];
    const localMaxZ = entry.tile.origin[2] + halfZ - grid.origin[1];
    const minCol = Math.max(0, Math.ceil(localMinX / grid.stepM - 0.5));
    const maxCol = Math.min(quadCols - 1, Math.floor(localMaxX / grid.stepM - 0.5));
    const minRow = Math.max(0, Math.ceil(localMinZ / grid.stepM - 0.5));
    const maxRow = Math.min(quadRows - 1, Math.floor(localMaxZ / grid.stepM - 0.5));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) covered[row * quadCols + col] = 1;
    }
  }
  // A Uint16 index buffer wraps silently past 65 536 vertices; the overview format allows up to
  // WORLD_OVERVIEW_MAX_DIMENSION² = 257×257 = 66 049.
  const indices = count > 65_536 ? new Uint32Array(quadRows * quadCols * 6) : new Uint16Array(quadRows * quadCols * 6);
  let offset = 0;
  for (let row = 0; row < quadRows; row++) {
    for (let col = 0; col < quadCols; col++) {
      if (covered[row * quadCols + col] !== 0) continue;
      const a = row * grid.cols + col, b = a + 1, c = a + grid.cols, d = c + 1;
      indices[offset++] = a; indices[offset++] = c; indices[offset++] = b;
      indices[offset++] = b; indices[offset++] = c; indices[offset++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, offset), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(grid.origin[0], 0, grid.origin[1]);
  mesh.name = "limina:world-overview-terrain";
  mesh.userData.derivedWorldOverview = true;
  mesh.frustumCulled = true;
  return Object.freeze({
    mesh,
    bounds: Object.freeze({
      minX: grid.origin[0],
      minY,
      minZ: grid.origin[1],
      maxX: grid.origin[0] + (grid.cols - 1) * grid.stepM,
      maxY,
      maxZ: grid.origin[1] + (grid.rows - 1) * grid.stepM,
    }),
  });
}

interface DerivedTerrainSurfaceFrame {
  readonly seaLevelM: number;
  readonly minY: number;
  readonly maxY: number;
  readonly source: "hydrology" | "window-relief-fallback";
}

function terrainWindowSurfaceFrame(
  tiles: readonly TerrainTile[],
  hydrologySeaLevelM?: number,
): DerivedTerrainSurfaceFrame {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    for (const height of tile.heights) {
      const worldY = tile.origin[1] + height * tile.scale[1];
      minY = Math.min(minY, worldY);
      maxY = Math.max(maxY, worldY);
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) throw new Error("derived terrain surface frame requires finite staged relief");
  if (hydrologySeaLevelM !== undefined) {
    if (!Number.isFinite(hydrologySeaLevelM)) throw new Error("derived terrain hydrology sea level must be finite");
    return Object.freeze({ seaLevelM: hydrologySeaLevelM, minY, maxY, source: "hydrology" as const });
  }
  const relief = Math.max(0, maxY - minY);
  const dryMargin = Math.min(5, Math.max(0.25, relief * 0.05));
  return Object.freeze({
    seaLevelM: minY - dryMargin,
    minY,
    maxY,
    source: "window-relief-fallback" as const,
  });
}

function featureLocalTerrainMesh(tile: TerrainTile, frame: DerivedTerrainSurfaceFrame): THREE.Mesh {
  const localTile: TerrainTile = {
    ...tile,
    origin: [0, 0, 0],
  };
  const mesh = buildTerrainMesh(localTile, {
    pbr: {
      seaLevel: frame.seaLevelM - tile.origin[1],
      minY: frame.minY - tile.origin[1],
      maxY: frame.maxY - tile.origin[1],
      featureLocalOrigin: tile.origin,
    },
  });
  mesh.position.set(tile.origin[0], tile.origin[1], tile.origin[2]);
  mesh.name = "limina:derived-terrain-chunk";
  mesh.userData.derivedTerrain = true;
  mesh.userData.derivedTerrainSurfaceFrame = Object.freeze({
    seaLevelM: frame.seaLevelM,
    minY: frame.minY,
    maxY: frame.maxY,
    localSeaLevel: frame.seaLevelM - tile.origin[1],
    localMinY: frame.minY - tile.origin[1],
    localMaxY: frame.maxY - tile.origin[1],
    source: frame.source,
  });
  return mesh;
}

function disposeUnpooledTerrainMaterial(material: THREE.Material | THREE.Material[]): void {
  const errors: unknown[] = [];
  for (const owned of Array.isArray(material) ? material : [material]) {
    const textures = owned.userData.liminaOwnedTextures;
    if (Array.isArray(textures)) {
      owned.userData.liminaOwnedTextures = [];
      for (const texture of textures) try { (texture as THREE.Texture).dispose(); } catch (error) { errors.push(error); }
    }
    try { owned.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "provisional derived terrain material disposal failed");
}

/** Replace only the provisional material; geometry remains candidate-owned. */
function installBiomeSurfaceMaterial(mesh: THREE.Mesh, surface: ParsedTransferredSurfaceComposite): BiomeSurfaceMaterialMount {
  let mount: BiomeSurfaceMaterialMount;
  try {
    mount = buildBiomeSurfaceMaterial(surface.decoded, {
      localBounds: [-surface.decoded.placement.sizeM / 2, -surface.decoded.placement.sizeM / 2,
        surface.decoded.placement.sizeM / 2, surface.decoded.placement.sizeM / 2],
    });
  } catch (error) {
    try { disposeTerrainMesh(mesh); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "biome surface material build and provisional terrain cleanup failed");
    }
    throw error;
  }
  const provisional = mesh.material;
  mesh.material = mount.material;
  try {
    disposeUnpooledTerrainMaterial(provisional);
  } catch (error) {
    const errors: unknown[] = [error];
    try { mesh.geometry.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    try { mount.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    throw new AggregateError(errors, "biome surface material installation failed");
  }
  mesh.userData.derivedBiomeSurface = Object.freeze({
    artifact: surface.artifact,
    source: surface.decoded.source,
    coord: surface.decoded.coord,
  });
  mesh.geometry.userData.derivedBiomeSurface = true;
  return mount;
}

const UNSTAGED_POPULATION_STATUS: Readonly<DerivedPresentationStatus> = Object.freeze({
  groundCover: "unfulfilled" as const,
  groundCoverTiles: 0,
  groundCoverBlades: 0,
  climateProfiles: Object.freeze([]),
  canopy: "unfulfilled" as const,
  canopyReason: "verified biome population has not been mounted",
  groundCoverReason: "verified biome population has not been mounted",
  populationPlacements: 0,
});

/** Default per-slice main-thread budget for frame-budgeted mounting (C2). ~half a
 *  60 Hz frame, leaving room for input/worker servicing between slices. */
export const DERIVED_MOUNT_FRAME_BUDGET_MS = 8;

const mountNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/** Yield one macrotask so the event loop can service input, worker messages, and
 *  (where not gated) a frame. MessageChannel avoids the nested-setTimeout clamp. */
const yieldToEventLoop = (): Promise<void> => {
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
};

/** One staged-but-unmounted terrain window (createWithFrameBudget's deferred state). */
type DeferredTerrainStage = Readonly<{
  stagedTiles: readonly Readonly<{ chunk: ReturnType<typeof selectDerivedTerrainChunks>[number]; tile: TerrainTile }>[];
  surfaceFrame: ReturnType<typeof terrainWindowSurfaceFrame>;
}>;

// Module-private constructor mode flag: only createWithFrameBudget sets it, around a
// synchronous `new`, so the public constructor signature (and its option validation)
// stays closed while the factory defers chunk mounting into budgeted slices.
let deferTerrainMountForCreate = false;

/** Detached initial camera-window candidate. Dynamic post-activation streaming remains the live adapter's job.
 *  Two construction paths share every check and mount step:
 *    - `new` mounts the whole window synchronously (headless gates, small windows);
 *    - `createWithFrameBudget` mounts it in ~8 ms main-thread slices (C2) — the live
 *      viewport path, so a 225-chunk residency window cannot stall the event loop. */
export class DetachedDerivedRenderCandidate {
  readonly snapshot: ParsedTransferredDerivedSnapshot;
  readonly root = new THREE.Group();
  readonly terrainRoot = new THREE.Group();
  readonly waterRoot = new THREE.Group();
  readonly overviewRoot = new THREE.Group();
  readonly populationRoot = new THREE.Group();
  /** Compatibility alias; all vegetation now belongs to the verified population mount. */
  readonly groundCoverRoot = this.populationRoot;
  readonly #terrainMeshes = new Map<string, THREE.Mesh>();
  readonly #surfaceMounts = new Map<string, BiomeSurfaceMaterialMount>();
  readonly #waterManager: VisibleWaterManager;
  #waterMount: GeneratedWaterRenderMount | null = null;
  #overviewMesh: THREE.Mesh | null = null;
  #overviewBounds: Readonly<DetachedWorldOverviewBounds> | null = null;
  #terrainWindow: readonly DetachedDerivedTerrainWindowEntry[] = Object.freeze([]);
  #pendingStage: DeferredTerrainStage | null = null;
  #populationMount: DetachedDerivedPopulationMount | null = null;
  #populationStage: "available" | "staging" | "staged" | "failed" = "available";
  #presentationStatus: Readonly<DerivedPresentationStatus> = UNSTAGED_POPULATION_STATUS;
  #disposed = false;

  constructor(snapshotInput: ParsedTransferredDerivedSnapshot, options: DetachedDerivedRenderCandidateOptions) {
    const optionRecord = plain(options, "detached derived render candidate options");
    const optionKeys = Object.getOwnPropertyNames(optionRecord);
    const supportedOptions = new Set(["quality", "maxTerrainMeshes"]);
    if (optionKeys.some((key) => !supportedOptions.has(key))) {
      throw new TypeError("detached derived render candidate options are invalid");
    }
    for (const key of optionKeys) {
      const field = Object.getOwnPropertyDescriptor(optionRecord, key);
      if (field?.enumerable !== true || field.get !== undefined || field.set !== undefined) {
        throw new TypeError(`detached derived render candidate options.${key} must be an enumerable data field`);
      }
    }
    const maxMeshes = options.maxTerrainMeshes ?? MAX_DETACHED_DERIVED_TERRAIN_MESHES;
    if (!Number.isSafeInteger(maxMeshes) || maxMeshes < 1 || maxMeshes > MAX_DETACHED_DERIVED_TERRAIN_MESHES) {
      throw new RangeError(`derived terrain maxTerrainMeshes must be in [1, ${MAX_DETACHED_DERIVED_TERRAIN_MESHES}]`);
    }
    const tier = options.quality ?? "balanced";
    const quality = DEFAULT_RENDER_QUALITY_PROFILES[tier];
    if (quality === undefined) throw new TypeError("derived render quality tier is invalid");
    // Verify-before-construct: only derived-runtime-verify mints this input (branded
    // type + runtime WeakSet), so unverified bytes cannot reach mounting.
    this.snapshot = assertVerifiedTransferredDerivedSnapshot(snapshotInput);

    this.root.name = `limina:derived-revision:${this.snapshot.manifestHash}`;
    this.terrainRoot.name = "limina:derived-terrain";
    this.waterRoot.name = "limina:derived-water";
    this.overviewRoot.name = "limina:world-overview";
    this.populationRoot.name = "limina:derived-biome-population";
    this.root.add(this.overviewRoot, this.terrainRoot, this.waterRoot, this.populationRoot);
    this.#waterManager = new VisibleWaterManager(this.waterRoot, quality.water);
    const available = selectDerivedTerrainChunks(this.snapshot.manifest, this.snapshot.residency);
    if (available.length > maxMeshes) throw new RangeError(`derived terrain window requires ${available.length} meshes, exceeding budget ${maxMeshes}`);
    const stagedTiles = available.map((chunk) => Object.freeze({ chunk, tile: this.snapshot.terrain.tile(chunk.tx, chunk.tz)! }));
    const surfaceFrame = terrainWindowSurfaceFrame(
      stagedTiles.map((entry) => entry.tile),
      this.snapshot.generatedWater?.render.field.seaLevelM,
    );
    if (deferTerrainMountForCreate) {
      // createWithFrameBudget owns the (async, sliced) mounting from here; every
      // selection/budget check above already ran, so the deferred path can only
      // fail inside the same mount steps the synchronous path runs.
      this.#pendingStage = Object.freeze({ stagedTiles: Object.freeze(stagedTiles), surfaceFrame });
      return;
    }
    try {
      const terrainWindow: DetachedDerivedTerrainWindowEntry[] = [];
      for (const { chunk, tile } of stagedTiles) this.#mountTerrainChunk(chunk, tile, surfaceFrame, terrainWindow);
      this.#mountOverview(terrainWindow);
      this.#finishTerrainMount(terrainWindow);
    } catch (error) {
      // dispose() is exactly the partial-mount rollback; swallow its errors so the
      // original staging failure is what escapes the constructor.
      try { this.dispose(); } catch { /* preserve the staging error */ }
      throw error;
    }
  }

  /** Mount ONE resident chunk: geometry, optional surface material, window entry, scene attach. */
  #mountTerrainChunk(
    chunk: DeferredTerrainStage["stagedTiles"][number]["chunk"],
    tile: TerrainTile,
    surfaceFrame: DeferredTerrainStage["surfaceFrame"],
    terrainWindow: DetachedDerivedTerrainWindowEntry[],
  ): void {
    const mesh = featureLocalTerrainMesh(tile, surfaceFrame);
    const key = tileKey(chunk.tx, chunk.tz);
    const surface = this.snapshot.surfaceAt(chunk.tx, chunk.tz);
    const surfaceMount = surface === undefined ? null : installBiomeSurfaceMaterial(mesh, surface);
    this.#terrainMeshes.set(key, mesh);
    if (surfaceMount !== null) this.#surfaceMounts.set(key, surfaceMount);
    terrainWindow.push(Object.freeze({ key, tx: chunk.tx, tz: chunk.tz, tile, ...(surface === undefined ? {} : { surface }) }));
    this.terrainRoot.add(mesh);
  }

  /** Overview mount — its 129x129 grid build is the single largest non-chunk step, so
   *  the frame-budgeted path gives it a slice of its own. */
  #mountOverview(terrainWindow: DetachedDerivedTerrainWindowEntry[]): void {
    if (this.snapshot.worldOverview === null) return;
    const built = buildWorldOverviewMesh(this.snapshot.worldOverview, terrainWindow);
    this.#overviewMesh = built.mesh;
    this.#overviewBounds = built.bounds;
    this.overviewRoot.add(built.mesh);
  }

  /** Water mount and the frozen window — after this the candidate is fully staged. */
  #finishTerrainMount(terrainWindow: DetachedDerivedTerrainWindowEntry[]): void {
    if (this.snapshot.generatedWater !== null) {
      this.#waterMount = mountGeneratedWaterResource(this.snapshot.generatedWater.render, this.#waterManager);
    }
    this.#terrainWindow = Object.freeze(terrainWindow);
  }

  /** C2 frame-budgeted construction: identical checks and mount steps to `new`, but the
   *  per-chunk mounting loop yields the main thread whenever a slice exceeds
   *  `frameBudgetMs` (default 8 ms), so input and worker traffic keep flowing during a
   *  full residency-window mount. `onSlice` runs after every yield and may throw to
   *  cancel (browser-entry passes its activation `cancelled` hook); on any failure the
   *  partial candidate is disposed before the error escapes, exactly like `new`. */
  static async createWithFrameBudget(
    snapshotInput: ParsedTransferredDerivedSnapshot,
    options: DetachedDerivedRenderCandidateOptions,
    slicing: Readonly<{ frameBudgetMs?: number; onSlice?: () => void }> = {},
  ): Promise<DetachedDerivedRenderCandidate> {
    const budgetMs = slicing.frameBudgetMs ?? DERIVED_MOUNT_FRAME_BUDGET_MS;
    if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError("derived mount frameBudgetMs must be a positive finite number of milliseconds");
    }
    if (slicing.onSlice !== undefined && typeof slicing.onSlice !== "function") {
      throw new TypeError("derived mount onSlice must be a function");
    }
    deferTerrainMountForCreate = true;
    let candidate: DetachedDerivedRenderCandidate;
    try { candidate = new DetachedDerivedRenderCandidate(snapshotInput, options); }
    finally { deferTerrainMountForCreate = false; }
    try {
      const pending = candidate.#pendingStage!;
      candidate.#pendingStage = null;
      const nextSlice = async (): Promise<void> => {
        await yieldToEventLoop();
        slicing.onSlice?.();
        if (candidate.#disposed) throw new Error("detached derived render candidate was disposed during frame-budgeted mounting");
      };
      const terrainWindow: DetachedDerivedTerrainWindowEntry[] = [];
      // First yield BEFORE any chunk mounts: the constructor's synchronous staging
      // (selection + surface frame scan) already ran in the caller's task, and the
      // first chunk mounts pay one-time JIT/material warmup — fusing them measured a
      // 67 ms cold task on the first activation of a session.
      await nextSlice();
      let sliceStart = mountNow();
      for (const { chunk, tile } of pending.stagedTiles) {
        if (mountNow() - sliceStart >= budgetMs) {
          await nextSlice();
          sliceStart = mountNow();
        }
        candidate.#mountTerrainChunk(chunk, tile, pending.surfaceFrame, terrainWindow);
      }
      // The overview grid build and the caller's continuation (stage prep + transfer
      // serialize) each get a fresh slice: leaving them fused to the last chunk slice
      // measured 54-75 ms tasks — over the 50 ms C2 budget.
      await nextSlice();
      candidate.#mountOverview(terrainWindow);
      await nextSlice();
      candidate.#finishTerrainMount(terrainWindow);
      return candidate;
    } catch (error) {
      try { candidate.dispose(); } catch { /* preserve the mounting error */ }
      throw error;
    }
  }

  get overviewBounds(): Readonly<DetachedWorldOverviewBounds> | null { return this.#overviewBounds; }

  get disposed(): boolean { return this.#disposed; }
  get terrainMeshCount(): number { return this.#terrainMeshes.size; }
  get waterFragmentCount(): number { return this.#waterManager.size; }
  get groundCoverBladeCount(): number { return this.#presentationStatus.groundCoverBlades; }
  get groundCoverTileCount(): number { return this.#presentationStatus.groundCoverTiles; }
  presentationStatus(): Readonly<DerivedPresentationStatus> { return this.#presentationStatus; }
  get overviewMeshCount(): number { return this.#disposed || this.#overviewMesh === null ? 0 : 1; }
  get overviewTriangleCount(): number {
    const index = this.#overviewMesh?.geometry.index;
    return this.#disposed || index === null || index === undefined ? 0 : index.count / 3;
  }
  get quality(): Readonly<WaterRenderQuality> { return this.#waterManager.quality; }

  /** Exact initial bounded window for main/sim collider staging; no internal mutable map escapes. */
  terrainWindow(): readonly DetachedDerivedTerrainWindowEntry[] { return this.#terrainWindow; }

  /**
   * Mount the independently verified aggregate population exactly once. The factory receives a
   * candidate-owned scene root and must roll back its own provisional resources if it throws.
   * Once it returns, the candidate assumes terminal disposal ownership of the mount.
   */
  async stagePopulation(factory: DetachedDerivedPopulationFactory): Promise<void> {
    if (this.#disposed) throw new Error("detached derived render candidate is disposed");
    if (typeof factory !== "function") throw new TypeError("derived population factory must be a function");
    const plan = this.snapshot.populationPlan;
    if (plan === null) throw new Error("detached derived render candidate has no verified population plan");
    if (this.#populationStage !== "available") {
      throw new Error(`detached derived population stage is already ${this.#populationStage}`);
    }
    this.#populationStage = "staging";
    let mount: DetachedDerivedPopulationMount | null = null;
    try {
      if (this.snapshot.biomeContent === null) throw new Error("detached derived population has no verified content closure");
      if (this.snapshot.biomeRuntimePack === null || this.snapshot.biomeField === null) {
        throw new Error("detached derived population is missing its biome field or runtime pack");
      }
      const biomeFieldBytes = encodeBiomeFieldArtifact(this.snapshot.biomeField.field);
      const waterCoverageAt = this.snapshot.generatedWater === null
        ? (_x: number, _z: number): boolean => false
        // Cover the full distant-grass candidate jitter/footprint, not only the grid sample point.
        // A narrower seam lets an accepted LOD1 cluster jitter back into the rendered river.
        : (x: number, z: number): boolean => generatedWaterCoversPoint(this.snapshot.generatedWater!.render, x, z, 0.8);
      mount = await factory(Object.freeze({ plan, content: this.snapshot.biomeContent, root: this.populationRoot,
        terrainWindow: this.#terrainWindow,
        biomeField: Object.freeze({ bytes: biomeFieldBytes, contentHash: plan.identity.fieldContentHash }),
        runtimePack: this.snapshot.biomeRuntimePack, waterCoverageAt }));
      if (mount === null || typeof mount !== "object" || typeof mount.dispose !== "function") {
        throw new TypeError("derived population factory returned an invalid mount");
      }
      for (const [label, value] of [
        ["canopyInstances", mount.canopyInstances],
        ["groundCoverTiles", mount.groundCoverTiles],
        ["groundCoverBlades", mount.groundCoverBlades],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new TypeError(`derived population mount.${label} must be a non-negative safe integer`);
        }
      }
      if (this.#disposed) throw new Error("detached derived render candidate was disposed during population staging");
      this.#populationMount = mount;
      this.#populationStage = "staged";
      this.#presentationStatus = Object.freeze({
        groundCover: mount.groundCoverBlades > 0 ? "ready" as const : "empty" as const,
        groundCoverTiles: mount.groundCoverTiles,
        groundCoverBlades: mount.groundCoverBlades,
        climateProfiles: Object.freeze([]),
        canopy: mount.canopyInstances > 0 ? "ready" as const : "empty" as const,
        canopyReason: mount.canopyInstances > 0
          ? "verified biome population mount is active"
          : "verified biome population contains no resident canopy",
        groundCoverReason: mount.groundCoverBlades > 0
          ? "verified biome population mount is active"
          : "verified biome population contains no resident ground cover",
        populationPlacements: plan.placements.length,
      });
    } catch (primary) {
      this.#populationStage = "failed";
      this.populationRoot.clear();
      if (mount !== null && this.#populationMount !== mount) {
        try { mount.dispose(); } catch (rollback) {
          throw new AggregateError([primary, rollback], "derived population staging and rollback failed");
        }
      }
      throw primary;
    }
  }

  setQuality(tier: RenderQualityTier): void {
    if (this.#disposed) throw new Error("detached derived render candidate is disposed");
    const profile = DEFAULT_RENDER_QUALITY_PROFILES[tier];
    if (profile === undefined) throw new TypeError("derived render quality tier is invalid");
    this.#waterManager.setQuality(profile.water);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    const populationMount = this.#populationMount;
    this.#populationMount = null;
    if (populationMount !== null) try { populationMount.dispose(); } catch (error) { errors.push(error); }
    this.populationRoot.clear();
    this.#presentationStatus = UNSTAGED_POPULATION_STATUS;
    try { this.#waterMount?.dispose(); } catch (error) { errors.push(error); }
    try { this.#waterManager.dispose(); } catch (error) { errors.push(error); }
    const overviewMesh = this.#overviewMesh;
    this.#overviewMesh = null;
    if (overviewMesh !== null) {
      this.overviewRoot.remove(overviewMesh);
      try { overviewMesh.geometry.dispose(); } catch (error) { errors.push(error); }
      try { (overviewMesh.material as THREE.Material).dispose(); } catch (error) { errors.push(error); }
    }
    for (const [key, mesh] of this.#terrainMeshes) {
      this.terrainRoot.remove(mesh);
      const surfaceMount = this.#surfaceMounts.get(key);
      if (surfaceMount === undefined) {
        try { disposeTerrainMesh(mesh); } catch (error) { errors.push(error); }
      } else {
        try { mesh.geometry.dispose(); } catch (error) { errors.push(error); }
        try { surfaceMount.dispose(); } catch (error) { errors.push(error); }
      }
    }
    this.#terrainMeshes.clear();
    this.#surfaceMounts.clear();
    this.root.clear();
    if (errors.length > 0) throw new AggregateError(errors, "detached derived render candidate disposal failed");
  }
}
