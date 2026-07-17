import { createHash } from "node:crypto";

export const BUILDING_COMPOSITION_MANIFEST_SCHEMA = "limina.building-composition-manifest/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const STAGE_KINDS = new Set(["shell", "interior-plan", "furniture-pack", "prop-pack", "fire-runtime"]);
const STAGE_STATES = new Set(["draft", "candidate", "approved"]);

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
  exactKeys(entry, ["artifactPath", "artifactId", "kind", "status", "contractHash", "contentHash"], [], label);
  portablePath(entry.artifactPath, `${label}.artifactPath`);
  id(entry.artifactId, `${label}.artifactId`);
  if (!STAGE_KINDS.has(entry.kind) || entry.kind !== expectedKind) throw new Error(`${label}.kind must be ${expectedKind}`);
  if (!STAGE_STATES.has(entry.status)) throw new Error(`${label}.status is unsupported`);
  hash(entry.contractHash, `${label}.contractHash`);
  hash(entry.contentHash, `${label}.contentHash`);
  return entry;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function validateBuildingCompositionManifest(value) {
  const manifest = object(value, "building composition manifest");
  exactKeys(manifest,
    ["schema", "id", "revision", "buildingId", "coordinateSystem", "dependencies", "instances", "legacyExclusions"],
    ["supersedes", "metadata"], "building composition manifest");
  if (manifest.schema !== BUILDING_COMPOSITION_MANIFEST_SCHEMA) throw new Error("unsupported building composition manifest schema");
  id(manifest.id, "id"); id(manifest.buildingId, "buildingId");
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw new Error("revision must be positive");
  if (manifest.supersedes !== undefined) id(manifest.supersedes, "supersedes");

  const coordinates = object(manifest.coordinateSystem, "coordinateSystem");
  exactKeys(coordinates, ["units", "up", "front"], [], "coordinateSystem");
  if (coordinates.units !== "meter" || coordinates.up !== "Y" || coordinates.front !== "-Z") throw new Error("composition coordinate system must be meter/Y-up/-Z-front");

  const dependencies = object(manifest.dependencies, "dependencies");
  exactKeys(dependencies, ["shell", "interiorPlan", "catalog"], [], "dependencies");
  const shell = object(dependencies.shell, "dependencies.shell");
  exactKeys(shell, ["artifact", "sourceBlend", "runtimeGlb"], [], "dependencies.shell");
  stageRef(shell.artifact, "shell", "dependencies.shell.artifact");
  resource(shell.sourceBlend, "dependencies.shell.sourceBlend");
  resource(shell.runtimeGlb, "dependencies.shell.runtimeGlb");
  if (shell.runtimeGlb.sha256 !== shell.artifact.contentHash) throw new Error("shell runtime GLB must match its exact stage content hash");

  const interior = object(dependencies.interiorPlan, "dependencies.interiorPlan");
  exactKeys(interior, ["artifact", "plan"], [], "dependencies.interiorPlan");
  stageRef(interior.artifact, "interior-plan", "dependencies.interiorPlan.artifact");
  resource(interior.plan, "dependencies.interiorPlan.plan");
  if (interior.plan.sha256 !== interior.artifact.contentHash) throw new Error("interior plan resource must match its exact stage content hash");

  if (!Array.isArray(dependencies.catalog) || dependencies.catalog.length === 0) throw new Error("dependencies.catalog must contain approved assets");
  const catalogIds = [];
  for (const [index, raw] of dependencies.catalog.entries()) {
    const label = `dependencies.catalog[${index}]`, entry = object(raw, label);
    exactKeys(entry, ["artifact", "sourceBlend", "runtimeGlb", "approvalDecision"], [], label);
    if (!new Set(["furniture-pack", "prop-pack", "fire-runtime"]).has(entry.artifact?.kind)) throw new Error(`${label}.artifact.kind is not composable catalog content`);
    stageRef(entry.artifact, entry.artifact.kind, `${label}.artifact`);
    resource(entry.sourceBlend, `${label}.sourceBlend`); resource(entry.runtimeGlb, `${label}.runtimeGlb`); resource(entry.approvalDecision, `${label}.approvalDecision`);
    if (entry.runtimeGlb.sha256 !== entry.artifact.contentHash) throw new Error(`${label} runtime GLB must match its exact stage content hash`);
    catalogIds.push(entry.artifact.artifactId);
  }
  unique(catalogIds, "catalog artifact ids");

  if (!Array.isArray(manifest.instances) || manifest.instances.length === 0) throw new Error("composition requires instances");
  const instanceIds = [];
  for (const [index, raw] of manifest.instances.entries()) {
    const label = `instances[${index}]`, instance = object(raw, label);
    exactKeys(instance, ["id", "kind", "catalogArtifactId", "placement", "replacesSemanticIds", "bindings", "constraints"], [], label);
    id(instance.id, `${label}.id`);
    if (!new Set(["furniture", "prop", "fire-runtime"]).has(instance.kind)) throw new Error(`${label}.kind is unsupported`);
    id(instance.catalogArtifactId, `${label}.catalogArtifactId`);
    if (!catalogIds.includes(instance.catalogArtifactId)) throw new Error(`${label} references an absent catalog artifact`);
    const placement = object(instance.placement, `${label}.placement`);
    exactKeys(placement, ["position", "yawRadians", "scale"], [], `${label}.placement`);
    vec3(placement.position, `${label}.placement.position`); finite(placement.yawRadians, `${label}.placement.yawRadians`); vec3(placement.scale, `${label}.placement.scale`);
    if (placement.scale.some((entry) => entry !== 1)) throw new Error(`${label} approved instances cannot be rescaled`);
    if (!Array.isArray(instance.replacesSemanticIds)) throw new Error(`${label}.replacesSemanticIds must be an array`);
    instance.replacesSemanticIds.forEach((entry, entryIndex) => id(entry, `${label}.replacesSemanticIds[${entryIndex}]`));
    unique(instance.replacesSemanticIds, `${label}.replacesSemanticIds`);

    const bindings = object(instance.bindings, `${label}.bindings`);
    exactKeys(bindings, ["roomId", "zoneId", "supportId", "facingTargetId", "occupancySocketIds", "approachSocketIds"], [], `${label}.bindings`);
    for (const key of ["roomId", "zoneId", "supportId", "facingTargetId"]) id(bindings[key], `${label}.bindings.${key}`);
    for (const key of ["occupancySocketIds", "approachSocketIds"]) {
      if (!Array.isArray(bindings[key]) || bindings[key].length === 0) throw new Error(`${label}.bindings.${key} must be non-empty`);
      bindings[key].forEach((entry, entryIndex) => id(entry, `${label}.bindings.${key}[${entryIndex}]`)); unique(bindings[key], `${label}.bindings.${key}`);
    }

    const constraints = object(instance.constraints, `${label}.constraints`);
    exactKeys(constraints, ["floorContact", "containment", "clearances", "facing", "approachCollisionFree"], [], `${label}.constraints`);
    const floor = object(constraints.floorContact, `${label}.constraints.floorContact`);
    exactKeys(floor, ["surfaceId", "targetY", "toleranceM"], [], `${label}.constraints.floorContact`);
    id(floor.surfaceId, `${label}.constraints.floorContact.surfaceId`); finite(floor.targetY, `${label}.constraints.floorContact.targetY`); finite(floor.toleranceM, `${label}.constraints.floorContact.toleranceM`);
    if (floor.toleranceM <= 0 || floor.toleranceM > 0.01) throw new Error(`${label} floor tolerance must be within (0, 0.01]m`);
    const containment = object(constraints.containment, `${label}.constraints.containment`);
    exactKeys(containment, ["roomId"], [], `${label}.constraints.containment`); id(containment.roomId, `${label}.constraints.containment.roomId`);
    if (!Array.isArray(constraints.clearances) || constraints.clearances.length === 0) throw new Error(`${label}.constraints.clearances must be non-empty`);
    const clearanceIds = [];
    for (const [clearanceIndex, rawClearance] of constraints.clearances.entries()) {
      const clearanceLabel = `${label}.constraints.clearances[${clearanceIndex}]`, clearance = object(rawClearance, clearanceLabel);
      exactKeys(clearance, ["id", "againstSemanticId", "minimumM"], [], clearanceLabel);
      id(clearance.id, `${clearanceLabel}.id`); id(clearance.againstSemanticId, `${clearanceLabel}.againstSemanticId`); finite(clearance.minimumM, `${clearanceLabel}.minimumM`);
      if (clearance.minimumM <= 0) throw new Error(`${clearanceLabel}.minimumM must be positive`);
      clearanceIds.push(clearance.id);
    }
    unique(clearanceIds, `${label} clearance ids`);
    const facing = object(constraints.facing, `${label}.constraints.facing`);
    exactKeys(facing, ["socketIds", "targetSemanticId", "minimumDot"], [], `${label}.constraints.facing`);
    if (!Array.isArray(facing.socketIds) || facing.socketIds.length === 0) throw new Error(`${label}.constraints.facing.socketIds must be non-empty`);
    facing.socketIds.forEach((entry, entryIndex) => id(entry, `${label}.constraints.facing.socketIds[${entryIndex}]`)); unique(facing.socketIds, `${label}.constraints.facing.socketIds`);
    id(facing.targetSemanticId, `${label}.constraints.facing.targetSemanticId`); finite(facing.minimumDot, `${label}.constraints.facing.minimumDot`);
    if (facing.minimumDot < -1 || facing.minimumDot > 1) throw new Error(`${label}.constraints.facing.minimumDot must be normalized`);
    if (constraints.approachCollisionFree !== true) throw new Error(`${label}.constraints.approachCollisionFree must be true`);
    instanceIds.push(instance.id);
  }
  unique(instanceIds, "composition instance ids");

  if (!Array.isArray(manifest.legacyExclusions) || manifest.legacyExclusions.length === 0) throw new Error("legacyExclusions must be non-empty");
  manifest.legacyExclusions.forEach((entry, index) => id(entry, `legacyExclusions[${index}]`)); unique(manifest.legacyExclusions, "legacy exclusions");
  if (manifest.metadata !== undefined) object(manifest.metadata, "metadata");
  return Object.freeze(manifest);
}

export function buildingCompositionManifestHash(value) {
  const manifest = validateBuildingCompositionManifest(value);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(manifest))).digest("hex")}`;
}

export function assertBuildingCompositionInputsApproved(value) {
  const manifest = validateBuildingCompositionManifest(value);
  const inputs = [manifest.dependencies.shell.artifact, manifest.dependencies.interiorPlan.artifact, ...manifest.dependencies.catalog.map((entry) => entry.artifact)];
  const unapproved = inputs.filter((entry) => entry.status !== "approved").map((entry) => entry.artifactId).sort();
  if (unapproved.length > 0) throw new Error(`composition candidate requires approved exact inputs: ${unapproved.join(", ")}`);
  return manifest;
}
