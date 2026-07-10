import type { TerrainTile } from "../terrain/types.ts";
import type { WorldMap } from "./worldmap.ts";
import { createWaterField } from "./water-field.mjs";

const CONTENT_HASH = /^[0-9a-f]{64}$/;

interface WaterFieldResult {
  type: "dry" | "ocean" | "basin";
  isSubmerged: boolean | null;
  id: string | null;
  kind: string | null;
  surfaceLevelM: number | null;
  actualSubmergedDepthM: number | null;
  shoreDistanceM: number | null;
}

interface WaterFieldLike {
  query(x: number, z: number, terrainHeightM: number): WaterFieldResult;
}

export interface WaterContactBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface WaterContactBindingSpec {
  bindingId: string;
  offset?: readonly [number, number, number];
  bounds?: WaterContactBounds;
}

export interface PreparedWaterContactBinding {
  readonly contentHash: string;
  readonly bindingId: string;
  readonly offset: readonly [number, number, number];
  readonly bounds: Readonly<WaterContactBounds> | null;
}

export interface WaterContactSample {
  wet: boolean;
  type: "dry" | "ocean" | "basin";
  bodyId: string | null;
  kind: string | null;
  surfaceLevelM: number | null;
  columnDepthM: number;
  terrainHeightM: number | null;
  shoreDistanceM: number | null;
}

export type TerrainHeightSampler = (worldX: number, worldZ: number) => number;

interface ActiveBinding extends PreparedWaterContactBinding {
  field: WaterFieldLike;
  sampleTerrainHeight: TerrainHeightSampler;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function parseBounds(value: WaterContactBounds | undefined): Readonly<WaterContactBounds> | null {
  if (value === undefined) return null;
  const bounds = Object.freeze({
    minX: finite(value.minX, "water contact bounds.minX"),
    maxX: finite(value.maxX, "water contact bounds.maxX"),
    minZ: finite(value.minZ, "water contact bounds.minZ"),
    maxZ: finite(value.maxZ, "water contact bounds.maxZ"),
  });
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    throw new RangeError("water contact bounds must have positive width and height");
  }
  return bounds;
}

function sameBounds(left: Readonly<WaterContactBounds> | null, right: Readonly<WaterContactBounds> | null): boolean {
  return left === null || right === null
    ? left === right
    : left.minX === right.minX && left.maxX === right.maxX && left.minZ === right.minZ && left.maxZ === right.maxZ;
}

function samePrepared(left: PreparedWaterContactBinding, right: PreparedWaterContactBinding): boolean {
  return left.contentHash === right.contentHash
    && left.bindingId === right.bindingId
    && left.offset[0] === right.offset[0]
    && left.offset[1] === right.offset[1]
    && left.offset[2] === right.offset[2]
    && sameBounds(left.bounds, right.bounds);
}

function drySample(terrainHeightM: number | null = null): WaterContactSample {
  return {
    wet: false,
    type: "dry",
    bodyId: null,
    kind: null,
    surfaceLevelM: null,
    columnDepthM: 0,
    terrainHeightM,
    shoreDistanceM: null,
  };
}

/**
 * Per-world owner of the canonical standing-water contact field.
 *
 * Map parsing and identity verification remain at the existing terrain skill seams. Preparing a
 * binding builds the immutable WaterField once; activation only installs the already-prepared field
 * after the terrain source/layer succeeds. Querying never verifies, parses, or mutates world state.
 */
export class WaterContactRuntime {
  readonly #prepared = new WeakSet<object>();
  #cached: { contentHash: string; field: WaterFieldLike } | null = null;
  #active: ActiveBinding | null = null;
  #fieldBuildCount = 0;

  get activeContentHash(): string | null { return this.#active?.contentHash ?? null; }
  get activeBindingId(): string | null { return this.#active?.bindingId ?? null; }
  /** Diagnostic proving map verification/index construction stays off the query path. */
  get fieldBuildCount(): number { return this.#fieldBuildCount; }

  prepareVerifiedMap(worldMap: WorldMap, spec: WaterContactBindingSpec): PreparedWaterContactBinding {
    if (typeof spec?.bindingId !== "string" || spec.bindingId.length === 0 || spec.bindingId.length > 160) {
      throw new TypeError("water contact bindingId must be a non-empty string of at most 160 characters");
    }
    const contentHash = worldMap?.provenance?.contentHash;
    if (typeof contentHash !== "string" || !CONTENT_HASH.test(contentHash)) {
      throw new TypeError("water contact requires a verified WorldMap content hash");
    }
    const offsetInput = spec.offset ?? [0, 0, 0];
    if (!Array.isArray(offsetInput) || offsetInput.length !== 3) {
      throw new TypeError("water contact offset must be a 3-tuple");
    }
    const offset = Object.freeze([
      finite(offsetInput[0], "water contact offset[0]"),
      finite(offsetInput[1], "water contact offset[1]"),
      finite(offsetInput[2], "water contact offset[2]"),
    ]) as readonly [number, number, number];
    const bounds = parseBounds(spec.bounds);
    const candidate = Object.freeze({ contentHash, bindingId: spec.bindingId, offset, bounds });

    if (this.#active !== null && !samePrepared(this.#active, candidate)) {
      throw new Error(
        `water contact binding conflict: '${this.#active.bindingId}'/${this.#active.contentHash} is active; `
        + `cannot bind '${candidate.bindingId}'/${candidate.contentHash}`,
      );
    }
    // With no active owner, a legitimate source switch may replace the one-entry field cache.
    // Keeping only one field bounds memory; clearing and rebinding the same hash still reuses it.
    if (this.#cached !== null && this.#cached.contentHash !== contentHash) this.#cached = null;
    if (this.#cached === null) {
      this.#cached = { contentHash, field: createWaterField(worldMap) as WaterFieldLike };
      this.#fieldBuildCount++;
    }
    this.#prepared.add(candidate);
    return candidate;
  }

  activate(prepared: PreparedWaterContactBinding, sampleTerrainHeight: TerrainHeightSampler): void {
    if (prepared === null || typeof prepared !== "object" || !this.#prepared.has(prepared as object)) {
      throw new TypeError("water contact activation requires a binding prepared by this runtime");
    }
    if (typeof sampleTerrainHeight !== "function") throw new TypeError("water contact terrain sampler must be a function");
    if (this.#active !== null) {
      if (samePrepared(this.#active, prepared)) {
        // A repeated source binding may carry a new deterministic terrain recipe under the same
        // verified map. Reuse the expensive immutable field while following the newly installed
        // exact height source.
        this.#active = Object.freeze({ ...prepared, field: this.#active.field, sampleTerrainHeight });
        return;
      }
      throw new Error(`water contact binding conflict: '${this.#active.bindingId}' is already active`);
    }
    if (this.#cached === null || this.#cached.contentHash !== prepared.contentHash) {
      throw new Error("water contact prepared field is no longer available");
    }
    this.#active = Object.freeze({ ...prepared, field: this.#cached.field, sampleTerrainHeight });
  }

  /** Clear only the named owner. A different terrain path cannot erase the active volume. */
  clear(bindingId: string): boolean {
    if (this.#active === null || this.#active.bindingId !== bindingId) return false;
    this.#active = null;
    return true;
  }

  query(worldXValue: number, worldZValue: number): WaterContactSample {
    const worldX = finite(worldXValue, "water contact query x");
    const worldZ = finite(worldZValue, "water contact query z");
    const active = this.#active;
    if (active === null) return drySample();
    const bounds = active.bounds;
    if (bounds !== null && (worldX < bounds.minX || worldX > bounds.maxX || worldZ < bounds.minZ || worldZ > bounds.maxZ)) {
      return drySample();
    }
    const terrainHeightM = finite(active.sampleTerrainHeight(worldX, worldZ), "water contact terrain height");
    const [offsetX, offsetY, offsetZ] = active.offset;
    const result = active.field.query(worldX - offsetX, worldZ - offsetZ, terrainHeightM - offsetY);
    if (result.isSubmerged !== true || result.surfaceLevelM === null || result.actualSubmergedDepthM === null) {
      return drySample(terrainHeightM);
    }
    return {
      wet: true,
      type: result.type === "basin" ? "basin" : "ocean",
      bodyId: result.id,
      kind: result.kind,
      surfaceLevelM: result.surfaceLevelM + offsetY,
      columnDepthM: result.actualSubmergedDepthM,
      terrainHeightM,
      shoreDistanceM: result.shoreDistanceM,
    };
  }
}

/** Live bilinear sampling over an editable tile. The closure reads current heights after deform. */
export function editableTerrainHeightSampler(tile: TerrainTile): TerrainHeightSampler {
  const x0 = tile.origin[0] - tile.scale[0] / 2;
  const z0 = tile.origin[2] - tile.scale[2] / 2;
  return (worldX: number, worldZ: number): number => {
    const fc = ((worldX - x0) / tile.scale[0]) * (tile.ncols - 1);
    const fr = ((worldZ - z0) / tile.scale[2]) * (tile.nrows - 1);
    const col0 = Math.max(0, Math.min(tile.ncols - 2, Math.floor(fc)));
    const row0 = Math.max(0, Math.min(tile.nrows - 2, Math.floor(fr)));
    const tx = Math.max(0, Math.min(1, fc - col0));
    const tz = Math.max(0, Math.min(1, fr - row0));
    const h00 = tile.heights[row0 * tile.ncols + col0];
    const h01 = tile.heights[row0 * tile.ncols + col0 + 1];
    const h10 = tile.heights[(row0 + 1) * tile.ncols + col0];
    const h11 = tile.heights[(row0 + 1) * tile.ncols + col0 + 1];
    const normalized = (h00 * (1 - tx) + h01 * tx) * (1 - tz) + (h10 * (1 - tx) + h11 * tx) * tz;
    return tile.origin[1] + normalized * tile.scale[1];
  };
}
