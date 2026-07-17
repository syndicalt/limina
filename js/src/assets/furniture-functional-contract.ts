// Pure-byte runtime authority for authored functional furniture.  The render and
// simulation lanes both consume this parser; it deliberately does not invoke GLTFLoader.

import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  type FurnitureDesignContract,
} from "../architecture/furniture-design-contract.ts";

export const FURNITURE_FUNCTIONAL_CONTRACT = "limina.furniture-design-contract/v1" as const;
export type FurnitureV3 = [number, number, number];
export interface FunctionalFurnitureSocket {
  id: string;
  kind: "occupancy" | "approach" | "inspect";
  position: FurnitureV3;
  facing: FurnitureV3;
  supportedBy: string;
  clearanceRadiusM: number;
}
export interface FunctionalFurnitureCollider {
  id: string;
  center: FurnitureV3;
  halfExtents: FurnitureV3;
  covers: string[];
}
export interface FunctionalFurnitureContract {
  schema: typeof FURNITURE_FUNCTIONAL_CONTRACT;
  furnitureId: string;
  role: string;
  contractHash: string;
  partIds: string[];
  sockets: FunctionalFurnitureSocket[];
  colliders: FunctionalFurnitureCollider[];
  design: FurnitureDesignContract;
}

type JsonObject = Record<string, unknown>;
const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a;
const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`functional furniture: ${label} must be an object`);
  return value as JsonObject;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`functional furniture: ${label} must be a non-empty string`);
  return value;
};
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`functional furniture: ${label} must be finite`);
  return value;
};
const vec3 = (value: unknown, label: string, positive = false): FurnitureV3 => {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`functional furniture: ${label} must be a vec3`);
  const result: FurnitureV3 = [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`), finite(value[2], `${label}[2]`)];
  if (positive && result.some((axis) => axis <= 0)) throw new Error(`functional furniture: ${label} axes must be positive`);
  return result;
};
const sameVec3 = (a: readonly number[], b: readonly number[]): boolean => a.length === 3 && b.length === 3 && a.every((value, index) => value === b[index]);

function gltfJson(bytes: Uint8Array): JsonObject {
  if (bytes.byteLength < 12) throw new Error("functional furniture: truncated glTF bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("functional furniture: runtime asset must be a binary GLB");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("functional furniture: GLB length header mismatch");
  let offset = 12, jsonBytes: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true), end = offset + 8 + length;
    if (end > bytes.byteLength) throw new Error("functional furniture: truncated GLB chunk");
    if (type === CHUNK_JSON && jsonBytes === undefined) jsonBytes = bytes.subarray(offset + 8, end);
    offset = end;
  }
  if (offset !== bytes.byteLength || jsonBytes === undefined) throw new Error("functional furniture: malformed GLB chunks");
  try { return object(JSON.parse(new TextDecoder().decode(jsonBytes).trim()), "glTF root"); }
  catch (error) { throw new Error(`functional furniture: invalid glTF JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Read, hash, and cross-check the semantic furniture authority embedded in a GLB. */
export function parseFunctionalFurnitureContract(bytes: Uint8Array): FunctionalFurnitureContract {
  const json = gltfJson(bytes), asset = object(json.asset, "asset"), extras = object(asset.extras, "asset.extras");
  const raw = extras.liminaFurnitureContract;
  if (raw === undefined) throw new Error("functional furniture: missing asset.extras.liminaFurnitureContract");
  const design = validateFurnitureDesignContract(raw);
  const embeddedHash = string(extras.liminaFurnitureContractHash, "asset.extras.liminaFurnitureContractHash");
  const computedHash = furnitureDesignContractHash(design);
  if (embeddedHash !== computedHash) throw new Error(`functional furniture: embedded contract hash mismatch (${embeddedHash} != ${computedHash})`);

  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const semantic = new Map<string, { role: string; node: JsonObject; extras: JsonObject }>();
  for (let index = 0; index < nodes.length; index++) {
    const node = object(nodes[index], `nodes[${index}]`);
    if (node.extras === undefined) continue;
    const nodeExtras = object(node.extras, `nodes[${index}].extras`);
    if (nodeExtras["limina.id"] === undefined && nodeExtras["limina.role"] === undefined) continue;
    const id = string(nodeExtras["limina.id"], `nodes[${index}].extras.limina.id`);
    const role = string(nodeExtras["limina.role"], `${id}.limina.role`);
    if (semantic.has(id)) throw new Error(`functional furniture: duplicate semantic node id ${id}`);
    semantic.set(id, { role, node, extras: nodeExtras });
  }
  if (semantic.get(design.id)?.role !== design.role) throw new Error("functional furniture: furniture root semantic node is unresolved");

  const partIds = design.parts.map((part) => part.id);
  const partSet = new Set(partIds);
  for (const part of design.parts) {
    const item = semantic.get(part.id);
    if (item?.role !== "furniture-part" || !Number.isSafeInteger(item.node.mesh)) throw new Error(`functional furniture: part ${part.id} is unresolved or has no authored mesh`);
    if (item.extras["limina.kind"] !== part.kind || item.extras["limina.materialRole"] !== part.materialRole) throw new Error(`functional furniture: part ${part.id} semantic metadata drifted`);
  }

  const sockets: FunctionalFurnitureSocket[] = design.sockets.map((socket) => {
    const item = semantic.get(socket.id);
    if (item?.role !== "socket" || item.extras["limina.kind"] !== socket.kind) throw new Error(`functional furniture: socket ${socket.id} is unresolved`);
    const supportedBy = string(item.extras["limina.supportedBy"], `${socket.id}.supportedBy`);
    if (supportedBy !== socket.supportedBy || !partSet.has(supportedBy)) throw new Error(`functional furniture: socket ${socket.id} has unresolved support`);
    const position = vec3(item.extras["limina.position"], `${socket.id}.position`), facing = vec3(item.extras["limina.facing"], `${socket.id}.facing`);
    const length = Math.hypot(...facing);
    if (length < 1e-6 || Math.abs(length - 1) > 1e-5) throw new Error(`functional furniture: socket ${socket.id} facing must be normalized`);
    const clearanceRadiusM = finite(item.extras["limina.clearanceRadiusM"], `${socket.id}.clearanceRadiusM`);
    if (clearanceRadiusM <= 0) throw new Error(`functional furniture: socket ${socket.id} clearance must be positive`);
    if (!sameVec3(position, socket.position) || !sameVec3(facing, socket.facing) || clearanceRadiusM !== socket.clearanceRadiusM) throw new Error(`functional furniture: socket ${socket.id} node metadata drifted from its pinned contract`);
    return { id: socket.id, kind: socket.kind, position, facing, supportedBy, clearanceRadiusM };
  });

  if (design.colliders.length < 2) throw new Error("functional furniture: compound collision requires at least two colliders");
  const colliders: FunctionalFurnitureCollider[] = design.colliders.map((collider) => {
    const item = semantic.get(collider.id);
    if (item?.role !== "collider") throw new Error(`functional furniture: collider ${collider.id} is unresolved`);
    const center = vec3(item.extras["limina.center"], `${collider.id}.center`), halfExtents = vec3(item.extras["limina.halfExtents"], `${collider.id}.halfExtents`, true);
    if (!Array.isArray(item.extras["limina.covers"])) throw new Error(`functional furniture: collider ${collider.id} lacks semantic coverage`);
    const covers = (item.extras["limina.covers"] as unknown[]).map((value, index) => string(value, `${collider.id}.covers[${index}]`));
    if (covers.length === 0 || covers.some((id) => !partSet.has(id)) || new Set(covers).size !== covers.length) throw new Error(`functional furniture: collider ${collider.id} has malformed coverage`);
    if (covers.length === partIds.length) throw new Error("functional furniture: generic whole-object collider is forbidden");
    if (!sameVec3(center, collider.center) || !sameVec3(halfExtents, collider.halfExtents) || covers.length !== collider.covers.length || covers.some((id, index) => id !== collider.covers[index])) throw new Error(`functional furniture: collider ${collider.id} node metadata drifted from its pinned contract`);
    return { id: collider.id, center, halfExtents, covers };
  });

  const expected = new Set([design.id, ...partIds, ...sockets.map((socket) => socket.id), ...colliders.map((collider) => collider.id)]);
  for (const [id, item] of semantic) {
    if ([design.role, "furniture-part", "socket", "collider"].includes(item.role) && !expected.has(id)) throw new Error(`functional furniture: undeclared semantic node ${id}`);
  }
  return { schema: FURNITURE_FUNCTIONAL_CONTRACT, furnitureId: design.id, role: design.role, contractHash: computedHash, partIds, sockets, colliders, design };
}
