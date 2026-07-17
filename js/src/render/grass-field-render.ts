// Canonical grass-field renderer. Placement always comes from grass-field plans; WebGPU uses
// compute-backed fixed slots and forceWebGL/editable terrain use the same plans on CPU.

import * as THREE from "../../build/three.bundle.mjs";
import type { AssetInstance } from "../terrain/asset-scatter.ts";
import type { TerrainTile } from "../terrain/types.ts";
import {
  type GrassFieldQualityTier,
  type GrassFieldSourceOptions,
} from "./grass-field-config.ts";
import { grassFieldBladesPerInstance, grassFieldInstanceSpacing, grassFieldVisualBounds, type GrassFieldLod, type GrassFieldVisualPackage, type GrassFieldVisualProfile } from "./grass-field-package.ts";
import { GRASS_FIELD_MAX_RESIDENT_SLOTS, grassFieldCandidate, grassFieldRandom } from "./grass-field-plan.ts";
import type { GrassFieldBounds, GrassFieldPlacement } from "./grass-field-plan.ts";
import { isNativeGrassFieldComputeRenderer, type GrassFieldComputeBatchInput, type GrassFieldComputeBatchResource,
  type GrassFieldComputeInput } from "./grass-field-compute.ts";
import { GrassFieldResidencyController, type GrassFieldResidencyLod, type GrassFieldResidencyMount } from "./grass-field-residency.ts";
import { buildNativeGrassFieldStreamMount, nativeGrassFieldStreamSlots } from "./grass-field-stream-mount.ts";
import { countGrassFieldTerrainPlacementCapacity, countGrassFieldTerrainSlots, grassFieldTerrainBounds, prepareGrassFieldTerrainPages } from "./grass-field-terrain.ts";

export type { GrassFieldQualityTier, GrassFieldSourceOptions } from "./grass-field-config.ts";

export interface GrassFieldScene {
  add(child: unknown): void;
  remove(child: unknown): void;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || !(resolved > 0)) throw new RangeError(`${label} must be finite and positive`);
  return resolved;
}

function prepared(tile: TerrainTile, source: GrassFieldSourceOptions, spacingMultiplier: number, bounds?: GrassFieldBounds) {
  return prepareGrassFieldTerrainPages(tile, {
    seed: source.seed,
    spacing: positive(source.spacing, 0.45, "grass field spacing") * spacingMultiplier,
    elevationMin: source.elevationMin,
    elevationMax: source.elevationMax,
    slopeMax: source.slopeMax,
    exclusions: source.exclusions,
    densityAt: source.densityAt,
    hardExclusionAt: source.hardExclusionAt,
    paintPolicy: source.paintPolicy,
    placement: source.placement,
  }, bounds ?? grassFieldTerrainBounds(tile));
}

function pagePlacements(tile: TerrainTile, source: GrassFieldSourceOptions, spacingMultiplier: number, bounds?: GrassFieldBounds): {
  placements: AssetInstance[]; slots: number;
} {
  const pages = prepared(tile, source, spacingMultiplier, bounds);
  const placements: AssetInstance[] = [];
  let slots = 0;
  const sizeRange = source.sizeRange ?? [0.7, 1.3];
  for (const page of pages) {
    slots += page.plan.slots;
    for (let slot = 0; slot < page.plan.slots; slot++) {
      if (page.plan.accepted[slot] !== 1) continue;
      const candidate = grassFieldCandidate(page.plan, slot);
      const style = grassFieldRandom(source.seed, candidate.gridX, candidate.gridZ, 2);
      placements.push({
        assetId: "__grass_field__", x: candidate.x, y: page.heights[slot], z: candidate.z,
        yaw: (style & 0xffff) * Math.PI * 2 / 65536,
        scale: sizeRange[0] + (style >>> 16) / 65536 * (sizeRange[1] - sizeRange[0]),
      });
    }
  }
  return { placements, slots };
}

function boundedPlacements(placements: readonly AssetInstance[], cap: number,
  center: Readonly<{ x: number; z: number }>): readonly AssetInstance[] {
  if (placements.length <= cap) return placements;
  // Budget AREA, never density. Hash-thinning a whole field recreates isolated wisps. A static
  // mount retains the closest contiguous portion; streamed mounts move this bounded area with the
  // camera through residency cells.
  return [...placements].sort((left, right) => {
    const ld = (left.x - center.x) ** 2 + (left.z - center.z) ** 2;
    const rd = (right.x - center.x) ** 2 + (right.z - center.z) ** 2;
    return ld - rd || left.z - right.z || left.x - right.x;
  }).slice(0, cap);
}

/** Clip an oversized static field to a centered, world-grid-aligned rectangle before allocating
 * plans. Density is invariant; a blade budget limits covered area instead of rejecting a full
 * dense tile at the resident-slot guard or hash-thinning it after allocation. */
function budgetedBounds(bounds: GrassFieldBounds, spacing: number, maxSlots: number): GrassFieldBounds {
  const minGridX = Math.floor(bounds.minX / spacing), maxGridX = Math.ceil(bounds.maxX / spacing);
  const minGridZ = Math.floor(bounds.minZ / spacing), maxGridZ = Math.ceil(bounds.maxZ / spacing);
  const columns = maxGridX - minGridX, rows = maxGridZ - minGridZ;
  if (columns * rows <= maxSlots) return bounds;
  const targetColumns = Math.min(columns, Math.max(1, Math.floor(Math.sqrt(maxSlots * columns / rows))));
  const targetRows = Math.min(rows, Math.max(1, Math.floor(maxSlots / targetColumns)));
  const centerGridX = (bounds.minX + bounds.maxX) / (2 * spacing);
  const centerGridZ = (bounds.minZ + bounds.maxZ) / (2 * spacing);
  const startX = Math.max(minGridX, Math.min(maxGridX - targetColumns, Math.floor(centerGridX - targetColumns / 2)));
  const startZ = Math.max(minGridZ, Math.min(maxGridZ - targetRows, Math.floor(centerGridZ - targetRows / 2)));
  return Object.freeze({
    minX: Math.max(bounds.minX, startX * spacing),
    minZ: Math.max(bounds.minZ, startZ * spacing),
    maxX: Math.min(bounds.maxX, (startX + targetColumns) * spacing),
    maxZ: Math.min(bounds.maxZ, (startZ + targetRows) * spacing),
  });
}

function buildFieldMesh(placements: readonly AssetInstance[], pkg: GrassFieldVisualPackage,
  quality: GrassFieldQualityTier, lod: GrassFieldLod, variant: string | undefined,
  featureOrigin: readonly [number, number, number], presentationBand?: string): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const context = { quality, lod, maxBlades: placements.length, featureOrigin,
    ...(variant === undefined ? {} : { variant }),
    ...(presentationBand === undefined ? {} : { presentationBand }) } as const;
  const geometry = pkg.createGeometry(context);
  const wind = new Float32Array(placements.length * 4);
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const mesh = new THREE.InstancedMesh(geometry, pkg.createMaterial(context), placements.length);
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index];
    position.set(placement.x - featureOrigin[0], placement.y - featureOrigin[1], placement.z - featureOrigin[2]);
    rotation.setFromAxisAngle(yAxis, placement.yaw);
    scale.setScalar(placement.scale);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    wind[index * 4] = placement.x - featureOrigin[0];
    wind[index * 4 + 1] = placement.z - featureOrigin[2];
    wind[index * 4 + 3] = placement.yaw;
  }
  geometry.setAttribute("aWind", new THREE.InstancedBufferAttribute(wind, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.position.set(...featureOrigin);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Synchronous canonical-plan mount for editable terrain and forceWebGL. */
export class GrassFieldTileMount {
  private mesh: THREE.InstancedMesh | null = null;
  private acceptedInstances = 0;
  private slots = 0;
  private disposed = false;

  constructor(
    private readonly scene: GrassFieldScene,
    private readonly tile: TerrainTile,
    private readonly source: () => GrassFieldSourceOptions,
    private readonly visualPackage: GrassFieldVisualPackage,
    private readonly quality: GrassFieldQualityTier = "balanced",
    private readonly lod: GrassFieldLod = 0,
    private readonly spacingMultiplier = 1,
    private readonly variant?: string,
    private readonly maxBlades?: number,
    private readonly requestedBounds?: GrassFieldBounds,
    private readonly presentationBand?: string,
  ) { this.refreshAll(); }

  instanceCount(): number { return this.acceptedInstances; }
  bladeCount(): number { return this.acceptedInstances * grassFieldBladesPerInstance(
    this.visualPackage.profile(this.quality), this.lod, this.presentationBand); }
  slotCount(): number { return this.slots; }
  chunkCount(): number { return this.mesh === null ? 0 : 1; }
  chunkMeshes(): THREE.InstancedMesh[] { return this.mesh === null ? [] : [this.mesh]; }

  refreshCircle(_x: number, _z: number, _radius: number): void { this.refreshAll(); }

  refreshAll(): void {
    if (this.disposed) return;
    const profile = this.visualPackage.profile(this.quality);
    const authored = this.source();
    const packageSpacing = grassFieldInstanceSpacing(this.visualPackage, this.quality, this.lod);
    const resolvedSource = {
      ...authored,
      // Denser authoring is allowed; sparser authoring cannot silently violate the package's
      // published visual-density contract.
      spacing: Math.min(authored.spacing ?? packageSpacing, packageSpacing),
    };
    const bladeBudget = Math.min(profile.maxResidentBlades, this.maxBlades ?? Number.MAX_SAFE_INTEGER);
    const authoredBounds = this.requestedBounds ?? grassFieldTerrainBounds(this.tile);
    const bladesPerInstance = grassFieldBladesPerInstance(profile, this.lod, this.presentationBand);
    const maxInstances = Math.max(1, Math.floor(bladeBudget / bladesPerInstance));
    const spacing = resolvedSource.spacing * this.spacingMultiplier;
    const bounds = budgetedBounds(authoredBounds, spacing,
      Math.min(GRASS_FIELD_MAX_RESIDENT_SLOTS, maxInstances));
    const built = pagePlacements(this.tile, resolvedSource, this.spacingMultiplier, bounds);
    const placements = boundedPlacements(built.placements,
      maxInstances,
      { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 });
    const visual = grassFieldVisualBounds(profile, this.lod, this.presentationBand);
    const next = buildFieldMesh(placements, this.visualPackage, this.quality, this.lod, this.variant, this.tile.origin,
      this.presentationBand);
    if (next !== null) {
      next.name = "limina:grass-field-tile";
      next.frustumCulled = true;
      next.computeBoundingSphere();
      const radius = next.boundingSphere?.radius;
      if (radius !== undefined) next.boundingSphere!.radius = radius + visual.maxHeight * 0.7
        + visual.maxHorizontalDisplacement + visual.footprintRadius;
      this.scene.add(next);
    }
    const prior = this.mesh;
    this.mesh = next;
    this.acceptedInstances = placements.length;
    this.slots = built.slots;
    if (prior !== null) {
      this.scene.remove(prior);
      prior.geometry.dispose();
      (prior.material as THREE.Material).dispose();
      prior.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const mesh = this.mesh;
    this.mesh = null;
    if (mesh === null) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh.dispose();
  }
}

export interface GrassFieldStreamOptions {
  readonly tileSize: number;
  /** Optional smaller residency cell. Continuous meadow packages use this to spend their blade
   * budget around the camera instead of diluting one full terrain tile. Must divide tileSize. */
  readonly cellSize?: number;
  readonly visualPackage: GrassFieldVisualPackage;
  readonly quality?: GrassFieldQualityTier;
  readonly variant?: string;
  readonly radius?: number;
  readonly fineRadius?: number;
  readonly forcedLod?: GrassFieldResidencyLod;
  readonly spacingMultipliers?: readonly [number, number];
  readonly presentationBand?: string;
  readonly placement?: GrassFieldPlacement;
  readonly maxResidentBlades?: number;
  readonly source: (tile: TerrainTile) => GrassFieldSourceOptions;
  readonly renderer?: unknown;
  readonly buildComputeBatch?: (input: GrassFieldComputeBatchInput) => GrassFieldComputeBatchResource;
  readonly onError?: (error: unknown) => void;
}

interface StreamSource { readonly tile: TerrainTile; readonly options: Readonly<GrassFieldSourceOptions>; readonly bounds: GrassFieldBounds }
interface CountedMount extends GrassFieldResidencyMount { readonly accepted: number }

class CpuMount implements CountedMount {
  private published = false;
  private disposed = false;
  constructor(private readonly scene: GrassFieldScene, private readonly root: THREE.Group,
    private readonly field: GrassFieldTileMount, readonly slots: number, readonly accepted: number) {}
  get cost(): number { return this.accepted; }
  commit(previous?: GrassFieldResidencyMount): void {
    if (this.disposed) throw new Error("cannot publish a disposed CPU grass field");
    this.scene.add(this.root);
    if (previous instanceof CpuMount) previous.unpublish();
    this.published = true;
  }
  unpublish(): void { if (this.published) { this.scene.remove(this.root); this.published = false; } }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.published) this.scene.remove(this.root);
    this.field.dispose();
    this.root.clear();
  }
}

class TrackedMount implements CountedMount {
  constructor(private readonly key: string, private readonly inner: CountedMount,
    private readonly published: Map<string, CountedMount>) {}
  get slots(): number { return this.inner.slots; }
  get cost(): number { return this.inner.cost ?? this.inner.slots; }
  get accepted(): number { return this.inner.accepted; }
  commit(previous?: GrassFieldResidencyMount): void {
    this.inner.commit(previous instanceof TrackedMount ? previous.inner : previous);
    this.published.set(this.key, this);
  }
  dispose(): void {
    this.inner.dispose();
    if (this.published.get(this.key) === this) this.published.delete(this.key);
  }
}

export class GrassFieldStreamManager {
  private readonly residency: GrassFieldResidencyController<StreamSource>;
  private readonly published = new Map<string, CountedMount>();
  private readonly native: boolean;
  private readonly renderer?: GrassFieldComputeInput["renderer"];
  private readonly profile: GrassFieldVisualProfile;
  private readonly quality: GrassFieldQualityTier;
  private readonly cellSize: number;
  private readonly childKeys = new Map<string, readonly string[]>();
  private cleared = false;

  constructor(private readonly scene: GrassFieldScene, private readonly options: GrassFieldStreamOptions) {
    this.quality = options.quality ?? "balanced";
    this.cellSize = options.cellSize ?? options.tileSize;
    if (!Number.isFinite(this.cellSize) || !(this.cellSize > 0)
        || !Number.isInteger(Math.round(options.tileSize / this.cellSize))
        || Math.abs(Math.round(options.tileSize / this.cellSize) * this.cellSize - options.tileSize) > 1e-6) {
      throw new RangeError("grass field cellSize must be a positive divisor of tileSize");
    }
    this.profile = options.visualPackage.profile(this.quality);
    this.renderer = options.renderer as GrassFieldComputeInput["renderer"] | undefined;
    this.native = this.renderer !== undefined && isNativeGrassFieldComputeRenderer(this.renderer);
    const multipliers = options.spacingMultipliers ?? this.profile.spacingMultipliers;
    const radius = options.radius ?? this.profile.radius;
    const fineRadius = options.fineRadius ?? Math.min(this.profile.fineRadius, radius);
    this.residency = new GrassFieldResidencyController<StreamSource>({
      tileSize: this.cellSize,
      radius,
      hysteresis: 1,
      fineRadius,
      ...(options.forcedLod === undefined ? {} : { forcedLod: options.forcedLod }),
      spacingMultipliers: multipliers,
      maxResidentSlots: GRASS_FIELD_MAX_RESIDENT_SLOTS,
      maxResidentCost: options.maxResidentBlades ?? this.profile.maxResidentBlades,
      estimateSlots: (entry, _lod, spacingMultiplier) => this.native
        ? nativeGrassFieldStreamSlots({ tile: entry.tile, source: entry.options, spacingMultiplier, requestedBounds: entry.bounds })
        : countGrassFieldTerrainSlots(entry.tile,
          positive(entry.options.spacing, 0.45, "grass field spacing") * spacingMultiplier, entry.bounds),
      estimateCost: (entry, lod, spacingMultiplier, slots) => {
        const bladesPerInstance = grassFieldBladesPerInstance(this.profile, lod, options.presentationBand);
        if (entry.options.placement === undefined) return slots * bladesPerInstance;
        const spacing = positive(entry.options.spacing, 0.45, "grass field spacing") * spacingMultiplier;
        return countGrassFieldTerrainPlacementCapacity(entry.tile, spacing, entry.options.seed,
          entry.options.placement, entry.bounds) * bladesPerInstance;
      },
      build: async (input) => {
        const lod = input.lod as GrassFieldResidencyLod;
        let mount: CountedMount;
        if (this.native) {
          mount = await buildNativeGrassFieldStreamMount({ scene: this.scene, renderer: this.renderer!,
            tile: input.source.tile, source: input.source.options, spacingMultiplier: input.spacingMultiplier,
            requestedBounds: input.source.bounds,
            visualPackage: options.visualPackage, quality: this.quality, lod,
            ...(options.variant === undefined ? {} : { variant: options.variant }),
            ...(options.presentationBand === undefined ? {} : { presentationBand: options.presentationBand }),
            buildComputeBatch: options.buildComputeBatch });
        } else {
          const root = new THREE.Group(); root.name = "limina:grass-field-fallback";
          const field = new GrassFieldTileMount(root, input.source.tile, () => input.source.options,
            options.visualPackage, this.quality, lod, input.spacingMultiplier, options.variant, undefined,
            input.source.bounds, options.presentationBand);
          mount = new CpuMount(this.scene, root, field, field.slotCount(), field.bladeCount());
        }
        return new TrackedMount(input.key, mount, this.published);
      },
      onError: options.onError,
    });
  }

  noteTile(key: string, coord: { tx: number; tz: number }, tile: TerrainTile): void {
    if (this.cleared) return;
    this.dropTile(key);
    const options = Object.freeze({ ...this.options.source(tile),
      ...(this.options.placement === undefined ? {} : { placement: this.options.placement }) });
    if (this.cellSize === this.options.tileSize) {
      const bounds = grassFieldTerrainBounds(tile);
      this.residency.noteTile(key, coord, Object.freeze({ tile, options, bounds }));
      this.childKeys.set(key, Object.freeze([key]));
      return;
    }
    const tileBounds = grassFieldTerrainBounds(tile);
    const minCellX = Math.floor(tileBounds.minX / this.cellSize + 1e-9);
    const minCellZ = Math.floor(tileBounds.minZ / this.cellSize + 1e-9);
    const maxCellX = Math.ceil(tileBounds.maxX / this.cellSize - 1e-9) - 1;
    const maxCellZ = Math.ceil(tileBounds.maxZ / this.cellSize - 1e-9) - 1;
    const keys: string[] = [];
    for (let cz = minCellZ; cz <= maxCellZ; cz++) for (let cx = minCellX; cx <= maxCellX; cx++) {
      const child = `${key}@${cx}:${cz}`;
      const bounds = Object.freeze({
        minX: Math.max(tileBounds.minX, cx * this.cellSize), minZ: Math.max(tileBounds.minZ, cz * this.cellSize),
        maxX: Math.min(tileBounds.maxX, (cx + 1) * this.cellSize), maxZ: Math.min(tileBounds.maxZ, (cz + 1) * this.cellSize),
      });
      this.residency.noteTile(child, { tx: cx, tz: cz }, Object.freeze({ tile, options, bounds }));
      keys.push(child);
    }
    this.childKeys.set(key, Object.freeze(keys));
  }
  dropTile(key: string): void {
    const children = this.childKeys.get(key) ?? [key];
    for (const child of children) this.residency.dropTile(child);
    this.childKeys.delete(key);
  }
  grassKeys(): Set<string> { return this.residency.activeKeys(); }
  activeLod(key: string): 0 | 1 | undefined { return this.residency.activeLod(key); }
  residentSlots(): Readonly<{ active: number; pending: number; total: number }> { return this.residency.residentSlots(); }
  residentBladeCost(): Readonly<{ active: number; pending: number; total: number }> { return this.residency.residentCost(); }
  bladeCount(): number { let count = 0; for (const mount of this.published.values()) count += mount.accepted; return count; }
  update(anchorX: number, anchorZ: number) {
    const result = this.residency.update(anchorX, anchorZ);
    return { grown: result.launched === null ? 0 : 1, dropped: result.dropped, active: result.active,
      pending: result.pending, blocked: result.blocked };
  }
  async settle(): Promise<void> { await this.residency.settle(); }
  takeErrors(): unknown[] { return this.residency.takeErrors(); }
  async clear(): Promise<void> {
    if (this.cleared) { await this.residency.clear(); return; }
    this.cleared = true;
    await this.residency.clear();
    this.published.clear();
    this.childKeys.clear();
  }
}
