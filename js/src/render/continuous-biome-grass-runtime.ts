import * as THREE from "../../build/three.bundle.mjs";
import type { CameraLike } from "../engine.ts";
import type { TerrainTile } from "../terrain/types.ts";
import type { GrassFieldQualityTier, GrassFieldSourceOptions } from "./grass-field-config.ts";
import {
  CONTINUOUS_GRASS_FAR_SURFACE_FADE_M,
  grassFieldBladesPerInstance,
  grassFieldInstanceSpacing,
  type GrassFieldVisualPackage,
} from "./grass-field-package.ts";
import { GrassFieldStreamManager, type GrassFieldScene } from "./grass-field-render.ts";

export interface ContinuousBiomeGrassTile {
  readonly key: string;
  readonly tx: number;
  readonly tz: number;
  readonly tile: TerrainTile;
}

export interface ContinuousBiomeGrassRuntimeInput {
  readonly role: string;
  readonly tiles: readonly ContinuousBiomeGrassTile[];
  readonly densityAt: (x: number, z: number) => number;
  readonly hardExclusionAt?: (x: number, z: number) => boolean;
  readonly visualPackage: GrassFieldVisualPackage;
  readonly quality: GrassFieldQualityTier;
  readonly variant: string;
  readonly bladeScale: readonly [number, number];
  readonly scene: GrassFieldScene;
  readonly camera: CameraLike;
  readonly renderer?: unknown;
  readonly onError?: (error: unknown) => void;
}

function cameraXZ(camera: CameraLike): Readonly<{ x: number; z: number }> {
  const source = camera as unknown as { position?: { x?: number; z?: number }; getWorldPosition?: (target: any) => any };
  if (source.getWorldPosition !== undefined) {
    const target = new THREE.Vector3();
    source.getWorldPosition(target);
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) throw new RangeError("continuous grass camera must be finite");
    return Object.freeze({ x: target.x, z: target.z });
  }
  const x = source.position?.x ?? 0, z = source.position?.z ?? 0;
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError("continuous grass camera must be finite");
  return Object.freeze({ x, z });
}

/** Camera-local, density-field grass. Sparse biome-object placements are not consumed. Packages
 * may group a small number of honestly counted modeled blades in one instance; package density
 * remains an actual-blades target and the hard budget is always measured in actual blades. */
export class ContinuousBiomeGrassRuntime {
  readonly maxResidentBlades: number;
  private readonly managers: readonly GrassFieldStreamManager[];
  private readonly parentKeys: readonly string[];
  private disposed = false;

  private constructor(private readonly input: ContinuousBiomeGrassRuntimeInput, managers: readonly GrassFieldStreamManager[]) {
    this.managers = Object.freeze([...managers]);
    const profile = input.visualPackage.profile(input.quality);
    const farProxy = profile.farSurfaceProxy;
    if (farProxy !== undefined && (!Number.isFinite(farProxy.coverageEnd)
        || farProxy.coverageEnd <= CONTINUOUS_GRASS_FAR_SURFACE_FADE_M.end
        || farProxy.fadeIn.start !== CONTINUOUS_GRASS_FAR_SURFACE_FADE_M.start
        || farProxy.fadeIn.end !== CONTINUOUS_GRASS_FAR_SURFACE_FADE_M.end)) {
      throw new RangeError(`continuous grass package '${input.visualPackage.id}' has an incompatible far-surface handoff`);
    }
    this.maxResidentBlades = profile.maxResidentBlades
      + (profile.additionalContinuousBands ?? []).reduce((sum, band) => sum + band.maxResidentBlades, 0);
    this.parentKeys = Object.freeze(input.tiles.map((entry) => entry.key));
  }

  static async create(input: ContinuousBiomeGrassRuntimeInput): Promise<ContinuousBiomeGrassRuntime> {
    if (!input.visualPackage.variants.includes(input.variant)) {
      throw new Error(`grass visual package '${input.visualPackage.id}' does not support variant '${input.variant}'`);
    }
    const profile = input.visualPackage.profile(input.quality);
    const density = profile.bladesPerSquareMeter[0];
    if (!Number.isFinite(density) || density < 1 || density > 1_000) {
      throw new RangeError(`continuous grass package '${input.visualPackage.id}' has invalid near density`);
    }
    if (profile.bladesPerSquareMeter.some((value) => !Number.isFinite(value) || value <= 0 || value > 1_000)) {
      throw new RangeError(`continuous grass package '${input.visualPackage.id}' has invalid actual-blade density`);
    }
    if (input.bladeScale.length !== 2 || !input.bladeScale.every((value) => Number.isFinite(value) && value > 0)
        || input.bladeScale[0] > input.bladeScale[1]) throw new RangeError("continuous grass bladeScale is invalid");
    const tileSize = input.tiles[0]?.tile.scale[0];
    if (tileSize === undefined || !Number.isFinite(tileSize) || !(tileSize > 0)
        || input.tiles.some((entry) => entry.tile.scale[0] !== tileSize || entry.tile.scale[2] !== tileSize)) {
      throw new Error("continuous grass requires square, equal-sized terrain tiles");
    }
    // Cinematic uses 8 m residency cells so its high-density core spans the complete 5x5 primary
    // window. Its outer edge is therefore at or beyond the 16 m material fade-out for every camera
    // offset inside the anchor cell. A smaller fine ring changes from 260 independent blades/m2 to
    // clustered LOD1 while LOD0 is still opaque, exposing a world-axis rectangle in the field.
    const cellSize = tileSize / (input.quality === "cinematic" ? 6 : 3);
    const bladesPerNearInstance = profile.bladesPerInstance[0];
    if (!Number.isSafeInteger(bladesPerNearInstance) || bladesPerNearInstance < 1 || bladesPerNearInstance > 64
        || profile.bladesPerInstance.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 64)) {
      throw new RangeError(`continuous grass package '${input.visualPackage.id}' has invalid actual-blade accounting`);
    }
    const spacing = grassFieldInstanceSpacing(input.visualPackage, input.quality, 0);
    const source = (tile: TerrainTile): GrassFieldSourceOptions => ({ seed: 0x4d454144, spacing, slopeMax: 0.9, sizeRange: input.bladeScale,
        densityAt: input.densityAt, hardExclusionAt: input.hardExclusionAt,
        paintPolicy: "ignore",
        elevationMin: tile.origin[1] - Math.abs(tile.scale[1]) - 1 });
    const managerConfigs = [{
      id: "primary", cellSize, radius: profile.radius, fineRadius: profile.fineRadius,
      spacingMultipliers: profile.spacingMultipliers, maxResidentBlades: profile.maxResidentBlades,
      placement: undefined,
    }, ...(profile.additionalContinuousBands ?? []).map((band) => {
      if (band.id.length === 0 || !Number.isSafeInteger(band.cellSizeDivisor) || band.cellSizeDivisor < 1
          || tileSize / band.cellSizeDivisor <= 0 || !Number.isSafeInteger(band.radius) || band.radius < 0
          || (band.lod !== 0 && band.lod !== 1)
          || !Number.isSafeInteger(band.bladesPerInstance) || band.bladesPerInstance < 1
          || band.bladesPerInstance > 64 || !Number.isFinite(band.bladesPerSquareMeter)
          || band.bladesPerSquareMeter <= 0 || band.bladesPerSquareMeter > 1_000
          || !Number.isSafeInteger(band.maxResidentBlades) || band.maxResidentBlades < 1
          || ![band.fadeIn.start, band.fadeIn.end, band.fadeOut.start, band.fadeOut.end].every(Number.isFinite)
          || band.fadeIn.start < 0 || band.fadeIn.end <= band.fadeIn.start
          || band.fadeOut.start <= band.fadeIn.start || band.fadeOut.end <= band.fadeOut.start
          || !Number.isFinite(band.projectedAreaPerInstanceM2) || band.projectedAreaPerInstanceM2 <= 0
          || !Number.isFinite(band.targetProjectedCoverage) || band.targetProjectedCoverage <= 0
          || (band.placement !== undefined && (band.placement.strategy !== "world-matern-blue-noise/v1"
            || !Number.isSafeInteger(band.placement.oversample) || band.placement.oversample < 1
            || band.placement.oversample > 4 || !Number.isFinite(band.placement.minimumDistanceMultiplier)
            || band.placement.minimumDistanceMultiplier < 0.5 || band.placement.minimumDistanceMultiplier > 2))
          || (band.complementsLod !== undefined && band.complementsLod !== 0 && band.complementsLod !== 1)) {
        throw new RangeError(`continuous grass package '${input.visualPackage.id}' has an invalid additional band`);
      }
      const coverageDerivedDensity = grassFieldBladesPerInstance(profile, band.lod, band.id)
        * band.targetProjectedCoverage / band.projectedAreaPerInstanceM2;
      if (Math.abs(coverageDerivedDensity - band.bladesPerSquareMeter) > 1e-6) {
        throw new RangeError(`continuous grass package '${input.visualPackage.id}' band '${band.id}' density is not derived from projected coverage`);
      }
      if (band.complementsLod !== undefined) {
        const fade = profile.lod[band.complementsLod].fade;
        if (fade === undefined || fade.start !== band.fadeIn.start || fade.end !== band.fadeIn.end) {
          throw new RangeError(`continuous grass package '${input.visualPackage.id}' band '${band.id}' is not complementary to LOD${band.complementsLod}`);
        }
      }
      const multiplier = Math.sqrt(grassFieldBladesPerInstance(profile, band.lod, band.id)
        * density / band.bladesPerSquareMeter
        / (band.placement?.oversample ?? 1));
      return { id: band.id, cellSize: tileSize / band.cellSizeDivisor, radius: band.radius, fineRadius: 0,
        forcedLod: band.lod, spacingMultipliers: [multiplier, multiplier] as readonly [number, number],
        maxResidentBlades: band.maxResidentBlades, placement: band.placement };
    })];
    const managers = managerConfigs.map((config) => new GrassFieldStreamManager(input.scene, {
      tileSize, cellSize: config.cellSize, visualPackage: input.visualPackage, quality: input.quality, variant: input.variant,
      radius: config.radius, fineRadius: config.fineRadius, spacingMultipliers: config.spacingMultipliers,
      ...("forcedLod" in config ? { forcedLod: config.forcedLod } : {}),
      ...(config.id === "primary" ? {} : { presentationBand: config.id }),
      ...(config.placement === undefined ? {} : { placement: config.placement }),
      maxResidentBlades: config.maxResidentBlades, renderer: input.renderer, source,
      onError: input.onError,
    }));
    const runtime = new ContinuousBiomeGrassRuntime(input, managers);
    try {
      for (const manager of managers) for (const entry of input.tiles) {
        manager.noteTile(entry.key, { tx: entry.tx, tz: entry.tz }, entry.tile);
      }
      const anchor = cameraXZ(input.camera);
      // Fill the closest contiguous cells until the hard slot/blade budget refuses another one.
      // Derive the bound from the declared square residency window; a fixed 64-iteration ceiling
      // silently clipped cinematic's 9x9 window and recreated a directional density hole.
      for (let managerIndex = 0; managerIndex < managers.length; managerIndex++) {
        const manager = managers[managerIndex]!, config = managerConfigs[managerIndex]!;
        const maxInitialGrowthIterations = (config.radius * 2 + 1) ** 2 + 1;
        for (let iteration = 0; iteration < maxInitialGrowthIterations; iteration++) {
          const result = manager.update(anchor.x, anchor.z);
          await manager.settle();
          const errors = manager.takeErrors();
          if (errors.length > 0) throw new AggregateError(errors, `continuous grass '${config.id}' initial residency failed`);
          if (result.blocked || result.grown === 0) break;
        }
      }
      return runtime;
    } catch (primary) {
      try { runtime.dispose(); } catch (rollback) {
        throw new AggregateError([primary, rollback], "continuous grass creation rollback failed");
      }
      throw primary;
    }
  }

  get draws(): number { return this.managers.reduce((sum, manager) => sum + manager.grassKeys().size, 0); }
  get bladeCount(): number { return this.managers.reduce((sum, manager) => sum + manager.bladeCount(), 0); }

  update(camera: CameraLike): void {
    if (this.disposed) return;
    const anchor = cameraXZ(camera);
    for (const manager of this.managers) manager.update(anchor.x, anchor.z);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const manager of this.managers) {
      for (const key of this.parentKeys) try { manager.dropTile(key); } catch (error) { errors.push(error); }
      errors.push(...manager.takeErrors());
    }
    if (errors.length > 0) throw new AggregateError(errors, "continuous grass disposal failed");
  }
}
