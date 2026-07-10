import {
  DERIVED_TERRAIN_RESIDENCY_SCHEMA,
  type DerivedTerrainResidency,
} from "./derived-terrain-residency.ts";

export interface CameraFramingCommand {
  readonly kind?: unknown;
  readonly tool?: unknown;
  readonly input?: unknown;
}

export interface CommandCameraFrame {
  readonly largeMapTerrain: boolean;
  readonly target: readonly [number, number, number];
  readonly terrainSizeM: number;
  readonly orbitRadiusM: number;
  readonly orbitHeightM: number;
  readonly farM: number;
  readonly atmosphereDensity: number;
  readonly controls: Readonly<{
    minDistanceM: number;
    maxDistanceM: number;
    maxPolarAngleRad: number;
  }>;
}

type TerrainGrid = Readonly<{
  origin: readonly [number, number];
  chunkSizeM: number;
}>;

const DEFAULT_FRAME: CommandCameraFrame = Object.freeze({
  largeMapTerrain: false,
  target: Object.freeze([0, 1, 0] as [number, number, number]),
  terrainSizeM: 0,
  orbitRadiusM: 16,
  orbitHeightM: 8,
  farM: 200,
  atmosphereDensity: 0.0011,
  controls: Object.freeze({ minDistanceM: 2, maxDistanceM: 64, maxPolarAngleRad: Math.PI / 2 - 0.04 }),
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Derive a useful local editor frame from the largest map-generated editable terrain command. */
export function deriveCommandCameraFrame(commands: readonly CameraFramingCommand[]): Readonly<CommandCameraFrame> {
  let selected: { size: number; origin: readonly [number, number, number]; amplitude: number } | null = null;
  for (const command of commands) {
    if (command?.kind !== "skill" || command.tool !== "terrain.create") continue;
    const input = plain(command.input);
    const generate = plain(input?.generate);
    if (input === null || generate?.source !== "map") continue;
    const size = finite(input.size, 256);
    if (!(size > 0) || size > 1_000_000) continue;
    const rawOrigin = input.origin;
    const origin = Array.isArray(rawOrigin) && rawOrigin.length === 3
      && rawOrigin.every((value) => typeof value === "number" && Number.isFinite(value))
      ? [rawOrigin[0], rawOrigin[1], rawOrigin[2]] as const
      : [0, 0, 0] as const;
    const amplitude = Math.max(1, finite(generate.amplitude, 12));
    if (selected === null || size > selected.size) selected = { size, origin, amplitude };
  }
  if (selected === null) return DEFAULT_FRAME;

  // Keep startup inside a radius-7 LOD0 neighborhood even for continent-scale authored maps.
  // The editor opens a useful local frame around the terrain's real center; Atlas remains the
  // intentional whole-world overview surface.
  const orbitRadiusM = clamp(selected.size * 0.35, 32, 192);
  const orbitHeightM = clamp(selected.size * 0.18, 16, 96);
  const farM = Math.max(1500, orbitRadiusM * 8);
  const fogCharacteristicM = clamp(selected.size * 1.5, 600, 1200);
  const targetY = selected.origin[1] + Math.max(1, selected.amplitude * 0.25);
  return Object.freeze({
    largeMapTerrain: true,
    target: Object.freeze([selected.origin[0], targetY, selected.origin[2]] as [number, number, number]),
    terrainSizeM: selected.size,
    orbitRadiusM,
    orbitHeightM,
    farM,
    atmosphereDensity: 1 / fogCharacteristicM,
    controls: Object.freeze({
      minDistanceM: Math.max(2, orbitRadiusM * 0.08),
      maxDistanceM: clamp(orbitRadiusM * 3, 128, 576),
      maxPolarAngleRad: Math.PI / 2 - 0.04,
    }),
  });
}

export type DerivedTerrainResidencyListener = (residency: Readonly<DerivedTerrainResidency>) => void;

/** Allocation-free per-frame anchor tracker; it allocates only when a threshold crossing emits. */
export class DerivedTerrainResidencyTracker {
  readonly #radius: number;
  readonly #thresholdChunks: number;
  readonly #listeners = new Set<DerivedTerrainResidencyListener>();
  readonly #onListenerError: (error: unknown) => void;
  #current: Readonly<DerivedTerrainResidency>;
  #gridOriginX = 0;
  #gridOriginZ = 0;
  #chunkSizeM = 0;
  #anchorTx = 0;
  #anchorTz = 0;
  #disposed = false;

  constructor(options: Readonly<{
    center: readonly [number, number];
    radius?: number;
    thresholdChunks?: number;
    onListenerError?: (error: unknown) => void;
  }>) {
    const center = options?.center;
    if (!Array.isArray(center) || center.length !== 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
      throw new TypeError("derived residency tracker center must be finite [x,z]");
    }
    this.#radius = options.radius ?? 7;
    this.#thresholdChunks = options.thresholdChunks ?? 2;
    if (!Number.isSafeInteger(this.#radius) || this.#radius < 0 || this.#radius > 7) throw new RangeError("derived residency tracker radius is invalid");
    if (!Number.isSafeInteger(this.#thresholdChunks) || this.#thresholdChunks < 0 || this.#thresholdChunks > 7) {
      throw new RangeError("derived residency tracker threshold is invalid");
    }
    this.#onListenerError = options.onListenerError ?? (() => {});
    this.#current = this.#makeResidency(center[0], center[1]);
  }

  current(): Readonly<DerivedTerrainResidency> { return this.#current; }

  setGrid(grid: TerrainGrid): void {
    if (this.#disposed) return;
    if (!Array.isArray(grid?.origin) || grid.origin.length !== 2
        || !Number.isFinite(grid.origin[0]) || !Number.isFinite(grid.origin[1])
        || !Number.isFinite(grid.chunkSizeM) || !(grid.chunkSizeM > 0)) {
      throw new TypeError("derived residency tracker grid is invalid");
    }
    this.#gridOriginX = grid.origin[0];
    this.#gridOriginZ = grid.origin[1];
    this.#chunkSizeM = grid.chunkSizeM;
    this.#anchorTx = Math.floor((this.#current.center[0] - this.#gridOriginX) / this.#chunkSizeM);
    this.#anchorTz = Math.floor((this.#current.center[1] - this.#gridOriginZ) / this.#chunkSizeM);
  }

  update(anchorX: number, anchorZ: number): boolean {
    if (this.#disposed || this.#chunkSizeM === 0
        || !Number.isFinite(anchorX) || !Number.isFinite(anchorZ)) return false;
    const tx = Math.floor((anchorX - this.#gridOriginX) / this.#chunkSizeM);
    const tz = Math.floor((anchorZ - this.#gridOriginZ) / this.#chunkSizeM);
    if (Math.max(Math.abs(tx - this.#anchorTx), Math.abs(tz - this.#anchorTz)) <= this.#thresholdChunks) return false;
    this.#anchorTx = tx;
    this.#anchorTz = tz;
    this.#current = this.#makeResidency(anchorX, anchorZ);
    for (const listener of this.#listeners) {
      try { listener(this.#current); } catch (error) { this.#onListenerError(error); }
    }
    return true;
  }

  subscribe(listener: DerivedTerrainResidencyListener): () => void {
    if (this.#disposed) throw new Error("derived residency tracker is disposed");
    if (typeof listener !== "function") throw new TypeError("derived residency listener must be a function");
    this.#listeners.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#chunkSizeM = 0;
  }

  #makeResidency(x: number, z: number): Readonly<DerivedTerrainResidency> {
    return Object.freeze({
      schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA,
      center: Object.freeze([Object.is(x, -0) ? 0 : x, Object.is(z, -0) ? 0 : z] as [number, number]),
      lod: 0,
      radius: this.#radius,
    });
  }
}
