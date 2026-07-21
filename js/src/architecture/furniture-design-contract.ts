import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import type { VisualDesignContract } from "./visual-design-contract.ts";
type V3 = readonly [number, number, number];
const HASH = /^sha256:[0-9a-f]{64}$/,
  ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
type FurniturePartGeometry = Readonly<
  | { kind: "shaped-board"; size: V3; edgeProfile: "eased" | "arched" | "scalloped"; edgeRadiusM: number }
  | {
      kind: "tapered-member";
      lengthM: number;
      bottomSection: readonly [number, number];
      topSection: readonly [number, number];
      axis: "x" | "y" | "z";
      chamferM: number;
    }
  | {
      kind: "profile-extrusion";
      profile: readonly (readonly [number, number])[];
      depthM: number;
      axis: "x" | "z";
      bevelM: number;
    }
  | { kind: "panel"; size: V3; fieldDepthM: number; fieldMarginM: number; edgeRadiusM: number }
  | { kind: "peg"; diameterM: number; lengthM: number; axis: "x" | "y" | "z" }
>;
export interface FurnitureDesignContract {
  readonly schema: "limina.furniture-design-contract/v1";
  readonly id: string;
  readonly role: string;
  readonly visualDesign: { readonly id: string; readonly hash: string };
  readonly dimensions: {
    readonly widthM: number;
    readonly heightM: number;
    readonly depthM: number;
    readonly seatHeightM: number;
    readonly seatDepthM: number;
    readonly occupancy: number;
  };
  readonly chair?: {
    readonly seatPartId: string;
    readonly backPartIds: readonly string[];
    readonly legPartIds: readonly [string, string, string, string];
    readonly usableSeatWidthM: number;
    readonly backSupportHeightM: number;
    readonly ratedLoadKg: number;
    readonly canonicalForward: V3;
  };
  readonly settle?: {
    readonly seatPartId: string;
    readonly backPartIds: readonly string[];
    readonly legPartIds: readonly [string, string, string, string];
    readonly armPartIds: readonly [string, string];
    readonly armSupportPartIds: readonly [string, string];
    readonly occupancySocketIds: readonly [string, string];
    readonly approachSocketId: string;
    readonly usableSeatWidthM: number;
    readonly backSupportHeightM: number;
    readonly ratedLoadKg: number;
    readonly canonicalForward: V3;
  };
  readonly storage?: {
    readonly tierPartIds: readonly [string, string, string, string];
    readonly verticalSupportPartIds: readonly string[];
    readonly approachSocketId: string;
    readonly canonicalFront: V3;
    readonly ratedLoadKgPerTier: number;
  };
  readonly parts: readonly {
    readonly id: string;
    readonly kind: FurniturePartGeometry["kind"];
    readonly materialRole: string;
    readonly center: V3;
    readonly rotationDeg: V3;
    readonly geometry: FurniturePartGeometry;
  }[];
  readonly joints: readonly {
    readonly id: string;
    readonly type: "mortise-tenon" | "wedged-through-tenon" | "dovetail" | "housing" | "drawbore-peg";
    readonly members: readonly [string, string];
    readonly toleranceM: number;
  }[];
  readonly sockets: readonly {
    readonly id: string;
    readonly kind: "occupancy" | "approach" | "inspect";
    readonly position: V3;
    readonly facing: V3;
    readonly supportedBy: string;
    readonly clearanceRadiusM: number;
  }[];
  readonly colliders: readonly {
    readonly id: string;
    readonly center: V3;
    readonly halfExtents: V3;
    readonly covers: readonly string[];
  }[];
  readonly materialRoles: readonly string[];
  readonly status: "draft" | "candidate" | "approved";
}
const finite = (v: unknown, label: string) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${label} must be finite`);
    return v;
  },
  vec = (v: unknown, label: string) => {
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isFinite(n)))
      throw new Error(`${label} must be a finite vec3`);
  };
const SEATING_ROLES = new Set(["bench", "chair", "seat", "settle", "sofa", "stool"]),
  NON_SEATING_ROLES = new Set(["storage", "table"]);
function furnitureRoleClass(role: string): "seating" | "non-seating" {
  const tokens = role
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
    seating = tokens.some((token) => SEATING_ROLES.has(token)),
    nonSeating = tokens.some((token) => NON_SEATING_ROLES.has(token));
  if (seating === nonSeating)
    throw new Error("furniture role must identify exactly one supported seating or table/storage class");
  return seating ? "seating" : "non-seating";
}
const isChairRole = (role: string) =>
  role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes("chair");
const isSettleRole = (role: string) =>
  role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes("settle");
const isStorageRole = (role: string) =>
  role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes("storage");
const LEGACY_SETTLE_IDS = new Set([
  "furniture/hearth-settle/v1",
  "furniture/hearth-settle/v2",
  "furniture/hearth-settle/v2-r2",
]);
export function validateFurnitureDesignContract(
  value: unknown,
  visual?: VisualDesignContract,
): FurnitureDesignContract {
  const c = value as FurnitureDesignContract;
  if (!c || typeof c !== "object" || c.schema !== "limina.furniture-design-contract/v1")
    throw new Error("unsupported furniture design contract");
  if (
    !ID.test(c.id) ||
    typeof c.role !== "string" ||
    !c.role.trim() ||
    !c.visualDesign?.id ||
    !HASH.test(c.visualDesign.hash)
  )
    throw new Error("furniture design identity is incomplete");
  if (visual && visual.id !== c.visualDesign.id) throw new Error("furniture visual design id drifted");
  for (const [key, v] of Object.entries(c.dimensions ?? {})) finite(v, `dimensions.${key}`);
  if (c.dimensions.widthM <= 0 || c.dimensions.heightM <= 0 || c.dimensions.depthM <= 0)
    throw new Error("furniture outer dimensions are invalid");
  if (!Array.isArray(c.parts) || c.parts.length < 4) throw new Error("furniture requires semantic construction parts");
  const parts = new Set<string>(),
    roles = new Set(c.materialRoles);
  for (const part of c.parts) {
    if (!ID.test(part.id) || parts.has(part.id)) throw new Error("furniture part ids must be unique stable ids");
    parts.add(part.id);
    if (
      !["shaped-board", "tapered-member", "profile-extrusion", "panel", "peg"].includes(part.kind) ||
      part.geometry?.kind !== part.kind ||
      !roles.has(part.materialRole)
    )
      throw new Error("furniture part has an unsupported kind, geometry, or material role");
    vec(part.center, "part center");
    vec(part.rotationDeg, "part rotation");
    const g = part.geometry;
    if (g.kind === "shaped-board") {
      vec(g.size, "shaped-board size");
      if (g.size.some((v: number) => v <= 0) || finite(g.edgeRadiusM, "edge radius") <= 0)
        throw new Error("shaped board geometry is invalid");
    } else if (g.kind === "tapered-member") {
      if (
        finite(g.lengthM, "member length") <= 0 ||
        g.bottomSection.some((v: number) => finite(v, "bottom section") <= 0) ||
        g.topSection.some((v: number) => finite(v, "top section") <= 0) ||
        finite(g.chamferM, "member chamfer") <= 0
      )
        throw new Error("tapered member geometry is invalid");
    } else if (g.kind === "profile-extrusion") {
      if (
        g.profile.length < 3 ||
        g.profile.some(
          (point: readonly [number, number]) => point.length !== 2 || point.some((v: number) => !Number.isFinite(v)),
        ) ||
        finite(g.depthM, "profile depth") <= 0 ||
        finite(g.bevelM, "profile bevel") <= 0
      )
        throw new Error("profile extrusion geometry is invalid");
    } else if (g.kind === "panel") {
      vec(g.size, "panel size");
      if (
        g.size.some((v: number) => v <= 0) ||
        finite(g.fieldDepthM, "field depth") <= 0 ||
        finite(g.fieldMarginM, "field margin") <= 0 ||
        finite(g.edgeRadiusM, "panel edge radius") <= 0
      )
        throw new Error("panel geometry is invalid");
    } else if (g.kind === "peg") {
      if (finite(g.diameterM, "peg diameter") <= 0 || finite(g.lengthM, "peg length") <= 0)
        throw new Error("peg geometry is invalid");
    }
  }
  if (!Array.isArray(c.joints) || c.joints.length < 2) throw new Error("furniture requires an explicit join graph");
  for (const joint of c.joints) {
    if (
      !ID.test(joint.id) ||
      joint.members.length !== 2 ||
      joint.members.some((member: string) => !parts.has(member)) ||
      joint.members[0] === joint.members[1] ||
      finite(joint.toleranceM, "joint tolerance") <= 0 ||
      joint.toleranceM > 0.01
    )
      throw new Error("furniture joint is invalid");
  }
  if (!Array.isArray(c.sockets)) throw new Error("furniture sockets must be an array");
  const roleClass = furnitureRoleClass(c.role),
    chairRole = isChairRole(c.role),
    settleRole = isSettleRole(c.role),
    legacySettle = settleRole && LEGACY_SETTLE_IDS.has(c.id),
    storageRole = isStorageRole(c.role),
    occupancySockets = c.sockets.filter((socket) => socket.kind === "occupancy"),
    approachSockets = c.sockets.filter((socket) => socket.kind === "approach");
  if (!Number.isSafeInteger(c.dimensions.occupancy) || c.dimensions.occupancy < 0)
    throw new Error("furniture occupancy must be a non-negative safe integer");
  if (roleClass === "seating") {
    if (c.dimensions.seatHeightM <= 0 || c.dimensions.seatDepthM <= 0 || c.dimensions.occupancy < 1)
      throw new Error("seating furniture requires positive seat dimensions and occupancy");
    if (occupancySockets.length !== c.dimensions.occupancy)
      throw new Error("seating furniture occupancy sockets must exactly match capacity");
  } else {
    if (
      c.dimensions.seatHeightM !== 0 ||
      c.dimensions.seatDepthM !== 0 ||
      c.dimensions.occupancy !== 0 ||
      occupancySockets.length !== 0
    )
      throw new Error("table/storage furniture forbids seat dimensions and fabricated occupancy");
    if (approachSockets.length < 1) throw new Error("table/storage furniture requires an approach socket");
  }
  for (const socket of c.sockets) {
    if (
      !ID.test(socket.id) ||
      !parts.has(socket.supportedBy) ||
      finite(socket.clearanceRadiusM, "socket clearance") <= 0
    )
      throw new Error("furniture socket is invalid");
    vec(socket.position, "socket position");
    vec(socket.facing, "socket facing");
  }
  if (chairRole) {
    const chair = c.chair;
    if (!chair || c.dimensions.occupancy !== 1 || occupancySockets.length !== 1)
      throw new Error("chair furniture requires exactly one occupancy and explicit chair semantics");
    if (
      !ID.test(chair.seatPartId) ||
      !parts.has(chair.seatPartId) ||
      !Array.isArray(chair.backPartIds) ||
      chair.backPartIds.length < 1 ||
      chair.backPartIds.some((id) => !ID.test(id) || !parts.has(id)) ||
      !Array.isArray(chair.legPartIds) ||
      chair.legPartIds.length !== 4 ||
      chair.legPartIds.some((id) => !ID.test(id) || !parts.has(id)) ||
      new Set([chair.seatPartId, ...chair.backPartIds, ...chair.legPartIds]).size !== 1 + chair.backPartIds.length + 4
    )
      throw new Error("chair semantic seat/back/four-leg identities are invalid");
    if (occupancySockets[0].supportedBy !== chair.seatPartId)
      throw new Error("chair occupancy must be supported by its semantic seat");
    if (
      c.dimensions.seatHeightM < 0.43 ||
      c.dimensions.seatHeightM > 0.48 ||
      c.dimensions.seatDepthM < 0.38 ||
      c.dimensions.seatDepthM > 0.45 ||
      finite(chair.usableSeatWidthM, "chair usable seat width") < 0.38 ||
      chair.usableSeatWidthM > 0.46 ||
      chair.usableSeatWidthM > c.dimensions.widthM ||
      finite(chair.backSupportHeightM, "chair back support height") < 0.3 ||
      chair.backSupportHeightM > 0.47 ||
      c.dimensions.seatHeightM + chair.backSupportHeightM > c.dimensions.heightM + 0.002 ||
      finite(chair.ratedLoadKg, "chair rated load") < 100 ||
      chair.ratedLoadKg > 250
    )
      throw new Error("chair ergonomics or rated load are outside the bounded dining policy");
    vec(chair.canonicalForward, "chair canonical forward");
    if (
      Math.abs(chair.canonicalForward[0]) > 1e-8 ||
      Math.abs(chair.canonicalForward[1]) > 1e-8 ||
      Math.abs(chair.canonicalForward[2] + 1) > 1e-8 ||
      occupancySockets[0].facing.some(
        (value: number, index: number) => Math.abs(value - chair.canonicalForward[index]) > 1e-8,
      )
    )
      throw new Error("chair canonical and occupancy forward must be local -Z");
  } else if (c.chair !== undefined) throw new Error("non-chair furniture cannot claim chair semantics");
  if (settleRole && !legacySettle) {
    const settle = c.settle;
    if (!settle || c.dimensions.occupancy !== 2 || occupancySockets.length !== 2 || approachSockets.length !== 1)
      throw new Error("settle furniture requires exactly two occupancies, one approach, and explicit settle semantics");
    const exactGroups: [readonly string[], number][] = [
      [settle?.legPartIds ?? [], 4],
      [settle?.armPartIds ?? [], 2],
      [settle?.armSupportPartIds ?? [], 2],
      [settle?.occupancySocketIds ?? [], 2],
    ];
    if (
      !settle ||
      !ID.test(settle.seatPartId) ||
      !parts.has(settle.seatPartId) ||
      !Array.isArray(settle.backPartIds) ||
      settle.backPartIds.length < 2 ||
      new Set(settle.backPartIds).size !== settle.backPartIds.length ||
      exactGroups.some(([ids, count]) => !Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count)
    )
      throw new Error("settle semantic seat/back/leg/arm/support/socket identities are invalid");
    const semanticParts = [
      settle.seatPartId,
      ...settle.backPartIds,
      ...settle.legPartIds,
      ...settle.armPartIds,
      ...settle.armSupportPartIds,
    ];
    if (
      semanticParts.some((id) => !ID.test(id) || !parts.has(id)) ||
      new Set(semanticParts).size !== semanticParts.length
    )
      throw new Error("settle semantic construction parts must be unique real parts");
    const semanticSockets = settle.occupancySocketIds.map((id) => c.sockets.find((socket) => socket.id === id)),
      approach = c.sockets.find((socket) => socket.id === settle.approachSocketId);
    if (
      semanticSockets.some(
        (socket) => !socket || socket.kind !== "occupancy" || socket.supportedBy !== settle.seatPartId,
      ) ||
      !approach ||
      approach.kind !== "approach"
    )
      throw new Error("settle semantic sockets do not resolve the seat occupancies and front approach");
    if (
      Math.abs(c.dimensions.widthM - 1.6) > 1e-8 ||
      Math.abs(c.dimensions.heightM - 1.3) > 1e-8 ||
      Math.abs(c.dimensions.depthM - 0.7) > 1e-8 ||
      Math.abs(c.dimensions.seatHeightM - 0.46) > 1e-8 ||
      Math.abs(c.dimensions.seatDepthM - 0.5) > 1e-8 ||
      finite(settle.usableSeatWidthM, "settle usable seat width") < 1.28 ||
      settle.usableSeatWidthM > 1.38 ||
      finite(settle.backSupportHeightM, "settle back support height") < 0.7 ||
      settle.backSupportHeightM > 0.84 ||
      c.dimensions.seatHeightM + settle.backSupportHeightM > c.dimensions.heightM + 0.002 ||
      finite(settle.ratedLoadKg, "settle rated load") < 180 ||
      settle.ratedLoadKg > 300
    )
      throw new Error("settle dimensions, ergonomics, or rated load are outside the exact I1 r3 policy");
    vec(settle.canonicalForward, "settle canonical forward");
    if (settle.canonicalForward.some((value: number, index: number) => Math.abs(value - [0, 0, -1][index]) > 1e-8))
      throw new Error("settle canonical forward must be local -Z");
    const expectedOccupancies: readonly V3[] = [
      [-0.32, 0.46, -0.05],
      [0.32, 0.46, -0.05],
    ];
    for (const expected of expectedOccupancies) {
      const socket = semanticSockets.find((candidate) =>
        candidate?.position.every((value: number, index: number) => Math.abs(value - expected[index]) <= 1e-8),
      );
      if (
        !socket ||
        socket.facing.some((value: number, index: number) => Math.abs(value - settle.canonicalForward[index]) > 1e-8) ||
        Math.abs(socket.clearanceRadiusM - 0.3) > 1e-8
      )
        throw new Error("settle occupancies must exactly bind the approved local I1 r3 sockets");
    }
    if (
      approach.position.some((value: number, index: number) => Math.abs(value - ([0, 0, -0.85] as V3)[index]) > 1e-8) ||
      approach.facing.some((value: number, index: number) => Math.abs(value - ([0, 0, 1] as V3)[index]) > 1e-8) ||
      Math.abs(approach.clearanceRadiusM - 0.35) > 1e-8
    )
      throw new Error("settle approach must exactly bind the approved local I1 r3 clearance");
  } else if (c.settle !== undefined) throw new Error("non-settle furniture cannot claim settle semantics");
  if (storageRole) {
    const storage = c.storage;
    if (!storage) throw new Error("storage furniture requires explicit storage semantics");
    const tiers = storage.tierPartIds,
      supports = storage.verticalSupportPartIds;
    if (
      !Array.isArray(tiers) ||
      tiers.length !== 4 ||
      new Set(tiers).size !== 4 ||
      tiers.some((id) => !ID.test(id) || !parts.has(id))
    )
      throw new Error("storage furniture requires four unique semantic tier parts");
    if (
      !Array.isArray(supports) ||
      supports.length < 2 ||
      new Set(supports).size !== supports.length ||
      supports.some((id) => !ID.test(id) || !parts.has(id)) ||
      supports.some((id) => tiers.includes(id))
    )
      throw new Error("storage vertical supports are invalid or overlap its tiers");
    const approach = c.sockets.find((socket) => socket.id === storage.approachSocketId);
    if (!approach || approach.kind !== "approach")
      throw new Error("storage approach semantic must resolve one approach socket");
    vec(storage.canonicalFront, "storage canonical front");
    if (storage.canonicalFront.some((value: number, index: number) => Math.abs(value - [-1, 0, 0][index]) > 1e-8))
      throw new Error("storage canonical front must be local -X");
    if (
      approach.position.some((value: number, index: number) => Math.abs(value - [-0.65, 0, 0][index]) > 1e-8) ||
      approach.facing.some((value: number, index: number) => Math.abs(value - [1, 0, 0][index]) > 1e-8) ||
      Math.abs(approach.clearanceRadiusM - 0.35) > 1e-8
    )
      throw new Error("storage approach must exactly bind the approved local I1 clearance");
    const load = finite(storage.ratedLoadKgPerTier, "storage rated load per tier");
    if (load < 10 || load > 50) throw new Error("storage per-tier rated load is outside the bounded policy");
  } else if (c.storage !== undefined) throw new Error("non-storage furniture cannot claim storage semantics");
  if (!Array.isArray(c.colliders) || c.colliders.length < 2)
    throw new Error("furniture requires compound collision, not a whole AABB");
  for (const collider of c.colliders) {
    if (
      !ID.test(collider.id) ||
      !Array.isArray(collider.covers) ||
      collider.covers.length === 0 ||
      collider.covers.some((part: string) => !parts.has(part))
    )
      throw new Error("furniture collider lacks semantic coverage");
    vec(collider.center, "collider center");
    vec(collider.halfExtents, "collider halfExtents");
    if (collider.halfExtents.some((v: number) => v <= 0))
      throw new Error("furniture collider extents must be positive");
  }
  if (!["draft", "candidate", "approved"].includes(c.status)) throw new Error("unsupported furniture design status");
  return Object.freeze(c);
}
export function furnitureDesignContractHash(value: unknown): string {
  return `sha256:${sha256(canonicalStringify(validateFurnitureDesignContract(value)))}`;
}
