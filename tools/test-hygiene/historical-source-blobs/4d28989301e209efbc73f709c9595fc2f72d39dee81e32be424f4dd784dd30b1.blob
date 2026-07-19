// Pure-byte semantic contract for authored, enterable buildings. This deliberately does not use
// GLTFLoader: the browser sim worker must derive the same collision/portal/door authority as the
// render thread without a DOM, texture decode, node indexes, or scene-graph flattening.

export const FUNCTIONAL_BUILDING_CONTRACT = "limina.functional-building/v1" as const;
export const FUNCTIONAL_BUILDING_CONTRACT_V2 = "limina.functional-building/v2" as const;

export type V3 = [number, number, number];
export type V2 = [number, number];
export interface FunctionalBuildingSite {
  footprintCenter: V2;
  footprintHalfExtents: V2;
  finishedFloorY: number;
  terrainClearance: number;
  vegetationClearance: number;
  maximumTerrainRelief: number;
  entranceSupport?: {
    sourcePrimitiveId: string;
    center: V2;
    halfExtents: V2;
    yawRadians: number;
    exteriorGradeY: number;
    bearingDepth: number;
    maximumCutDepth: number;
    maximumVariation: number;
  };
}
export interface FunctionalBuildingCollider {
  id: string;
  nodeId: string;
  halfExtents: V3;
  center: V3;
}
export interface FunctionalBuildingDoor {
  id: string;
  nodeId: string;
  roomId: string;
  portalId: string;
  hinge: V3;
  closedYaw: number;
  openYaw: number;
  halfExtents: V3;
  center: V3;
}
export interface FunctionalBuildingContract {
  schema: typeof FUNCTIONAL_BUILDING_CONTRACT;
  buildingId: string;
  rootNodeId: string;
  roomIds: string[];
  portalIds: string[];
  entryAnchor: V3;
  site?: FunctionalBuildingSite;
  colliders: FunctionalBuildingCollider[];
  doors: FunctionalBuildingDoor[];
}
export interface FunctionalBuildingRoom {
  id: string;
  bounds: { center: V3; halfExtents: V3 };
  finishedFloorY: number;
  ceilingY: number;
  storey: number;
  visibilityCellId: string;
  acoustics: { absorption: number; reverb: number };
}
export interface FunctionalBuildingPortal {
  id: string;
  kind: "door" | "passage";
  exterior: boolean;
  roomIds: [string | null, string | null];
  center: V3;
  halfExtents: V3;
  acousticTransmission: number;
  doorId?: string;
}
export interface FunctionalBuildingVerticalLink {
  id: string;
  kind: "stairs";
  fromRoomId: string;
  toRoomId: string;
  from: V3;
  to: V3;
  clearWidth: number;
  clearHeight: number;
  rise: number;
  run: number;
  riserCount: number;
  treadDepth: number;
  upperFloorOpening: { center: V2; halfExtents: V2 };
}
export interface FunctionalBuildingSpawnAnchor {
  id: string;
  roomId: string;
  kind: "player" | "npc" | "item";
  position: V3;
  direction: V3;
  clearanceRadius: number;
  clearanceHeight: number;
}
export interface FunctionalBuildingVisibilityCell { id: string; roomIds: string[]; nodeIds: string[] }
export interface FunctionalBuildingContractV2 extends Omit<FunctionalBuildingContract, "schema"> {
  schema: typeof FUNCTIONAL_BUILDING_CONTRACT_V2;
  rooms: FunctionalBuildingRoom[];
  portals: FunctionalBuildingPortal[];
  verticalLinks: FunctionalBuildingVerticalLink[];
  spawnAnchors: FunctionalBuildingSpawnAnchor[];
  visibilityCells: FunctionalBuildingVisibilityCell[];
}

type JsonObject = Record<string, unknown>;
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`functional building: ${label} must be an object`);
  return value as JsonObject;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`functional building: ${label} must be a non-empty string`);
  return value;
}
const STABLE_ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
function stableId(value: unknown, label: string): string {
  const out = string(value, label);
  if (!STABLE_ID.test(out)) throw new Error(`functional building: ${label} must be a stable lowercase id`);
  return out;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`functional building: ${label} must be finite`);
  return value;
}
function vec3(value: unknown, label: string, positive = false): V3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`functional building: ${label} must be a vec3`);
  const out: V3 = [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`), finite(value[2], `${label}[2]`)];
  if (positive && out.some((axis) => axis <= 0)) throw new Error(`functional building: ${label} axes must be positive`);
  return out;
}
function vec2(value: unknown, label: string, positive = false): V2 {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`functional building: ${label} must be a vec2`);
  const out: V2 = [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`)];
  if (positive && out.some((axis) => axis <= 0)) throw new Error(`functional building: ${label} axes must be positive`);
  return out;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`functional building: ${label} must be a non-empty array`);
  const out = value.map((item, index) => string(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`functional building: ${label} contains duplicate ids`);
  return out;
}
function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) throw new Error(`functional building: ${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`functional building: ${label}.${key} is unsupported`);
}
function boundedArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`functional building: ${label} must contain ${minimum}..${maximum} entries`);
  return value;
}
function coefficient(value: unknown, label: string): number {
  const out = finite(value, label);
  if (out < 0 || out > 1) throw new Error(`functional building: ${label} must be within [0,1]`);
  return out;
}
function positive(value: unknown, label: string): number {
  const out = finite(value, label);
  if (out <= 0) throw new Error(`functional building: ${label} must be positive`);
  return out;
}
function contains(room: FunctionalBuildingRoom, point: V3, tolerance = 1e-6): boolean {
  return point.every((axis, index) => Math.abs(axis - room.bounds.center[index]) <= room.bounds.halfExtents[index] + tolerance);
}

function gltfJson(bytes: Uint8Array): JsonObject {
  if (bytes.byteLength < 2) throw new Error("functional building: empty glTF bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let jsonBytes = bytes;
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    const declaredLength = view.getUint32(8, true);
    if (declaredLength !== bytes.byteLength) throw new Error("functional building: GLB length header mismatch");
    let offset = 12;
    let found: Uint8Array | undefined;
    while (offset + 8 <= bytes.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8, end = start + length;
      if (end > bytes.byteLength) throw new Error("functional building: truncated GLB chunk");
      if (type === CHUNK_JSON && found === undefined) found = bytes.subarray(start, end);
      offset = end;
    }
    if (found === undefined) throw new Error("functional building: GLB has no JSON chunk");
    jsonBytes = found;
  }
  try { return object(JSON.parse(new TextDecoder().decode(jsonBytes).trim()), "glTF root"); }
  catch (error) { throw new Error(`functional building: invalid glTF JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Parse and strictly validate semantic authority embedded in glTF asset/node extras. */
export function parseFunctionalBuildingContract(bytes: Uint8Array): FunctionalBuildingContract | FunctionalBuildingContractV2 {
  const json = gltfJson(bytes);
  const asset = object(json.asset, "asset");
  const authority = object(object(asset.extras, "asset.extras").liminaFunctionalBuilding, "asset.extras.liminaFunctionalBuilding");
  const isV2 = authority.schema === FUNCTIONAL_BUILDING_CONTRACT_V2;
  if (authority.schema !== FUNCTIONAL_BUILDING_CONTRACT && !isV2) throw new Error(`functional building: unsupported schema ${String(authority.schema)}`);
  if (isV2) exactKeys(authority,
    ["schema", "units", "up", "buildingId", "rootNodeId", "roomIds", "portalIds", "entryAnchor", "rooms", "portals", "verticalLinks", "spawnAnchors", "visibilityCells"],
    ["site"], "asset.extras.liminaFunctionalBuilding");
  if (authority.units !== "meter" || authority.up !== "Y") throw new Error("functional building: units must be meter and up must be Y");
  const buildingId = string(authority.buildingId, "buildingId");
  const rootNodeId = string(authority.rootNodeId, "rootNodeId");
  const roomIds = stringArray(authority.roomIds, "roomIds");
  const portalIds = stringArray(authority.portalIds, "portalIds");
  const entryAnchor = vec3(authority.entryAnchor, "entryAnchor");
  let site: FunctionalBuildingSite | undefined;
  if (authority.site !== undefined) {
    const rawSite = object(authority.site, "site");
    const finishedFloorY = finite(rawSite.finishedFloorY, "site.finishedFloorY");
    const terrainClearance = finite(rawSite.terrainClearance, "site.terrainClearance");
    const vegetationClearance = finite(rawSite.vegetationClearance, "site.vegetationClearance");
    const maximumTerrainRelief = finite(rawSite.maximumTerrainRelief, "site.maximumTerrainRelief");
    if (terrainClearance < 0.05 || terrainClearance > 1 || vegetationClearance < 0 || vegetationClearance > 5
        || maximumTerrainRelief <= 0 || maximumTerrainRelief > 5) throw new Error("functional building: site policy is outside bounded construction limits");
    site = { footprintCenter: vec2(rawSite.footprintCenter, "site.footprintCenter"),
      footprintHalfExtents: vec2(rawSite.footprintHalfExtents, "site.footprintHalfExtents", true),
      finishedFloorY, terrainClearance, vegetationClearance, maximumTerrainRelief };
    if (rawSite.entranceSupport !== undefined) {
      const support = object(rawSite.entranceSupport, "site.entranceSupport"),
        yawRadians = finite(support.yawRadians, "site.entranceSupport.yawRadians"),
        exteriorGradeY = finite(support.exteriorGradeY, "site.entranceSupport.exteriorGradeY"),
        bearingDepth = finite(support.bearingDepth, "site.entranceSupport.bearingDepth"),
        maximumCutDepth = finite(support.maximumCutDepth, "site.entranceSupport.maximumCutDepth"),
        maximumVariation = finite(support.maximumVariation, "site.entranceSupport.maximumVariation");
      if (bearingDepth <= 0 || bearingDepth > 0.5 || maximumCutDepth < 0 || maximumCutDepth > 0.2
          || maximumVariation <= 0 || maximumVariation > 0.25)
        throw new Error("functional building: entrance support policy is outside bounded construction limits");
      site.entranceSupport = {
        sourcePrimitiveId: string(support.sourcePrimitiveId, "site.entranceSupport.sourcePrimitiveId"),
        center: vec2(support.center, "site.entranceSupport.center"),
        halfExtents: vec2(support.halfExtents, "site.entranceSupport.halfExtents", true),
        yawRadians, exteriorGradeY, bearingDepth, maximumCutDepth, maximumVariation,
      };
    }
  }

  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const semantic = new Map<string, { nodeId: string; role: string; data: JsonObject; index: number }>();
  for (let index = 0; index < nodes.length; index++) {
    const node = object(nodes[index], `nodes[${index}]`);
    const extras = node.extras === undefined ? undefined : object(node.extras, `nodes[${index}].extras`);
    const data = extras?.limina;
    if (data === undefined) continue;
    if (node.scale !== undefined) {
      const scale = vec3(node.scale, `nodes[${index}].scale`);
      if (scale.some((axis) => axis <= 0) || Math.max(...scale) - Math.min(...scale) > 1e-6) {
        throw new Error(`functional building: nodes[${index}] has articulated-unsafe scale`);
      }
    }
    const sem = object(data, `nodes[${index}].extras.limina`);
    const nodeId = string(sem.id, `nodes[${index}] semantic id`);
    if (semantic.has(nodeId)) throw new Error(`functional building: duplicate node id ${nodeId}`);
    semantic.set(nodeId, { nodeId, role: string(sem.role, `${nodeId}.role`), data: sem, index });
  }
  const root = semantic.get(rootNodeId);
  if (root?.role !== "root") throw new Error("functional building: rootNodeId does not resolve to a root node");
  const scenes=Array.isArray(json.scenes)?json.scenes:[],sceneIndex=json.scene===undefined?0:finite(json.scene,"scene");
  if(!Number.isSafeInteger(sceneIndex)||scenes.length!==1||sceneIndex!==0)throw new Error("functional building: asset requires exactly one canonical scene");
  const scene=object(scenes[sceneIndex],`scenes[${sceneIndex}]`),sceneRoots=scene.nodes;
  if(!Array.isArray(sceneRoots)||sceneRoots.length!==1||sceneRoots[0]!==root.index)throw new Error("functional building: semantic root must be the sole scene root");
  const descendants=new Set<number>(),visiting=new Set<number>();
  const visit=(index:number):void=>{if(!Number.isSafeInteger(index)||index<0||index>=nodes.length)throw new Error("functional building: scene graph has an invalid child index");if(visiting.has(index))throw new Error("functional building: scene graph contains a cycle");if(descendants.has(index))return;visiting.add(index);descendants.add(index);const raw=object(nodes[index],`nodes[${index}]`);if(raw.children!==undefined){if(!Array.isArray(raw.children))throw new Error(`functional building: nodes[${index}].children must be an array`);for(const child of raw.children)visit(finite(child,`nodes[${index}].children`));}visiting.delete(index);};
  visit(root.index);
  for(const item of semantic.values())if(!descendants.has(item.index))throw new Error(`functional building: semantic node ${item.nodeId} is outside the building root`);
  for (const roomId of roomIds) if (semantic.get(roomId)?.role !== "room") throw new Error(`functional building: room ${roomId} is unresolved`);
  for (const portalId of portalIds) if (semantic.get(portalId)?.role !== "portal") throw new Error(`functional building: portal ${portalId} is unresolved`);

  const colliders: FunctionalBuildingCollider[] = [];
  const doors: FunctionalBuildingDoor[] = [];
  for (const item of semantic.values()) {
    if (item.role === "collider") {
      if (item.data.shape !== "box") throw new Error(`functional building: collider ${item.nodeId} must be a box`);
      colliders.push({ id: item.nodeId, nodeId: item.nodeId, halfExtents: vec3(item.data.halfExtents, `${item.nodeId}.halfExtents`, true), center: vec3(item.data.center, `${item.nodeId}.center`) });
    } else if (item.role === "door") {
      const roomId = string(item.data.roomId, `${item.nodeId}.roomId`);
      const portalId = string(item.data.portalId, `${item.nodeId}.portalId`);
      if (!roomIds.includes(roomId) || !portalIds.includes(portalId)) throw new Error(`functional building: door ${item.nodeId} has unresolved room/portal`);
      const closedYaw = finite(item.data.closedYaw, `${item.nodeId}.closedYaw`);
      const openYaw = finite(item.data.openYaw, `${item.nodeId}.openYaw`);
      if (Math.abs(openYaw - closedYaw) < 0.5) throw new Error(`functional building: door ${item.nodeId} has no useful open sweep`);
      doors.push({ id: item.nodeId, nodeId: item.nodeId, roomId, portalId, hinge: vec3(item.data.hinge, `${item.nodeId}.hinge`), closedYaw, openYaw,
        halfExtents: vec3(item.data.halfExtents, `${item.nodeId}.halfExtents`, true), center: vec3(item.data.center, `${item.nodeId}.center`) });
    }
  }
  if (colliders.length < 5) throw new Error("functional building: decomposed shell requires at least five box colliders");
  if (doors.length === 0) throw new Error("functional building: at least one operable door is required");
  if(site?.entranceSupport){
    const support=site.entranceSupport,item=semantic.get(support.sourcePrimitiveId),boxData=item?.data.box===undefined?undefined:object(item.data.box,`${support.sourcePrimitiveId}.box`);
    if(item?.role!=="architecture-primitive"||boxData===undefined)throw new Error("functional building: entrance support source primitive is unresolved");
    const center=vec3(boxData.center,`${support.sourcePrimitiveId}.box.center`),halfExtents=vec3(boxData.halfExtents,`${support.sourcePrimitiveId}.box.halfExtents`,true),yaw=finite(boxData.yawRadians,`${support.sourcePrimitiveId}.box.yawRadians`);
    if(Math.abs(center[0]-support.center[0])>.001||Math.abs(center[2]-support.center[1])>.001||Math.abs(halfExtents[0]-support.halfExtents[0])>.001||Math.abs(halfExtents[2]-support.halfExtents[1])>.001||Math.abs(yaw-support.yawRadians)>.001||Math.abs(center[1]-halfExtents[1]-(support.exteriorGradeY-support.bearingDepth))>.001)
      throw new Error("functional building: entrance support does not match its structural source primitive");
    const c=Math.cos(support.yawRadians),s=Math.sin(support.yawRadians),limitX=site.footprintHalfExtents[0]+site.vegetationClearance,limitZ=site.footprintHalfExtents[1]+site.vegetationClearance;
    for(const sx of [-support.halfExtents[0],support.halfExtents[0]])for(const sz of [-support.halfExtents[1],support.halfExtents[1]]){const x=support.center[0]+sx*c+sz*s-site.footprintCenter[0],z=support.center[1]-sx*s+sz*c-site.footprintCenter[1];if(Math.abs(x)>limitX+1e-9||Math.abs(z)>limitZ+1e-9)throw new Error("functional building: entrance support leaves the ecology exclusion");}
  }
  const animations = Array.isArray(json.animations) ? json.animations : [];
  for (const door of doors) {
    const nodeIndex = semantic.get(door.nodeId)!.index;
    const clip = animations.find((value) => object(value, "animation").name === `${door.id}/open`);
    if (clip === undefined) throw new Error(`functional building: door ${door.id} is missing canonical clip ${door.id}/open`);
    const channels = Array.isArray(object(clip, `${door.id} clip`).channels) ? object(clip, `${door.id} clip`).channels as unknown[] : [];
    const rotatesLeaf = channels.some((value) => {
      const target = object(object(value, `${door.id} channel`).target, `${door.id} channel target`);
      return target.node === nodeIndex && target.path === "rotation";
    });
    if (!rotatesLeaf) throw new Error(`functional building: canonical clip ${door.id}/open does not rotate its semantic leaf`);
  }
  if (!isV2) return { schema: FUNCTIONAL_BUILDING_CONTRACT, buildingId, rootNodeId, roomIds, portalIds, entryAnchor, site, colliders, doors };

  const rooms = boundedArray(authority.rooms, "rooms", 1, 32).map((raw, index): FunctionalBuildingRoom => {
    const label = `rooms[${index}]`, value = object(raw, label);
    exactKeys(value, ["id", "bounds", "finishedFloorY", "ceilingY", "storey", "visibilityCellId", "acoustics"], [], label);
    const id = stableId(value.id, `${label}.id`), boundsRaw = object(value.bounds, `${label}.bounds`);
    exactKeys(boundsRaw, ["center", "halfExtents"], [], `${label}.bounds`);
    const bounds = { center: vec3(boundsRaw.center, `${label}.bounds.center`), halfExtents: vec3(boundsRaw.halfExtents, `${label}.bounds.halfExtents`, true) };
    const finishedFloorY = finite(value.finishedFloorY, `${label}.finishedFloorY`), ceilingY = finite(value.ceilingY, `${label}.ceilingY`);
    const storey = finite(value.storey, `${label}.storey`);
    if (!Number.isSafeInteger(storey) || storey < 0 || storey > 63) throw new Error(`functional building: ${label}.storey must be an integer within [0,63]`);
    if (ceilingY - finishedFloorY < 1.8 || Math.abs((bounds.center[1] - bounds.halfExtents[1]) - finishedFloorY) > 1e-4 || Math.abs((bounds.center[1] + bounds.halfExtents[1]) - ceilingY) > 1e-4)
      throw new Error(`functional building: ${label} bounds must span its finished floor and ceiling with at least 1.8m headroom`);
    const acousticsRaw = object(value.acoustics, `${label}.acoustics`);
    exactKeys(acousticsRaw, ["absorption", "reverb"], [], `${label}.acoustics`);
    return { id, bounds, finishedFloorY, ceilingY, storey, visibilityCellId: stableId(value.visibilityCellId, `${label}.visibilityCellId`), acoustics: { absorption: coefficient(acousticsRaw.absorption, `${label}.acoustics.absorption`), reverb: coefficient(acousticsRaw.reverb, `${label}.acoustics.reverb`) } };
  });
  const roomMap = new Map(rooms.map((room) => [room.id, room]));
  if (roomMap.size !== rooms.length || roomIds.length !== rooms.length || roomIds.some((id) => !roomMap.has(id))) throw new Error("functional building: rooms must exactly cover roomIds");

  const portals = boundedArray(authority.portals, "portals", 1, 64).map((raw, index): FunctionalBuildingPortal => {
    const label = `portals[${index}]`, value = object(raw, label);
    exactKeys(value, ["id", "kind", "exterior", "roomIds", "center", "halfExtents", "acousticTransmission"], ["doorId"], label);
    const id = stableId(value.id, `${label}.id`), kind = string(value.kind, `${label}.kind`);
    if (kind !== "door" && kind !== "passage") throw new Error(`functional building: ${label}.kind is unsupported`);
    if (!Array.isArray(value.roomIds) || value.roomIds.length !== 2) throw new Error(`functional building: ${label}.roomIds must be a pair`);
    const endpoints = value.roomIds.map((entry, endpoint) => entry === null ? null : string(entry, `${label}.roomIds[${endpoint}]`)) as [string | null, string | null];
    if ((endpoints[0] === null && endpoints[1] === null) || endpoints[0] === endpoints[1] || endpoints.some((entry) => entry !== null && !roomMap.has(entry))) throw new Error(`functional building: ${label}.roomIds has unresolved or degenerate endpoints`);
    if (typeof value.exterior !== "boolean" || value.exterior !== endpoints.includes(null)) throw new Error(`functional building: ${label}.exterior must exactly match its null exterior endpoint`);
    const center = vec3(value.center, `${label}.center`), halfExtents = vec3(value.halfExtents, `${label}.halfExtents`, true);
    for (const endpoint of endpoints) if (endpoint !== null) {
      const room = roomMap.get(endpoint)!;
      if (!center.every((axis, dimension) => Math.abs(axis - room.bounds.center[dimension]) <= room.bounds.halfExtents[dimension] + halfExtents[dimension] + 1e-6)) throw new Error(`functional building: ${label} does not touch room ${endpoint}`);
    }
    const doorId = value.doorId === undefined ? undefined : stableId(value.doorId, `${label}.doorId`);
    if ((kind === "door") !== (doorId !== undefined)) throw new Error(`functional building: ${label} door portals require doorId and passages prohibit it`);
    return { id, kind, exterior: value.exterior, roomIds: endpoints, center, halfExtents, acousticTransmission: coefficient(value.acousticTransmission, `${label}.acousticTransmission`), ...(doorId === undefined ? {} : { doorId }) };
  });
  const portalMap = new Map(portals.map((portal) => [portal.id, portal]));
  if (portalMap.size !== portals.length || portalIds.length !== portals.length || portalIds.some((id) => !portalMap.has(id))) throw new Error("functional building: portals must exactly cover portalIds");

  const verticalLinks = boundedArray(authority.verticalLinks, "verticalLinks", 0, 32).map((raw, index): FunctionalBuildingVerticalLink => {
    const label = `verticalLinks[${index}]`, value = object(raw, label);
    exactKeys(value, ["id", "kind", "fromRoomId", "toRoomId", "from", "to", "clearWidth", "clearHeight", "rise", "run", "riserCount", "treadDepth", "upperFloorOpening"], [], label);
    const id = stableId(value.id, `${label}.id`), kind = string(value.kind, `${label}.kind`);
    if (kind !== "stairs") throw new Error(`functional building: ${label}.kind must be stairs`);
    const fromRoomId = string(value.fromRoomId, `${label}.fromRoomId`), toRoomId = string(value.toRoomId, `${label}.toRoomId`), from = vec3(value.from, `${label}.from`), to = vec3(value.to, `${label}.to`);
    const fromRoom = roomMap.get(fromRoomId), toRoom = roomMap.get(toRoomId);
    if (!fromRoom || !toRoom || fromRoom === toRoom || !contains(fromRoom, from) || !contains(toRoom, to)) throw new Error(`functional building: ${label} endpoints must resolve inside two distinct rooms`);
    const rise = positive(value.rise, `${label}.rise`), run = positive(value.run, `${label}.run`), actualRise = Math.abs(to[1] - from[1]);
    const riserCount = finite(value.riserCount, `${label}.riserCount`), treadDepth = positive(value.treadDepth, `${label}.treadDepth`);
    const clearWidth = positive(value.clearWidth, `${label}.clearWidth`), clearHeight = positive(value.clearHeight, `${label}.clearHeight`);
    const openingRaw = object(value.upperFloorOpening, `${label}.upperFloorOpening`);
    exactKeys(openingRaw, ["center", "halfExtents"], [], `${label}.upperFloorOpening`);
    const upperFloorOpening = { center: vec2(openingRaw.center, `${label}.upperFloorOpening.center`), halfExtents: vec2(openingRaw.halfExtents, `${label}.upperFloorOpening.halfExtents`, true) };
    const dx = to[0] - from[0], dz = to[2] - from[2];
    if (!Number.isSafeInteger(riserCount) || riserCount < 2 || riserCount > 64 || rise / riserCount > .2 || treadDepth < .25 || treadDepth > .45
      || clearWidth < .8 || clearHeight < 1.9 || Math.abs(run - treadDepth * riserCount) > 1e-4
      || Math.abs(Math.hypot(dx, dz) - run) > 1e-4 || (Math.abs(dx) > 1e-4 && Math.abs(dz) > 1e-4)
      || Math.abs(from[1] - fromRoom.finishedFloorY) > 1e-4 || Math.abs(to[1] - toRoom.finishedFloorY) > 1e-4
      || toRoom.finishedFloorY <= fromRoom.finishedFloorY || toRoom.storey <= fromRoom.storey
      || Math.abs(to[0] - upperFloorOpening.center[0]) > upperFloorOpening.halfExtents[0] + 1e-6
      || Math.abs(to[2] - upperFloorOpening.center[1]) > upperFloorOpening.halfExtents[1] + 1e-6
      || upperFloorOpening.halfExtents[0] * 2 < clearWidth - 1e-6 || upperFloorOpening.halfExtents[1] * 2 < clearWidth - 1e-6
      || Math.abs(upperFloorOpening.center[0] - toRoom.bounds.center[0]) + upperFloorOpening.halfExtents[0] > toRoom.bounds.halfExtents[0] + 1e-6
      || Math.abs(upperFloorOpening.center[1] - toRoom.bounds.center[2]) + upperFloorOpening.halfExtents[1] > toRoom.bounds.halfExtents[2] + 1e-6
      || Math.abs(rise - actualRise) > 1e-4 || Math.abs(actualRise - Math.abs(toRoom.finishedFloorY - fromRoom.finishedFloorY)) > 1e-4)
      throw new Error(`functional building: ${label} stair construction/rise/storey authority is inconsistent`);
    return { id, kind: "stairs", fromRoomId, toRoomId, from, to, clearWidth, clearHeight, rise, run, riserCount, treadDepth, upperFloorOpening };
  });
  if (new Set(verticalLinks.map((link) => link.id)).size !== verticalLinks.length) throw new Error("functional building: verticalLinks contains duplicate ids");

  const spawnAnchors = boundedArray(authority.spawnAnchors, "spawnAnchors", 1, 256).map((raw, index): FunctionalBuildingSpawnAnchor => {
    const label = `spawnAnchors[${index}]`, value = object(raw, label);
    exactKeys(value, ["id", "roomId", "kind", "position", "direction", "clearanceRadius", "clearanceHeight"], [], label);
    const id = stableId(value.id, `${label}.id`), roomId = stableId(value.roomId, `${label}.roomId`), kind = string(value.kind, `${label}.kind`), position = vec3(value.position, `${label}.position`), direction = vec3(value.direction, `${label}.direction`), length = Math.hypot(...direction);
    if (kind !== "player" && kind !== "npc" && kind !== "item") throw new Error(`functional building: ${label}.kind is unsupported`);
    const clearanceRadius = positive(value.clearanceRadius, `${label}.clearanceRadius`), clearanceHeight = positive(value.clearanceHeight, `${label}.clearanceHeight`);
    const room = roomMap.get(roomId);
    if (!room || clearanceRadius > 1 || clearanceHeight > 3 || clearanceHeight < .1
      || position[1] < room.finishedFloorY - 1e-4 || position[1] + clearanceHeight > room.ceilingY + 1e-4
      || Math.abs(position[0] - room.bounds.center[0]) + clearanceRadius > room.bounds.halfExtents[0] + 1e-6
      || Math.abs(position[2] - room.bounds.center[2]) + clearanceRadius > room.bounds.halfExtents[2] + 1e-6)
      throw new Error(`functional building: ${label} clearance must be contained by its room`);
    if (Math.abs(length - 1) > 1e-4 || Math.abs(direction[1]) > 1e-4) throw new Error(`functional building: ${label}.direction must be normalized and horizontal`);
    return { id, roomId, kind: kind as "player" | "npc" | "item", position, direction, clearanceRadius, clearanceHeight };
  });
  if (new Set(spawnAnchors.map((anchor) => anchor.id)).size !== spawnAnchors.length || rooms.some((room) => !spawnAnchors.some((anchor) => anchor.roomId === room.id))) throw new Error("functional building: spawnAnchors must have unique ids and cover every room");

  const visibilityCells = boundedArray(authority.visibilityCells, "visibilityCells", 1, 32).map((raw, index): FunctionalBuildingVisibilityCell => {
    const label = `visibilityCells[${index}]`, value = object(raw, label);
    exactKeys(value, ["id", "roomIds", "nodeIds"], [], label);
    const id = stableId(value.id, `${label}.id`), coveredRooms = stringArray(value.roomIds, `${label}.roomIds`), nodeIds = stringArray(value.nodeIds, `${label}.nodeIds`);
    if (coveredRooms.some((roomId) => !roomMap.has(roomId)) || nodeIds.some((nodeId) => !semantic.has(nodeId))) throw new Error(`functional building: ${label} contains unresolved room or node ids`);
    return { id, roomIds: coveredRooms, nodeIds };
  });
  const cellMap = new Map(visibilityCells.map((cell) => [cell.id, cell]));
  const visibleNodeIds = visibilityCells.flatMap((cell) => cell.nodeIds);
  if (cellMap.size !== visibilityCells.length || new Set(visibleNodeIds).size !== visibleNodeIds.length || rooms.some((room) => !cellMap.get(room.visibilityCellId)?.roomIds.includes(room.id)) || roomIds.some((roomId) => visibilityCells.filter((cell) => cell.roomIds.includes(roomId)).length !== 1)) throw new Error("functional building: visibility cells must uniquely own every room/node and match room visibilityCellId");

  const authorityIds = [...rooms.map((entry) => entry.id), ...portals.map((entry) => entry.id), ...verticalLinks.map((entry) => entry.id), ...spawnAnchors.map((entry) => entry.id), ...visibilityCells.map((entry) => entry.id)];
  if (new Set(authorityIds).size !== authorityIds.length) throw new Error("functional building: v2 topology ids must be globally unique");

  const doorById = new Map(doors.map((door) => [door.id, door]));
  if (doorById.size !== doors.length) throw new Error("functional building: doors contains duplicate ids");
  for (const door of doors) {
    const portal = portalMap.get(door.portalId);
    if (portal?.kind !== "door" || portal.doorId !== door.id || !portal.roomIds.includes(door.roomId)) throw new Error(`functional building: door ${door.id} is inconsistent with portal ${door.portalId}`);
  }
  for (const portal of portals) if (portal.kind === "door" && doorById.get(portal.doorId!)?.portalId !== portal.id) throw new Error(`functional building: portal ${portal.id} has no consistent door`);

  const adjacency = new Map(roomIds.map((id) => [id, new Set<string>()])), exterior = new Set<string>();
  for (const portal of portals) {
    const [a, b] = portal.roomIds;
    if (a === null) exterior.add(b!); else if (b === null) exterior.add(a); else { adjacency.get(a)!.add(b); adjacency.get(b)!.add(a); }
  }
  for (const link of verticalLinks) { adjacency.get(link.fromRoomId)!.add(link.toRoomId); adjacency.get(link.toRoomId)!.add(link.fromRoomId); }
  if (exterior.size === 0) throw new Error("functional building: at least one exterior portal is required");
  const reached = new Set(exterior), queue = [...exterior];
  while (queue.length) for (const next of adjacency.get(queue.shift()!)!) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  if (reached.size !== roomIds.length) throw new Error("functional building: every room must be connected to an exterior portal");

  return { schema: FUNCTIONAL_BUILDING_CONTRACT_V2, buildingId, rootNodeId, roomIds, portalIds, entryAnchor, site, colliders, doors, rooms, portals, verticalLinks, spawnAnchors, visibilityCells };
}
