import { Position } from "../ecs/world.ts";
import type { EntityTable } from "../engine.ts";
import type { TransformStorage } from "../ecs/facade.ts";

export type Vec3 = readonly [number, number, number];

export interface SpatialWorld {
  transforms?: TransformStorage;
  spatial?: UniformGridSpatialIndex;
  entities: EntityTable;
  tags: Map<number, Set<string>>;
}

export interface SpatialQueryOptions {
  near?: Vec3;
  radius?: number;
  tag?: string;
  excludeEntity?: string;
  sortBy?: "entity" | "distance";
}

export interface SpatialQueryEntity {
  entity: string;
  eid: number;
  position: [number, number, number];
  distance: number;
}

export interface SpatialQueryStats {
  indexed: boolean;
  rebuilt: boolean;
  totalEntities: number;
  candidateCells: number;
  candidateEntities: number;
  returnedEntities: number;
}

export interface SpatialQueryResult {
  entities: SpatialQueryEntity[];
  stats: SpatialQueryStats;
}

interface IndexedEntity {
  entity: string;
  eid: number;
  order: number;
  x: number;
  y: number;
  z: number;
}

export interface UniformGridSpatialIndexOptions {
  cellSize?: number;
}

function finiteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function distanceOf(record: IndexedEntity, near: Vec3 | undefined): number {
  if (near === undefined) return 0;
  const dx = record.x - near[0];
  const dy = record.y - near[1];
  const dz = record.z - near[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function entityVersion(entities: EntityTable): number {
  return typeof entities.version === "number" ? entities.version : entities.ids().length;
}

function transformVersion(transforms: TransformStorage | undefined): number {
  return transforms?.version ?? 0;
}

function cellCoord(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function cellKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

function compareDistanceThenEntity(a: SpatialQueryEntity, b: SpatialQueryEntity): number {
  return a.distance - b.distance;
}

function compareRecordOrder(a: IndexedEntity, b: IndexedEntity): number {
  return a.order - b.order;
}

function tagsMatch(world: SpatialWorld, record: IndexedEntity, tag: string | undefined): boolean {
  return tag === undefined || world.tags.get(record.eid)?.has(tag) === true;
}

function materialize(
  world: SpatialWorld,
  records: IndexedEntity[],
  options: SpatialQueryOptions,
): SpatialQueryEntity[] {
  const result: SpatialQueryEntity[] = [];
  const maxDistance = finiteNumber(options.radius) ? options.radius : undefined;
  for (const record of records) {
    if (record.entity === options.excludeEntity) continue;
    if (!tagsMatch(world, record, options.tag)) continue;
    const distance = distanceOf(record, options.near);
    if (maxDistance !== undefined && distance > maxDistance) continue;
    result.push({
      entity: record.entity,
      eid: record.eid,
      position: [record.x, record.y, record.z],
      distance,
    });
  }
  if (options.sortBy === "distance") result.sort(compareDistanceThenEntity);
  return result;
}

export class UniformGridSpatialIndex {
  readonly cellSize: number;
  private readonly cells = new Map<string, IndexedEntity[]>();
  private readonly records: IndexedEntity[] = [];
  private indexedEntityVersion = -1;
  private indexedTransformVersion = -1;
  private invalidationVersion = 0;
  private indexedInvalidationVersion = -1;

  constructor(options: UniformGridSpatialIndexOptions = {}) {
    const cellSize = options.cellSize ?? 8;
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("spatial index cellSize must be positive");
    this.cellSize = cellSize;
  }

  invalidate(): void {
    this.invalidationVersion++;
  }

  ensureFresh(world: SpatialWorld): boolean {
    const nextEntityVersion = entityVersion(world.entities);
    const nextTransformVersion = transformVersion(world.transforms);
    if (
      nextEntityVersion === this.indexedEntityVersion &&
      nextTransformVersion === this.indexedTransformVersion &&
      this.invalidationVersion === this.indexedInvalidationVersion
    ) {
      return false;
    }
    this.rebuild(world);
    return true;
  }

  rebuild(world: SpatialWorld): void {
    this.cells.clear();
    this.records.length = 0;
    const ids = world.entities.ids();
    for (let order = 0; order < ids.length; order++) {
      const entity = ids[order];
      const entry = world.entities.resolve(entity);
      if (entry === undefined) continue;
      const record: IndexedEntity = {
        entity,
        eid: entry.eid,
        order,
        x: Position.x[entry.eid],
        y: Position.y[entry.eid],
        z: Position.z[entry.eid],
      };
      this.records.push(record);
      const key = cellKey(
        cellCoord(record.x, this.cellSize),
        cellCoord(record.y, this.cellSize),
        cellCoord(record.z, this.cellSize),
      );
      let bucket = this.cells.get(key);
      if (bucket === undefined) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(record);
    }
    for (const bucket of this.cells.values()) bucket.sort(compareRecordOrder);
    this.indexedEntityVersion = entityVersion(world.entities);
    this.indexedTransformVersion = transformVersion(world.transforms);
    this.indexedInvalidationVersion = this.invalidationVersion;
  }

  query(world: SpatialWorld, options: SpatialQueryOptions = {}): SpatialQueryResult {
    const rebuilt = this.ensureFresh(world);
    if (options.near === undefined || !finiteNumber(options.radius)) {
      const entities = materialize(world, this.records, options);
      return {
        entities,
        stats: {
          indexed: true,
          rebuilt,
          totalEntities: this.records.length,
          candidateCells: 0,
          candidateEntities: this.records.length,
          returnedEntities: entities.length,
        },
      };
    }

    const [x, y, z] = options.near;
    const radius = options.radius;
    const minX = cellCoord(x - radius, this.cellSize);
    const maxX = cellCoord(x + radius, this.cellSize);
    const minY = cellCoord(y - radius, this.cellSize);
    const maxY = cellCoord(y + radius, this.cellSize);
    const minZ = cellCoord(z - radius, this.cellSize);
    const maxZ = cellCoord(z + radius, this.cellSize);
    const candidates: IndexedEntity[] = [];
    let candidateCells = 0;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          candidateCells++;
          const bucket = this.cells.get(cellKey(cx, cy, cz));
          if (bucket !== undefined) candidates.push(...bucket);
        }
      }
    }
    candidates.sort(compareRecordOrder);
    const entities = materialize(world, candidates, options);
    return {
      entities,
      stats: {
        indexed: true,
        rebuilt,
        totalEntities: this.records.length,
        candidateCells,
        candidateEntities: candidates.length,
        returnedEntities: entities.length,
      },
    };
  }
}

export function querySpatialEntities(world: SpatialWorld, options: SpatialQueryOptions = {}): SpatialQueryResult {
  if (world.spatial !== undefined) return world.spatial.query(world, options);
  return querySpatialEntitiesBruteForce(world, options);
}

export function querySpatialEntitiesBruteForce(
  world: SpatialWorld,
  options: SpatialQueryOptions = {},
): SpatialQueryResult {
  const records: IndexedEntity[] = [];
  const ids = world.entities.ids();
  for (let order = 0; order < ids.length; order++) {
    const entity = ids[order];
    const entry = world.entities.resolve(entity);
    if (entry === undefined) continue;
    records.push({
      entity,
      eid: entry.eid,
      order,
      x: Position.x[entry.eid],
      y: Position.y[entry.eid],
      z: Position.z[entry.eid],
    });
  }
  const entities = materialize(world, records, options);
  return {
    entities,
    stats: {
      indexed: false,
      rebuilt: false,
      totalEntities: records.length,
      candidateCells: 0,
      candidateEntities: records.length,
      returnedEntities: entities.length,
    },
  };
}
