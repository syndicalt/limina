// Exact FB-5 furnishing sidecar. Furnishing is deliberately separate from the reviewed building
// GLB: R1 publishes semantic sockets and compound collision only. A later visual=true promotion is
// new rendered content and must use a new authority and fresh engine/HITL evidence.

import { parseFunctionalBuildingContract } from "./functional-building-contract.ts";
import { parseFunctionalFurnitureContract } from "./furniture-functional-contract.ts";
import { assertApprovedFunctionalSettlementRelease } from "./functional-settlement-release.mjs";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FUNCTIONAL_SETTLEMENT_FURNISHING_SCHEMA = "limina.functional-settlement-furnishing-authority/v1";
export const FUNCTIONAL_SETTLEMENT_FURNISHING_VISUAL_MODE = "semantic-only-preserve-approved-building-pixels";
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/;
const BRANDED = new WeakSet();
const INTERNAL = new WeakMap();
const fail = (message) => { throw new Error(`functional settlement furnishing: ${message}`); };
const rawHash = (bytes) => `sha256:${sha256(bytes)}`;

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must be a plain object`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must contain only enumerable data fields`);
  return value;
}
function keys(value, required, label) {
  plain(value, label);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...required].sort())) fail(`${label} keys drifted`);
}
function id(value, label) {
  if (typeof value !== "string" || !ID.test(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) fail(`${label} is invalid`);
  return value;
}
function hash(value, label) { if (typeof value !== "string" || !HASH.test(value)) fail(`${label} is invalid`); return value; }
function pathValue(value, label) { if (typeof value !== "string" || !PATH.test(value)) fail(`${label} is invalid`); return value; }
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is invalid`); return value; }
function finite(value, label, minimum = -1e9, maximum = 1e9) { if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} is invalid`); return value; }
function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || Object.getOwnPropertyNames(value).length !== length + 1) fail(`${label} must be a dense vec${length}`);
  return Object.freeze(value.map((entry, index) => finite(entry, `${label}[${index}]`)));
}
function dense(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || Object.getOwnPropertyNames(value).length !== value.length + 1) fail(`${label} must contain ${minimum}..${maximum} dense entries`);
  return value;
}
function decode(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); }
  catch (error) { fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
function readRaw(ref, read, label, bytesRequired = false) {
  keys(ref, bytesRequired ? ["path", "sha256", "bytes"] : ["path", "sha256"], label);
  const parsed = { path: pathValue(ref.path, `${label}.path`), sha256: hash(ref.sha256, `${label}.sha256`), ...(bytesRequired ? { bytes: integer(ref.bytes, `${label}.bytes`, 1) } : {}) };
  const bytes = read(parsed.path);
  if (!(bytes instanceof Uint8Array) || (bytesRequired && bytes.byteLength !== parsed.bytes) || rawHash(bytes) !== parsed.sha256) fail(`${label} exact bytes drifted`);
  return { ref: Object.freeze(parsed), bytes };
}
function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === "object") { const out = {}; for (const [key, entry] of Object.entries(value)) out[key] = deepFreeze(entry); return Object.freeze(out); }
  return value;
}
function rotateXZ(x, z, yaw) { const c = Math.cos(yaw), s = Math.sin(yaw); return [x * c + z * s, -x * s + z * c]; }
function transformedBounds(contract, socket) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const collider of contract.colliders) {
    const [cx, cz] = rotateXZ(collider.center[0], collider.center[2], socket.yawRadians);
    const c = Math.abs(Math.cos(socket.yawRadians)), s = Math.abs(Math.sin(socket.yawRadians));
    const hx = collider.halfExtents[0] * c + collider.halfExtents[2] * s;
    const hz = collider.halfExtents[0] * s + collider.halfExtents[2] * c;
    minX = Math.min(minX, socket.position[0] + cx - hx); maxX = Math.max(maxX, socket.position[0] + cx + hx);
    minZ = Math.min(minZ, socket.position[2] + cz - hz); maxZ = Math.max(maxZ, socket.position[2] + cz + hz);
    minY = Math.min(minY, socket.position[1] + collider.center[1] - collider.halfExtents[1]);
    maxY = Math.max(maxY, socket.position[1] + collider.center[1] + collider.halfExtents[1]);
  }
  return Object.freeze({ minX, minY, minZ, maxX, maxY, maxZ });
}
function overlaps(left, right, margin = 0.02) {
  return left.minX < right.maxX + margin && left.maxX > right.minX - margin && left.minY < right.maxY + margin && left.maxY > right.minY - margin && left.minZ < right.maxZ + margin && left.maxZ > right.minZ - margin;
}
function contains(room, bounds) {
  const min = room.bounds.center.map((entry, index) => entry - room.bounds.halfExtents[index]);
  const max = room.bounds.center.map((entry, index) => entry + room.bounds.halfExtents[index]);
  return bounds.minX >= min[0] + 0.03 && bounds.maxX <= max[0] - 0.03 && bounds.minY >= room.finishedFloorY - 1e-6 && bounds.maxY <= room.ceilingY + 1e-6 && bounds.minZ >= min[2] + 0.03 && bounds.maxZ <= max[2] - 0.03;
}

export function functionalSettlementFurnishingClosureHash(value) {
  const { closureHash: _ignored, ...body } = value;
  return rawHash(new TextEncoder().encode(canonicalCompilerJson(body)));
}

export function deriveFunctionalSettlementFurnishingVariantId(seed, placementId, variantIds) {
  id(seed, "assignment seed"); id(placementId, "assignment placementId");
  const sorted = [...variantIds].map((entry, index) => id(entry, `assignment variants[${index}]`)).sort();
  if (sorted.length < 2 || new Set(sorted).size !== sorted.length) fail("assignment requires at least two unique variants");
  const digest = sha256(canonicalCompilerJson({ algorithm: "sha256-canonical-modulo-v1", seed, placementId, variants: sorted }));
  return sorted[Number.parseInt(digest.slice(0, 8), 16) % sorted.length];
}

/** Independently close a semantic-only furnishing authority against one branded FB-5 release. */
export function loadApprovedFunctionalSettlementFurnishingAuthority(bytes, releaseValue, read) {
  if (!(bytes instanceof Uint8Array) || typeof read !== "function") fail("loader requires authority bytes and an exact reader");
  const release = assertApprovedFunctionalSettlementRelease(releaseValue);
  const value = decode(bytes, "authority");
  keys(value, ["schema", "authorityId", "revision", "release", "building", "visualPolicy", "library", "sockets", "variants", "assignment", "limits", "closureHash"], "authority");
  if (value.schema !== FUNCTIONAL_SETTLEMENT_FURNISHING_SCHEMA) fail("schema is unsupported");
  id(value.authorityId, "authorityId"); integer(value.revision, "revision", 1, 2 ** 31 - 1); hash(value.closureHash, "closureHash");
  if (functionalSettlementFurnishingClosureHash(value) !== value.closureHash) fail("closure hash drifted");

  keys(value.release, ["path", "sha256", "releaseId", "settlementId", "closureHash"], "release");
  const releaseBytes = read(pathValue(value.release.path, "release.path"));
  if (!(releaseBytes instanceof Uint8Array) || rawHash(releaseBytes) !== hash(value.release.sha256, "release.sha256")) fail("release exact bytes drifted");
  if (value.release.releaseId !== release.release.releaseId || value.release.settlementId !== release.release.settlementId || value.release.closureHash !== release.release.closureHash) fail("release identity drifted");

  keys(value.building, ["catalogEntryId", "contractHash", "semanticFingerprint"], "building");
  const entry = release.publication.catalog.entries.find((candidate) => candidate.entryId === id(value.building.catalogEntryId, "building.catalogEntryId"));
  if (entry === undefined || entry.placementClass !== "functional-building" || entry.functionalContract.hash !== hash(value.building.contractHash, "building.contractHash") || entry.semanticIdentity.fingerprint !== hash(value.building.semanticFingerprint, "building.semanticFingerprint")) fail("building catalog/contract identity drifted");
  const buildingContract = parseFunctionalBuildingContract(read(release.publication.asset.path));
  const rooms = new Map(buildingContract.rooms.map((room) => [room.id, room]));

  keys(value.visualPolicy, ["mode", "activation", "runtimeVisual", "runtimeCollision", "approvedBuildingAssetUnchanged", "visualPromotionRequiresFreshEngineHitl"], "visualPolicy");
  if (value.visualPolicy.mode !== FUNCTIONAL_SETTLEMENT_FURNISHING_VISUAL_MODE || value.visualPolicy.activation !== "dormant-authoring-sidecar" || value.visualPolicy.runtimeVisual !== false || value.visualPolicy.runtimeCollision !== false || value.visualPolicy.approvedBuildingAssetUnchanged !== true || value.visualPolicy.visualPromotionRequiresFreshEngineHitl !== true) fail("visual policy must keep visuals/collision dormant, preserve approved pixels, and require fresh visual HITL");

  const library = new Map();
  for (const [index, source] of dense(value.library, 1, 64, "library").entries()) {
    const label = `library[${index}]`; keys(source, ["libraryId", "role", "furnitureId", "contractHash", "asset", "approvalArtifact", "approvalDecision"], label);
    const libraryId = id(source.libraryId, `${label}.libraryId`); if (library.has(libraryId)) fail(`duplicate library id '${libraryId}'`);
    const asset = readRaw(source.asset, read, `${label}.asset`, true), approvalArtifact = readRaw(source.approvalArtifact, read, `${label}.approvalArtifact`), approvalDecision = readRaw(source.approvalDecision, read, `${label}.approvalDecision`);
    const contract = parseFunctionalFurnitureContract(asset.bytes), contractHash = hash(source.contractHash, `${label}.contractHash`);
    if (contract.contractHash !== contractHash || contract.furnitureId !== id(source.furnitureId, `${label}.furnitureId`) || contract.role !== id(source.role, `${label}.role`)) fail(`${label} functional contract identity drifted`);
    const artifact = decode(approvalArtifact.bytes, `${label}.approvalArtifact`), decision = decode(approvalDecision.bytes, `${label}.approvalDecision`);
    if (artifact.kind !== "furniture-pack" || artifact.status !== "approved" || artifact.artifactId !== libraryId || artifact.contractHash !== contractHash || artifact.contentHash !== asset.ref.sha256) fail(`${label} approved artifact does not bind exact furniture bytes`);
    if (decision.gate !== "F1-asset" || decision.decision !== "approve" || decision.artifactId !== libraryId || decision.contractHash !== contractHash || decision.contentHash !== asset.ref.sha256) fail(`${label} HITL decision does not bind the approved artifact`);
    library.set(libraryId, Object.freeze({ libraryId, role: contract.role, furnitureId: contract.furnitureId, contractHash, asset: asset.ref, approvalArtifact: approvalArtifact.ref, approvalDecision: approvalDecision.ref, contract }));
  }
  const sortedLibrary = [...library.keys()].sort(); if ([...library.keys()].some((entry, index) => entry !== sortedLibrary[index])) fail("library must be libraryId-sorted");

  const sockets = new Map();
  for (const [index, source] of dense(value.sockets, 1, 128, "sockets").entries()) {
    const label = `sockets[${index}]`; keys(source, ["socketId", "roomId", "position", "yawRadians", "allowedRoles"], label);
    const socketId = id(source.socketId, `${label}.socketId`), roomId = id(source.roomId, `${label}.roomId`); if (sockets.has(socketId)) fail(`duplicate socket '${socketId}'`);
    const room = rooms.get(roomId); if (room === undefined) fail(`${label} references unknown functional room`);
    const position = vector(source.position, 3, `${label}.position`), yawRadians = finite(source.yawRadians, `${label}.yawRadians`, -Math.PI, Math.PI);
    if (Math.abs(position[1] - room.finishedFloorY) > 1e-6) fail(`${label} is not on its exact finished floor`);
    const allowedRoles = dense(source.allowedRoles, 1, 8, `${label}.allowedRoles`).map((role, roleIndex) => id(role, `${label}.allowedRoles[${roleIndex}]`));
    if (new Set(allowedRoles).size !== allowedRoles.length || [...allowedRoles].sort().some((role, roleIndex) => role !== allowedRoles[roleIndex])) fail(`${label}.allowedRoles must be sorted and unique`);
    sockets.set(socketId, Object.freeze({ socketId, roomId, position, yawRadians, allowedRoles: Object.freeze(allowedRoles) }));
  }
  const sortedSockets = [...sockets.keys()].sort(); if ([...sockets.keys()].some((entry, index) => entry !== sortedSockets[index])) fail("sockets must be socketId-sorted");

  const variants = new Map();
  for (const [index, source] of dense(value.variants, 2, 32, "variants").entries()) {
    const label = `variants[${index}]`; keys(source, ["variantId", "bindings"], label);
    const variantId = id(source.variantId, `${label}.variantId`); if (variants.has(variantId)) fail(`duplicate variant '${variantId}'`);
    const bindings = [], occupied = [], bindingIds = new Set(), usedSockets = new Set();
    for (const [bindingIndex, raw] of dense(source.bindings, 1, 64, `${label}.bindings`).entries()) {
      const bindingLabel = `${label}.bindings[${bindingIndex}]`; keys(raw, ["instanceId", "socketId", "libraryId"], bindingLabel);
      const instanceId = id(raw.instanceId, `${bindingLabel}.instanceId`), socketId = id(raw.socketId, `${bindingLabel}.socketId`), libraryId = id(raw.libraryId, `${bindingLabel}.libraryId`);
      if (bindingIds.has(instanceId) || usedSockets.has(socketId)) fail(`${label} contains duplicate instance/socket bindings`); bindingIds.add(instanceId); usedSockets.add(socketId);
      const socket = sockets.get(socketId), item = library.get(libraryId); if (socket === undefined || item === undefined || !socket.allowedRoles.includes(item.role)) fail(`${bindingLabel} socket/library role is incompatible`);
      const bounds = transformedBounds(item.contract, socket), room = rooms.get(socket.roomId); if (!contains(room, bounds)) fail(`${bindingLabel} furniture leaves its bound functional room`);
      for (const prior of occupied) if (prior.socket.roomId === socket.roomId && overlaps(prior.bounds, bounds)) fail(`${bindingLabel} collides with '${prior.instanceId}'`);
      for (const spawn of buildingContract.spawnAnchors.filter((anchor) => anchor.roomId === socket.roomId)) {
        const x = Math.max(bounds.minX, Math.min(spawn.position[0], bounds.maxX)), z = Math.max(bounds.minZ, Math.min(spawn.position[2], bounds.maxZ));
        if (Math.hypot(spawn.position[0] - x, spawn.position[2] - z) < spawn.clearanceRadius + 0.05) fail(`${bindingLabel} obstructs '${spawn.id}'`);
      }
      occupied.push({ instanceId, socket, bounds }); bindings.push(Object.freeze({ instanceId, socketId, libraryId }));
    }
    if (bindings.some((binding, bindingIndex) => bindingIndex > 0 && bindings[bindingIndex - 1].instanceId >= binding.instanceId)) fail(`${label}.bindings must be instanceId-sorted`);
    variants.set(variantId, Object.freeze({ variantId, bindings: Object.freeze(bindings) }));
  }
  const variantIds = [...variants.keys()]; if (variantIds.some((entry, index) => index > 0 && variantIds[index - 1] >= entry)) fail("variants must be variantId-sorted");

  keys(value.assignment, ["algorithm", "seed", "placements"], "assignment");
  if (value.assignment.algorithm !== "sha256-canonical-modulo-v1") fail("assignment algorithm is unsupported");
  const seed = id(value.assignment.seed, "assignment.seed"), assignments = new Map(), expectedPlacements = [...release.plan.placements].sort((a, b) => a.placementId.localeCompare(b.placementId));
  const assignmentRows = dense(value.assignment.placements, expectedPlacements.length, expectedPlacements.length, "assignment.placements");
  for (const [index, source] of assignmentRows.entries()) {
    keys(source, ["placementId", "variantId"], `assignment.placements[${index}]`);
    const placementId = id(source.placementId, `assignment.placements[${index}].placementId`), variantId = id(source.variantId, `assignment.placements[${index}].variantId`);
    if (placementId !== expectedPlacements[index].placementId || variantId !== deriveFunctionalSettlementFurnishingVariantId(seed, placementId, variantIds)) fail(`assignment.placements[${index}] is not the deterministic release assignment`);
    assignments.set(placementId, variantId);
  }
  if (new Set(assignments.values()).size < 2) fail("release assignment must exercise at least two meaningful furnishing variants");

  keys(value.limits, ["maximumInstancesPerBuilding", "maximumColliderEntitiesPerBuilding", "maximumSocketCountPerBuilding"], "limits");
  const limits = { maximumInstancesPerBuilding: integer(value.limits.maximumInstancesPerBuilding, "limits.maximumInstancesPerBuilding", 1, 64), maximumColliderEntitiesPerBuilding: integer(value.limits.maximumColliderEntitiesPerBuilding, "limits.maximumColliderEntitiesPerBuilding", 1, 1024), maximumSocketCountPerBuilding: integer(value.limits.maximumSocketCountPerBuilding, "limits.maximumSocketCountPerBuilding", 1, 512) };
  for (const variant of variants.values()) {
    const colliders = variant.bindings.reduce((sum, binding) => sum + library.get(binding.libraryId).contract.colliders.length, 0), socketCount = variant.bindings.reduce((sum, binding) => sum + library.get(binding.libraryId).contract.sockets.length, 0);
    if (variant.bindings.length > limits.maximumInstancesPerBuilding || colliders > limits.maximumColliderEntitiesPerBuilding || socketCount > limits.maximumSocketCountPerBuilding) fail(`variant '${variant.variantId}' exceeds declared runtime limits`);
  }

  const loaded = Object.freeze({ authority: deepFreeze(value), release, buildingContract: deepFreeze(buildingContract), limits: Object.freeze(limits) });
  BRANDED.add(loaded); INTERNAL.set(loaded, { library, sockets, variants, assignments }); return loaded;
}

export function assertApprovedFunctionalSettlementFurnishingAuthority(value) {
  if (value === null || typeof value !== "object" || !BRANDED.has(value)) fail("value is not a verified in-process furnishing authority");
  return value;
}

/** Return one immutable, assignment-resolved placement recipe without exposing mutable Maps. */
export function resolveApprovedFunctionalSettlementFurnishing(value, placementId) {
  const loaded = assertApprovedFunctionalSettlementFurnishingAuthority(value), internal = INTERNAL.get(loaded);
  const variantId = internal.assignments.get(id(placementId, "placementId")), variant = internal.variants.get(variantId);
  if (variant === undefined) fail(`placement '${placementId}' is absent from the exact assignment`);
  return Object.freeze({ placementId, variantId, bindings: Object.freeze(variant.bindings.map((binding) => Object.freeze({
    ...binding, socket: internal.sockets.get(binding.socketId), library: internal.library.get(binding.libraryId),
  }))) });
}
