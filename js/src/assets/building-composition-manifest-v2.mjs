import { sha256 } from "../world/sha256.mjs";

export const BUILDING_COMPOSITION_MANIFEST_V2_SCHEMA = "limina.building-composition-manifest/v2";

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const ROLES = new Map([
  ["dining-table", Object.freeze({ occupancy: 0, approach: 4, facing: false })],
  ["dining-chair", Object.freeze({ occupancy: 1, approach: 0, facing: true })],
  ["hearth-settle", Object.freeze({ occupancy: 2, approach: 1, facing: true })],
  ["service-storage", Object.freeze({ occupancy: 0, approach: 1, facing: false })],
]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
}
function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a stable lowercase id`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be lowercase sha256`);
  return value;
}
function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function vec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must be a vec3`);
  value.forEach((entry, index) => finite(entry, `${label}[${index}]`));
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
function portablePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative portable path`);
  }
  return value;
}
function resource(value, label) {
  const entry = object(value, label);
  exactKeys(entry, ["path", "sha256"], [], label);
  portablePath(entry.path, `${label}.path`);
  hash(entry.sha256, `${label}.sha256`);
  return entry;
}
function stageRef(value, expectedKind, label) {
  const entry = object(value, label);
  exactKeys(entry, ["artifactPath", "artifactSha256", "artifactId", "kind", "status", "contractHash", "contentHash"], [], label);
  portablePath(entry.artifactPath, `${label}.artifactPath`);
  hash(entry.artifactSha256, `${label}.artifactSha256`);
  id(entry.artifactId, `${label}.artifactId`);
  if (entry.kind !== expectedKind) throw new Error(`${label}.kind must be ${expectedKind}`);
  if (entry.status !== "approved") throw new Error(`${label} must reference an approved exact artifact`);
  hash(entry.contractHash, `${label}.contractHash`);
  hash(entry.contentHash, `${label}.contentHash`);
  return entry;
}
function idArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((entry, index) => id(entry, `${label}[${index}]`));
  unique(value, label);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function validateBuildingCompositionManifestV2(value) {
  const manifest = object(value, "building composition manifest v2");
  exactKeys(manifest,
    ["schema", "id", "revision", "buildingId", "coordinateSystem", "dependencies", "instances", "legacyExclusions"],
    ["supersedes", "metadata"], "building composition manifest v2");
  if (manifest.schema !== BUILDING_COMPOSITION_MANIFEST_V2_SCHEMA) throw new Error("unsupported building composition manifest v2 schema");
  id(manifest.id, "id"); id(manifest.buildingId, "buildingId");
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw new Error("revision must be positive");
  if (manifest.supersedes !== undefined) id(manifest.supersedes, "supersedes");

  const coordinates = object(manifest.coordinateSystem, "coordinateSystem");
  exactKeys(coordinates, ["units", "up", "front"], [], "coordinateSystem");
  if (coordinates.units !== "meter" || coordinates.up !== "Y" || coordinates.front !== "-Z") {
    throw new Error("composition coordinate system must be meter/Y-up/-Z-front");
  }

  const dependencies = object(manifest.dependencies, "dependencies");
  exactKeys(dependencies, ["shell", "materialPalette", "interiorPlan", "catalog"], [], "dependencies");
  const shell = object(dependencies.shell, "dependencies.shell");
  exactKeys(shell, ["artifact", "approvalDecision", "sourceBlend", "runtimeGlb"], [], "dependencies.shell");
  stageRef(shell.artifact, "shell", "dependencies.shell.artifact");
  resource(shell.approvalDecision, "dependencies.shell.approvalDecision");
  resource(shell.sourceBlend, "dependencies.shell.sourceBlend");
  resource(shell.runtimeGlb, "dependencies.shell.runtimeGlb");
  if (shell.runtimeGlb.sha256 !== shell.artifact.contentHash) throw new Error("shell runtime GLB must match its exact stage content hash");

  const materials = object(dependencies.materialPalette, "dependencies.materialPalette");
  exactKeys(materials, ["artifact", "approvalDecision", "materialsLock", "runtimeGlb"], [], "dependencies.materialPalette");
  stageRef(materials.artifact, "material-palette", "dependencies.materialPalette.artifact");
  resource(materials.approvalDecision, "dependencies.materialPalette.approvalDecision");
  resource(materials.materialsLock, "dependencies.materialPalette.materialsLock");
  resource(materials.runtimeGlb, "dependencies.materialPalette.runtimeGlb");
  if (materials.runtimeGlb.sha256 !== materials.artifact.contentHash) throw new Error("material runtime GLB must match its exact stage content hash");

  const interior = object(dependencies.interiorPlan, "dependencies.interiorPlan");
  exactKeys(interior, ["artifact", "approvalDecision", "plan"], [], "dependencies.interiorPlan");
  stageRef(interior.artifact, "interior-plan", "dependencies.interiorPlan.artifact");
  resource(interior.approvalDecision, "dependencies.interiorPlan.approvalDecision");
  resource(interior.plan, "dependencies.interiorPlan.plan");
  if (interior.plan.sha256 !== interior.artifact.contentHash) throw new Error("interior plan must match its exact stage content hash");

  if (!Array.isArray(dependencies.catalog) || dependencies.catalog.length === 0) throw new Error("dependencies.catalog must contain approved furniture");
  const catalogIds = [], catalogRoles = [], catalogById = new Map();
  for (const [index, raw] of dependencies.catalog.entries()) {
    const label = `dependencies.catalog[${index}]`, entry = object(raw, label);
    exactKeys(entry, ["role", "artifact", "approvalDecision", "designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb"], [], label);
    if (!ROLES.has(entry.role)) throw new Error(`${label}.role is unsupported`);
    stageRef(entry.artifact, "furniture-pack", `${label}.artifact`);
    for (const key of ["approvalDecision", "designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb"]) resource(entry[key], `${label}.${key}`);
    if (entry.runtimeGlb.sha256 !== entry.artifact.contentHash) throw new Error(`${label} runtime GLB must match its exact stage content hash`);
    catalogIds.push(entry.artifact.artifactId); catalogRoles.push(entry.role); catalogById.set(entry.artifact.artifactId, entry);
  }
  unique(catalogIds, "catalog artifact ids"); unique(catalogRoles, "catalog roles");

  if (!Array.isArray(manifest.instances) || manifest.instances.length === 0) throw new Error("composition requires instances");
  const instanceIds = [];
  for (const [index, raw] of manifest.instances.entries()) {
    const label = `instances[${index}]`, instance = object(raw, label);
    exactKeys(instance, ["id", "kind", "role", "catalogArtifactId", "placement", "replacesSemanticIds", "bindings", "constraints"], [], label);
    id(instance.id, `${label}.id`);
    if (instance.kind !== "furniture") throw new Error(`${label}.kind must be furniture`);
    if (!ROLES.has(instance.role)) throw new Error(`${label}.role is unsupported`);
    id(instance.catalogArtifactId, `${label}.catalogArtifactId`);
    const catalog = catalogById.get(instance.catalogArtifactId);
    if (!catalog || catalog.role !== instance.role) throw new Error(`${label} must reference the catalog entry for its role`);
    const placement = object(instance.placement, `${label}.placement`);
    exactKeys(placement, ["position", "yawRadians", "scale"], [], `${label}.placement`);
    vec3(placement.position, `${label}.placement.position`); finite(placement.yawRadians, `${label}.placement.yawRadians`); vec3(placement.scale, `${label}.placement.scale`);
    if (placement.scale.some((entry) => entry !== 1)) throw new Error(`${label} approved instances cannot be rescaled`);
    idArray(instance.replacesSemanticIds, `${label}.replacesSemanticIds`);

    const bindings = object(instance.bindings, `${label}.bindings`);
    exactKeys(bindings, ["roomId", "zoneId", "supportSocketId", "facingTargetId", "occupancySocketIds", "approachSocketIds", "clearanceIds"], [], `${label}.bindings`);
    id(bindings.roomId, `${label}.bindings.roomId`); id(bindings.zoneId, `${label}.bindings.zoneId`); id(bindings.supportSocketId, `${label}.bindings.supportSocketId`);
    if (bindings.facingTargetId !== null) id(bindings.facingTargetId, `${label}.bindings.facingTargetId`);
    idArray(bindings.occupancySocketIds, `${label}.bindings.occupancySocketIds`);
    idArray(bindings.approachSocketIds, `${label}.bindings.approachSocketIds`);
    idArray(bindings.clearanceIds, `${label}.bindings.clearanceIds`);
    if (bindings.clearanceIds.length === 0) throw new Error(`${label} must bind at least one exact I1 clearance`);

    const requirements = ROLES.get(instance.role);
    if (bindings.occupancySocketIds.length !== requirements.occupancy || bindings.approachSocketIds.length !== requirements.approach) {
      throw new Error(`${label} socket bindings do not match ${instance.role}`);
    }
    if ((bindings.facingTargetId !== null) !== requirements.facing) throw new Error(`${label} facing target does not match ${instance.role}`);

    const constraints = object(instance.constraints, `${label}.constraints`);
    exactKeys(constraints, ["floorContact", "containment", "facing", "approachCollisionFree"], [], `${label}.constraints`);
    const floor = object(constraints.floorContact, `${label}.constraints.floorContact`);
    exactKeys(floor, ["surfaceId", "targetY", "toleranceM"], [], `${label}.constraints.floorContact`);
    id(floor.surfaceId, `${label}.constraints.floorContact.surfaceId`); finite(floor.targetY, `${label}.constraints.floorContact.targetY`); finite(floor.toleranceM, `${label}.constraints.floorContact.toleranceM`);
    if (floor.toleranceM <= 0 || floor.toleranceM > 0.01) throw new Error(`${label} floor tolerance must be within (0, 0.01]m`);
    const containment = object(constraints.containment, `${label}.constraints.containment`);
    exactKeys(containment, ["roomId"], [], `${label}.constraints.containment`); id(containment.roomId, `${label}.constraints.containment.roomId`);
    if (containment.roomId !== bindings.roomId) throw new Error(`${label} containment room must match its binding`);
    if (constraints.facing === null) {
      if (requirements.facing) throw new Error(`${label} requires a facing constraint`);
    } else {
      if (!requirements.facing) throw new Error(`${label} must not invent a facing constraint`);
      const facing = object(constraints.facing, `${label}.constraints.facing`);
      exactKeys(facing, ["socketIds", "targetSemanticId", "minimumDot"], [], `${label}.constraints.facing`);
      idArray(facing.socketIds, `${label}.constraints.facing.socketIds`); id(facing.targetSemanticId, `${label}.constraints.facing.targetSemanticId`); finite(facing.minimumDot, `${label}.constraints.facing.minimumDot`);
      if (facing.socketIds.length === 0 || facing.minimumDot < -1 || facing.minimumDot > 1) throw new Error(`${label} facing constraint is invalid`);
      if (facing.targetSemanticId !== bindings.facingTargetId) throw new Error(`${label} facing target constraint drifted`);
    }
    if (constraints.approachCollisionFree !== (requirements.approach > 0)) throw new Error(`${label} approach policy does not match ${instance.role}`);
    instanceIds.push(instance.id);
  }
  unique(instanceIds, "composition instance ids");

  idArray(manifest.legacyExclusions, "legacyExclusions");
  if (manifest.legacyExclusions.length === 0) throw new Error("legacyExclusions must be non-empty");
  if (manifest.metadata !== undefined) object(manifest.metadata, "metadata");
  return Object.freeze(manifest);
}

export function buildingCompositionManifestV2Hash(value) {
  const manifest = validateBuildingCompositionManifestV2(value);
  return `sha256:${sha256(JSON.stringify(canonical(manifest)))}`;
}
