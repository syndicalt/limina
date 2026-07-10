import { terrainWorldToChunk } from "../terrain/grid.mjs";

export const DERIVED_TERRAIN_RESIDENCY_SCHEMA = "limina.derived-terrain-residency/v1";
export const MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS = 7;
export const MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS = (MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS * 2 + 1) ** 2;

export interface DerivedTerrainResidency {
  readonly schema: typeof DERIVED_TERRAIN_RESIDENCY_SCHEMA;
  readonly center: readonly [number, number];
  readonly lod: 0;
  readonly radius: number;
}

type TerrainGrid = Readonly<{ origin: readonly [number, number]; chunkSizeM: number }>;
type TerrainChunk = Readonly<{ chunkId: string; lod: number; tx: number; tz: number }>;
function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
}

function centerTuple(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    throw new TypeError("derived terrain residency center must be a dense two-element array");
  }
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined
        || !Number.isFinite(descriptor.value)) {
      throw new TypeError("derived terrain residency center must contain finite data values");
    }
  }
  return Object.freeze([
    Object.is(value[0], -0) ? 0 : value[0],
    Object.is(value[1], -0) ? 0 : value[1],
  ] as [number, number]);
}

export function parseDerivedTerrainResidency(input: unknown): Readonly<DerivedTerrainResidency> {
  const value = plain(input, "derived terrain residency");
  exact(value, ["schema", "center", "lod", "radius"], "derived terrain residency");
  if (value.schema !== DERIVED_TERRAIN_RESIDENCY_SCHEMA || value.lod !== 0
      || !Number.isSafeInteger(value.radius) || (value.radius as number) < 0
      || (value.radius as number) > MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS) {
    throw new TypeError("derived terrain residency is invalid");
  }
  return Object.freeze({
    schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA,
    center: centerTuple(value.center),
    lod: 0,
    radius: value.radius as number,
  });
}

export function derivedTerrainResidencyKey(input: unknown): string {
  const residency = parseDerivedTerrainResidency(input);
  return `${residency.lod}:${residency.center[0]}:${residency.center[1]}:${residency.radius}`;
}

export function selectDerivedTerrainChunks<T extends TerrainChunk>(
  manifest: Readonly<{ grid: TerrainGrid; chunks: readonly T[] }>,
  residencyInput: unknown,
): readonly T[] {
  const residency = parseDerivedTerrainResidency(residencyInput);
  const anchor = terrainWorldToChunk(manifest.grid, residency.center[0], residency.center[1]);
  const chunks = manifest.chunks.filter((chunk) => chunk.lod === residency.lod
    && Math.abs(chunk.tx - anchor.tx) <= residency.radius
    && Math.abs(chunk.tz - anchor.tz) <= residency.radius);
  if (chunks.length < 1) throw new RangeError("derived terrain residency contains no manifest chunks");
  if (chunks.length > MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS) {
    throw new RangeError("derived terrain residency exceeds its 225-chunk bound");
  }
  return Object.freeze([...chunks]);
}
