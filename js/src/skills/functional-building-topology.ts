import {
  FUNCTIONAL_BUILDING_CONTRACT_V2,
  type FunctionalBuildingContractV2,
  type FunctionalBuildingPortal,
  type V3,
} from "../assets/functional-building-contract.ts";

const MAX_BUILDINGS = 1024;
const MAX_ROOMS = 32;
const MAX_CELLS = 32;
const MAX_PORTALS = 64;
const MAX_VERTICAL_LINKS = 32;
const MAX_SPAWN_ANCHORS = 256;
const EPSILON = 1e-9;

export interface BuildingTransform { position: V3; yaw: number }
export interface RoomHit { buildingId: string; roomId: string; storey: number }
export interface RoomPath {
  buildingId: string;
  roomIds: string[];
  connectionIds: string[];
}
export interface WorldSpawnAnchor {
  buildingId: string;
  id: string;
  roomId: string;
  kind: "player" | "npc" | "item";
  position: V3;
  direction: V3;
  clearanceRadius: number;
  clearanceHeight: number;
}
export interface ResidentCellQuery {
  buildingId: string;
  roomId: string;
  cellIds: string[];
}

interface Edge { id: string; roomId: string; transmission: number }
interface Instance {
  id: string;
  contract: FunctionalBuildingContractV2;
  transform: BuildingTransform;
  cos: number;
  sin: number;
  portalOpen: Map<string, boolean>;
  roomById: Map<string, FunctionalBuildingContractV2["rooms"][number]>;
  cellByRoom: Map<string, string>;
}

function finite3(value: V3): boolean { return value.length === 3 && value.every(Number.isFinite); }
function copy3(value: V3): V3 { return [value[0], value[1], value[2]]; }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Deterministic CPU authority for v2 multi-room topology. The parser owns structural
 * validation; this manager owns transformed queries and mutable portal state. All graph
 * walks are bounded by the contract's 32-room/32-cell limits and return stable ordering.
 */
export class FunctionalBuildingTopologyManager {
  private readonly buildings = new Map<string, Instance>();
  private revision = 0;

  getRevision(): number { return this.revision; }
  size(): number { return this.buildings.size; }
  hasBuilding(id: string): boolean { return this.buildings.has(id); }

  registerBuilding(id: string, contract: FunctionalBuildingContractV2, transform: BuildingTransform,
    initialPortalState: Readonly<Record<string, boolean>> = {}): boolean {
    if (id.trim() === "" || this.buildings.has(id) || this.buildings.size >= MAX_BUILDINGS
      || contract.schema !== FUNCTIONAL_BUILDING_CONTRACT_V2 || contract.rooms.length > MAX_ROOMS
      || contract.visibilityCells.length > MAX_CELLS || contract.portals.length > MAX_PORTALS
      || contract.verticalLinks.length > MAX_VERTICAL_LINKS || contract.spawnAnchors.length > MAX_SPAWN_ANCHORS
      || !finite3(transform.position)
      || !Number.isFinite(transform.yaw)) return false;
    const portalIds = new Set(contract.portals.map((portal) => portal.id));
    if (Object.entries(initialPortalState).some(([portalId, open]) => !portalIds.has(portalId) || typeof open !== "boolean")) return false;
    // Own the semantic fields used after registration: callers cannot silently mutate live topology.
    const owned: FunctionalBuildingContractV2 = { ...contract,
      rooms: contract.rooms.map((room) => ({ ...room, bounds: { center: copy3(room.bounds.center), halfExtents: copy3(room.bounds.halfExtents) }, acoustics: { ...room.acoustics } })),
      portals: contract.portals.map((portal) => ({ ...portal, roomIds: [...portal.roomIds], center: copy3(portal.center), halfExtents: copy3(portal.halfExtents) })),
      verticalLinks: contract.verticalLinks.map((link) => ({ ...link, from: copy3(link.from), to: copy3(link.to),
        upperFloorOpening: { center: [...link.upperFloorOpening.center], halfExtents: [...link.upperFloorOpening.halfExtents] } })),
      spawnAnchors: contract.spawnAnchors.map((anchor) => ({ ...anchor, position: copy3(anchor.position), direction: copy3(anchor.direction) })),
      visibilityCells: contract.visibilityCells.map((cell) => ({ ...cell, roomIds: [...cell.roomIds], nodeIds: [...cell.nodeIds] })),
    };
    const portalOpen = new Map<string, boolean>();
    for (const portal of owned.portals) {
      const requested = Object.prototype.hasOwnProperty.call(initialPortalState, portal.id) ? initialPortalState[portal.id] : undefined;
      portalOpen.set(portal.id, requested ?? portal.kind === "passage");
    }
    const instance: Instance = {
      id, contract: owned,
      transform: { position: copy3(transform.position), yaw: transform.yaw },
      cos: Math.cos(transform.yaw), sin: Math.sin(transform.yaw), portalOpen,
      roomById: new Map(owned.rooms.map((room) => [room.id, room])),
      cellByRoom: new Map(owned.rooms.map((room) => [room.id, room.visibilityCellId])),
    };
    this.buildings.set(id, instance);
    this.revision++;
    return true;
  }

  unregisterBuilding(id: string): boolean {
    if (!this.buildings.delete(id)) return false;
    this.revision++;
    return true;
  }

  setPortalOpen(buildingId: string, portalId: string, open: boolean): boolean {
    const instance = this.buildings.get(buildingId);
    const portal = instance?.contract.portals.find((entry) => entry.id === portalId);
    if (instance === undefined || portal === undefined || portal.kind !== "door") return false;
    if (instance.portalOpen.get(portalId) !== open) {
      instance.portalOpen.set(portalId, open);
      this.revision++;
    }
    return true;
  }

  isPortalOpen(buildingId: string, portalId: string): boolean | undefined {
    return this.buildings.get(buildingId)?.portalOpen.get(portalId);
  }

  /** Finds the containing oriented room. Vertical bounds are tested, so stacked rooms do not alias. */
  queryRoom(worldPosition: V3, buildingId?: string): RoomHit | undefined {
    if (!finite3(worldPosition)) return undefined;
    const instances = buildingId === undefined
      ? [...this.buildings.values()].sort((a, b) => compareText(a.id, b.id))
      : [this.buildings.get(buildingId)].filter((value): value is Instance => value !== undefined);
    for (const instance of instances) {
      const point = this.toLocal(instance, worldPosition);
      const hits = instance.contract.rooms.filter((room) =>
        Math.abs(point[0] - room.bounds.center[0]) <= room.bounds.halfExtents[0] + EPSILON
        && Math.abs(point[1] - room.bounds.center[1]) <= room.bounds.halfExtents[1] + EPSILON
        && Math.abs(point[2] - room.bounds.center[2]) <= room.bounds.halfExtents[2] + EPSILON)
        .sort((a, b) => a.storey - b.storey || compareText(a.id, b.id));
      const room = hits[0];
      if (room !== undefined) return { buildingId: instance.id, roomId: room.id, storey: room.storey };
    }
    return undefined;
  }

  /** Stable shortest room path. Closed doors remove their edge; stairs remain traversable. */
  findRoomPath(buildingId: string, fromRoomId: string, toRoomId: string): RoomPath | undefined {
    const instance = this.buildings.get(buildingId);
    if (instance === undefined || !instance.roomById.has(fromRoomId) || !instance.roomById.has(toRoomId)) return undefined;
    const found = this.walk(instance, fromRoomId, toRoomId);
    return found === undefined ? undefined : { buildingId, roomIds: found.rooms, connectionIds: found.connections };
  }

  /**
   * Acoustic gain on the strongest route. Each entered room contributes (1-absorption).
   * Open doors transmit fully; closed doors retain their authored leakage coefficient;
   * passages use their authored coefficient and stairs have unity transmission.
   */
  acousticGain(buildingId: string, sourceRoomId: string, listenerRoomId: string): number {
    const instance = this.buildings.get(buildingId);
    if (instance === undefined || !instance.roomById.has(sourceRoomId) || !instance.roomById.has(listenerRoomId)) return 0;
    const gain = new Map<string, number>([[sourceRoomId, 1 - instance.roomById.get(sourceRoomId)!.acoustics.absorption]]);
    const settled = new Set<string>();
    for (let step = 0; step < instance.contract.rooms.length; step++) {
      const current = [...gain.entries()].filter(([room]) => !settled.has(room))
        .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
      if (current === undefined) break;
      const [roomId, roomGain] = current;
      if (roomId === listenerRoomId) return roomGain;
      settled.add(roomId);
      for (const edge of this.acousticEdges(instance, roomId)) {
        if (settled.has(edge.roomId)) continue;
        const next = roomGain * edge.transmission * (1 - instance.roomById.get(edge.roomId)!.acoustics.absorption);
        if (next > (gain.get(edge.roomId) ?? -1) + EPSILON) gain.set(edge.roomId, next);
      }
    }
    return gain.get(listenerRoomId) ?? 0;
  }

  /** Cells reachable from the observer through open topology, capped and stable-sorted. */
  queryResidentCells(worldPosition: V3, buildingId?: string, maxConnections = 2, maxCells = MAX_CELLS): ResidentCellQuery | undefined {
    if (!Number.isInteger(maxConnections) || maxConnections < 0 || maxConnections > MAX_ROOMS
      || !Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_CELLS) return undefined;
    const hit = this.queryRoom(worldPosition, buildingId);
    if (hit === undefined) return undefined;
    const instance = this.buildings.get(hit.buildingId)!;
    const seen = new Set<string>([hit.roomId]), queue: Array<[string, number]> = [[hit.roomId, 0]];
    while (queue.length > 0 && seen.size < MAX_ROOMS) {
      const [roomId, depth] = queue.shift()!;
      if (depth >= maxConnections) continue;
      for (const edge of this.edges(instance, roomId)) if (!seen.has(edge.roomId)) {
        seen.add(edge.roomId); queue.push([edge.roomId, depth + 1]);
      }
    }
    const originCell = instance.cellByRoom.get(hit.roomId)!;
    const otherCells = [...new Set([...seen].map((roomId) => instance.cellByRoom.get(roomId)!))]
      .filter((cellId) => cellId !== originCell).sort(compareText);
    // Residency may be capped below the reachable set, but never evict the observer's cell.
    const cellIds = [originCell, ...otherCells.slice(0, maxCells - 1)].sort(compareText);
    return { buildingId: hit.buildingId, roomId: hit.roomId, cellIds };
  }

  /** Immediate visibility set; defaults to one open connection while retaining the same hard caps. */
  queryVisibleCells(worldPosition: V3, buildingId?: string, maxConnections = 1, maxCells = MAX_CELLS): ResidentCellQuery | undefined {
    return this.queryResidentCells(worldPosition, buildingId, maxConnections, maxCells);
  }

  worldSpawnAnchors(buildingId: string, roomId?: string): WorldSpawnAnchor[] {
    const instance = this.buildings.get(buildingId);
    if (instance === undefined || (roomId !== undefined && !instance.roomById.has(roomId))) return [];
    return instance.contract.spawnAnchors.filter((anchor) => roomId === undefined || anchor.roomId === roomId)
      .map((anchor) => ({ buildingId, id: anchor.id, roomId: anchor.roomId,
        kind: anchor.kind, position: this.toWorld(instance, anchor.position), direction: this.rotate(instance, anchor.direction),
        clearanceRadius: anchor.clearanceRadius, clearanceHeight: anchor.clearanceHeight }))
      .sort((a, b) => compareText(a.id, b.id));
  }

  private edges(instance: Instance, roomId: string): Edge[] {
    const edges: Edge[] = [];
    for (const portal of instance.contract.portals) {
      if (!instance.portalOpen.get(portal.id)) continue;
      const [a, b] = portal.roomIds;
      if (a === roomId && b !== null) edges.push(this.portalEdge(portal, b));
      else if (b === roomId && a !== null) edges.push(this.portalEdge(portal, a));
    }
    for (const link of instance.contract.verticalLinks) {
      if (link.fromRoomId === roomId) edges.push({ id: link.id, roomId: link.toRoomId, transmission: 1 });
      else if (link.toRoomId === roomId) edges.push({ id: link.id, roomId: link.fromRoomId, transmission: 1 });
    }
    return edges.sort((a, b) => compareText(a.id, b.id) || compareText(a.roomId, b.roomId));
  }

  private portalEdge(portal: FunctionalBuildingPortal, roomId: string): Edge {
    return { id: portal.id, roomId, transmission: portal.acousticTransmission };
  }

  private acousticEdges(instance: Instance, roomId: string): Edge[] {
    const edges: Edge[] = [];
    for (const portal of instance.contract.portals) {
      const [a, b] = portal.roomIds;
      const other = a === roomId ? b : b === roomId ? a : undefined;
      if (other === undefined || other === null) continue;
      const transmission = portal.kind === "door" && instance.portalOpen.get(portal.id) ? 1 : portal.acousticTransmission;
      edges.push({ id: portal.id, roomId: other, transmission });
    }
    for (const link of instance.contract.verticalLinks) {
      if (link.fromRoomId === roomId) edges.push({ id: link.id, roomId: link.toRoomId, transmission: 1 });
      else if (link.toRoomId === roomId) edges.push({ id: link.id, roomId: link.fromRoomId, transmission: 1 });
    }
    return edges.sort((a, b) => compareText(a.id, b.id) || compareText(a.roomId, b.roomId));
  }

  private walk(instance: Instance, start: string, target: string): { rooms: string[]; connections: string[] } | undefined {
    const queue = [start], previous = new Map<string, { room: string; connection: string }>();
    const seen = new Set<string>([start]);
    while (queue.length > 0) {
      const room = queue.shift()!;
      if (room === target) break;
      for (const edge of this.edges(instance, room)) if (!seen.has(edge.roomId)) {
        seen.add(edge.roomId); previous.set(edge.roomId, { room, connection: edge.id }); queue.push(edge.roomId);
      }
    }
    if (!seen.has(target)) return undefined;
    const rooms = [target], connections: string[] = [];
    while (rooms[0] !== start) {
      const step = previous.get(rooms[0])!;
      rooms.unshift(step.room); connections.unshift(step.connection);
    }
    return { rooms, connections };
  }

  private toLocal(instance: Instance, world: V3): V3 {
    const x = world[0] - instance.transform.position[0], z = world[2] - instance.transform.position[2];
    return [instance.cos * x - instance.sin * z, world[1] - instance.transform.position[1], instance.sin * x + instance.cos * z];
  }
  private toWorld(instance: Instance, local: V3): V3 {
    return [instance.transform.position[0] + instance.cos * local[0] + instance.sin * local[2],
      instance.transform.position[1] + local[1],
      instance.transform.position[2] - instance.sin * local[0] + instance.cos * local[2]];
  }
  private rotate(instance: Instance, local: V3): V3 {
    return [instance.cos * local[0] + instance.sin * local[2], local[1], -instance.sin * local[0] + instance.cos * local[2]];
  }
}
