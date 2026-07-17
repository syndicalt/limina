/** Integrated CPU-side mount for the pending functional hall-house R1 package.
 *
 * The final production GLB is the sole visual building/furniture scene. Functional furniture is
 * published semantics-only, while the approved fire remains a separate fuel + procedural facet.
 */

import { AssetRegistry } from "../asset-registry.ts";
import { validateBuildingCompositionManifestV2 } from "../assets/building-composition-manifest-v2.mjs";
import { buildingFireRuntimeV2Hash } from "../assets/building-fire-runtime-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { canonicalStringify } from "../authoring/canonical.ts";
import { computeLocalOffset } from "../ecs/hierarchy.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import { mountBuildingFireProductionFacet, type BuildingFireProductionFacet } from "./building-fire-production-facet.ts";

type V3 = readonly [number, number, number];
type Hash = `sha256:${string}`;
type Ref = Readonly<{ path: string; sha256: Hash }>;

const SCHEMA = "limina.building-production-package/v1";
const PACKAGE_ID = "production/functional-hall-house-v4/r1";
const PRODUCTION_ASSET_ID = "buildings/functional-hall-house-v4-production.glb";
const EXPECTED = Object.freeze({ semantics: 654, colliders: 123, sockets: 12, instances: 7, shellColliders: 37, furnitureColliders: 86 });
const PINNED_FIRE_SOURCES = Object.freeze(new Map([
  ["js/src/render/building-fire-runtime.ts", "sha256:f280744e4f47ffbe3cb52bdb2e80e7cdd5436ad5cc15bed87b37c011310e5266"],
  ["js/src/render/building-fire-render-binding.ts", "sha256:3a8f3ca05f300450d8aaf439a860242b8f8e4b4ae0e02f1d9673974f3fab69ba"],
  ["js/src/render/building-fire-volumetric.ts", "sha256:7c5e14f89630b0820192b6d894f2c871a2cf92f3b77f3b9b1e392ddfd5c617af"],
]));

export interface BuildingProductionPackageTrace {
  readonly schema: "limina.building-production-mount-trace/v1";
  readonly packageId: typeof PACKAGE_ID;
  readonly buildingPlaceFunctionalCalls: 1;
  readonly semanticFurniturePlacements: 7;
  readonly visualFurniturePlacements: 0;
  readonly reviewCompositionMounted: false;
  readonly fireSeparateRuntimeFacet: true;
  readonly timestampQueriesEnabled: false;
}

export interface BuildingProductionPackageMount {
  readonly buildingRoot: string;
  readonly doorEntities: readonly string[];
  readonly furniture: readonly Readonly<{ instanceId: string; root: string; colliders: readonly string[]; sockets: readonly unknown[] }>[];
  readonly fire: BuildingFireProductionFacet;
  readonly inventory: Readonly<{ semantics: 654; colliders: 123; shellColliders: 37; furnitureColliders: 86; sockets: 12; instances: 7 }>;
  readonly trace: Readonly<BuildingProductionPackageTrace>;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

const raw = (bytes: Uint8Array): Hash => `sha256:${sha256(bytes)}`;
const objectHash = (value: unknown): Hash => `sha256:${sha256(canonicalStringify(value))}`;
const decode = (bytes: Uint8Array, label: string): any => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error }); } };
const rotateY = (value: readonly number[], yaw: number): V3 => { const c = Math.cos(yaw), s = Math.sin(yaw); return [value[0] * c + value[2] * s, value[1], -value[0] * s + value[2] * c]; };
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function exactBytes(world: WorldContext, entry: Ref, label: string): Uint8Array {
  if (typeof entry?.path !== "string" || typeof entry?.sha256 !== "string") throw new Error(`${label} reference is invalid`);
  const bytes = world.ops.op_read_asset(entry.path);
  if (raw(bytes) !== entry.sha256) throw new Error(`${label} exact bytes drifted`);
  return bytes;
}

function verifyPendingPackage(packageValue: unknown, candidateValue: unknown): any {
  const value = packageValue as any;
  if (value?.schema !== SCHEMA || value.packageId !== PACKAGE_ID || value.revision !== 1 || value.status !== "draft"
    || value.humanDecision !== "pending" || value.visualApprovalClaimed !== false) throw new Error("production package is not the exact pending R1 identity");
  const policy = value.buildPolicy;
  if (policy?.cpuOnly !== true || policy.rendered !== false || policy.gpuUsed !== false || policy.timestampQueriesEnabled !== false || policy.appendOnly !== true) throw new Error("production package violates CPU-only/timestamp-disabled policy");
  if (value.runtimeFacets?.fire?.mount !== "separate-runtime-facet" || value.runtimeFacets.fire.bakedIntoProductionGlb !== false) throw new Error("production package must keep fire as a separate runtime facet");
  if (JSON.stringify(value.closure?.counts) !== JSON.stringify({ semantics: 654, colliders: 123, sockets: 12, instances: 7 })) throw new Error("production package semantic counts drifted");
  const candidate = validateBuildingStageArtifact(candidateValue);
  if (candidate.artifactId !== PACKAGE_ID || candidate.kind !== "production-package" || candidate.revision !== 1 || candidate.status !== "candidate"
    || candidate.contractHash !== objectHash(value) || candidate.contentHash !== value.runtime?.productionGlb?.sha256
    || candidate.metadata?.humanDecision !== "pending" || candidate.metadata?.visualApprovalClaimed !== false
    || candidate.metadata?.timestampQueriesEnabled !== false) throw new Error("production package candidate does not bind the pending manifest");
  return value;
}

/** Mount exact pending package state through production engine skills. No renderer or GPU work occurs here. */
export async function mountBuildingProductionPackage(world: WorldContext, packageValue: unknown, candidateValue: unknown,
  transform: Readonly<{ position?: V3; yaw?: number }> = {}): Promise<BuildingProductionPackageMount> {
  const manifest = verifyPendingPackage(packageValue, candidateValue), position = transform.position ?? [0, 0, 0], yaw = transform.yaw ?? 0;
  if (!position.every(Number.isFinite) || !Number.isFinite(yaw)) throw new TypeError("production building transform must be finite");
  const productionBytes = exactBytes(world, manifest.runtime.productionGlb, "production GLB");
  if (productionBytes.length !== manifest.runtime.productionGlb.bytes || portableAssetContentHash(productionBytes) !== manifest.runtime.productionGlb.engineHash) throw new Error("production GLB engine identity drifted");
  const compositionBytes = exactBytes(world, manifest.composition.manifest, "C1 manifest");
  const composition = validateBuildingCompositionManifestV2(decode(compositionBytes, "C1 manifest"));
  if (composition.id !== manifest.composition.id || composition.instances.length !== EXPECTED.instances) throw new Error("production package C1 composition drifted");
  const compositionArtifact = validateBuildingStageArtifact(decode(exactBytes(world, manifest.composition.approvedArtifact, "C1 approved artifact"), "C1 artifact"));
  const compositionDecision = validateBuildingHitlDecision(decode(exactBytes(world, manifest.composition.approvalDecision, "C1 approval decision"), "C1 decision"));
  if (compositionArtifact.artifactId !== composition.id || compositionArtifact.kind !== "composition" || compositionArtifact.status !== "approved"
    || compositionDecision.decision !== "approve" || compositionDecision.artifactId !== compositionArtifact.artifactId
    || compositionDecision.contractHash !== compositionArtifact.contractHash || compositionDecision.contentHash !== compositionArtifact.contentHash) throw new Error("production C1 approval closure drifted");

  const fireFacet = manifest.runtimeFacets.fire, fireArtifact = validateBuildingStageArtifact(decode(exactBytes(world, fireFacet.approvedArtifact, "fire approved artifact"), "fire artifact"));
  const fireDecision = validateBuildingHitlDecision(decode(exactBytes(world, fireFacet.approvalDecision, "fire approval decision"), "fire decision"));
  if (fireArtifact.status !== "approved" || fireArtifact.kind !== "fire-runtime" || fireDecision.decision !== "approve"
    || fireDecision.artifactId !== fireArtifact.artifactId || fireDecision.contractHash !== fireArtifact.contractHash || fireDecision.contentHash !== fireArtifact.contentHash) throw new Error("production fire approval closure drifted");
  const contractBytes = exactBytes(world, fireFacet.contract, "fire contract"), contractValue = decode(contractBytes, "fire contract");
  if (buildingFireRuntimeV2Hash(contractValue) !== fireArtifact.contractHash) throw new Error("production fire contract does not match approved artifact");
  const fuelBytes = exactBytes(world, fireFacet.fuel.runtimeGlb, "fire fuel");
  const sourcePaths = new Set<string>();
  for (const source of fireFacet.proceduralSources as Ref[]) {
    if (sourcePaths.has(source.path)) throw new Error(`duplicate production fire source: ${source.path}`); sourcePaths.add(source.path);
    const expected = PINNED_FIRE_SOURCES.get(source.path);
    if (expected === undefined || expected !== source.sha256) throw new Error(`production fire source is not pinned: ${source.path}`);
    exactBytes(world, source, `pinned fire source ${source.path}`);
  }
  if (sourcePaths.size !== PINNED_FIRE_SOURCES.size || [...PINNED_FIRE_SOURCES.keys()].some((path) => !sourcePaths.has(path))) throw new Error("production fire source closure is incomplete");

  const assets = new AssetRegistry(world.ops); assets.seed(PRODUCTION_ASSET_ID, productionBytes);
  const catalog = new Map<string, any>();
  for (const entry of composition.dependencies.catalog) {
    const bytes = exactBytes(world, entry.runtimeGlb, `C1 catalog runtime ${entry.artifact.artifactId}`);
    const artifact = validateBuildingStageArtifact(decode(exactBytes(world, { path: entry.artifact.artifactPath, sha256: entry.artifact.artifactSha256 },
      `C1 catalog artifact ${entry.artifact.artifactId}`), "C1 catalog artifact"));
    const decision = validateBuildingHitlDecision(decode(exactBytes(world, entry.approvalDecision,
      `C1 catalog approval ${entry.artifact.artifactId}`), "C1 catalog approval"));
    const functional = decode(exactBytes(world, entry.functionalEvidence, `C1 functional evidence ${entry.artifact.artifactId}`), "C1 functional evidence");
    const contractHash = functional.inputs?.furnitureContractHash;
    if (artifact.artifactId !== entry.artifact.artifactId || artifact.kind !== "furniture-pack" || artifact.status !== "approved"
      || artifact.contractHash !== entry.artifact.contractHash || artifact.contentHash !== entry.artifact.contentHash
      || decision.decision !== "approve" || decision.artifactId !== artifact.artifactId || decision.contractHash !== artifact.contractHash
      || decision.contentHash !== artifact.contentHash || artifact.metadata?.approval?.decisionId !== decision.decisionId
      || artifact.metadata?.approval?.sha256 !== entry.approvalDecision.sha256) throw new Error(`C1 catalog approval closure drifted for ${entry.artifact.artifactId}`);
    if (functional.schema !== "limina.furniture-functional-evidence/v1" || functional.verdict !== "pass" || functional.summary?.failed !== 0
      || !Array.isArray(functional.checks) || functional.checks.length !== functional.summary?.passed || functional.checks.some((check: any) => check.passed !== true || check.findings?.length !== 0)
      || contractHash !== artifact.contractHash || functional.inputs?.runtimeGlbSha256 !== artifact.contentHash
      || entry.runtimeGlb.sha256 !== artifact.contentHash) throw new Error(`C1 functional evidence is not linked to approved catalog artifact ${entry.artifact.artifactId}`);
    const assetId = entry.runtimeGlb.path.replace(/^assets\//, ""); assets.seed(assetId, bytes); catalog.set(entry.artifact.artifactId, { entry, assetId, contractHash });
  }
  // productionMountSource is intentionally verified by the append-only package builder. Runtime
  // cannot safely require a hash of the source file currently executing without a self-reference.
  const registry = new SkillRegistry(new LiminaTracer("building-production-package")); registerCoreSkills(registry, { assets });
  const base = { agentId: "building-production-package", sessionId: "building-production-package", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  let tick = 1, buildingRoot: string | undefined, fire: BuildingFireProductionFacet | undefined, disposed = false;
  const furniture: { instanceId: string; root: string; colliders: string[]; sockets: unknown[] }[] = [];
  const invoke = async (name: string, input: unknown): Promise<any> => { const response = await registry.invoke(name, input, { ...base, tick: tick++ }); if (!response.success) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`); return response.result; };
  try {
    const placedBuilding = await invoke("building.placeFunctional", { assetId: PRODUCTION_ASSET_ID, hash: assets.hashOf(PRODUCTION_ASSET_ID), position, yaw });
    if (typeof placedBuilding.root !== "string") throw new Error("production shell placement returned no root identity");
    const activeBuildingRoot = placedBuilding.root; buildingRoot = activeBuildingRoot;
    if (placedBuilding.parts.length !== EXPECTED.shellColliders || placedBuilding.doors.length !== 1) throw new Error("production shell functional inventory drifted");
    for (const instance of composition.instances) {
      const resolved = catalog.get(instance.catalogArtifactId); if (resolved === undefined) throw new Error(`C1 instance ${instance.id} lacks catalog runtime`);
      const instancePosition = add(position, rotateY(instance.placement.position, yaw)), instanceYaw = yaw + instance.placement.yawRadians;
      const placed = await invoke("furniture.placeFunctional", { assetId: resolved.assetId, hash: assets.hashOf(resolved.assetId), contractHash: resolved.contractHash,
        position: instancePosition, yaw: instanceYaw, visual: false });
      const entry = world.entities.resolve(placed.root); if (entry === undefined) throw new Error(`semantic furniture root ${instance.id} was not published`);
      world.entities.setParent(placed.root, activeBuildingRoot, computeLocalOffset(world, activeBuildingRoot, entry.eid));
      furniture.push({ instanceId: instance.id, root: placed.root, colliders: placed.colliders, sockets: placed.sockets });
    }
    const furnitureColliders = furniture.reduce((sum, entry) => sum + entry.colliders.length, 0), sockets = furniture.reduce((sum, entry) => sum + entry.sockets.length, 0);
    if (furniture.length !== EXPECTED.instances || furnitureColliders !== EXPECTED.furnitureColliders || sockets !== EXPECTED.sockets) throw new Error("production semantic furniture inventory drifted");
    fire = await mountBuildingFireProductionFacet(world, { contractBytes, contractSha256: fireFacet.contract.sha256, contractHash: fireArtifact.contractHash,
      fuelBytes, fuelSha256: fireFacet.fuel.runtimeGlb.sha256, position, yaw, parentEntity: activeBuildingRoot });
    const mountedRoot = activeBuildingRoot, mountedFire = fire;
    let fireDisposed = false, buildingDisposed = false;
    const remainingFurniture = new Set([...furniture].reverse().map((entry) => entry.root));
    const inventory = Object.freeze({ semantics: 654 as const, colliders: 123 as const, shellColliders: 37 as const, furnitureColliders: 86 as const, sockets: 12 as const, instances: 7 as const });
    const trace = Object.freeze({ schema: "limina.building-production-mount-trace/v1" as const, packageId: PACKAGE_ID,
      buildingPlaceFunctionalCalls: 1 as const, semanticFurniturePlacements: 7 as const, visualFurniturePlacements: 0 as const,
      reviewCompositionMounted: false as const, fireSeparateRuntimeFacet: true as const, timestampQueriesEnabled: false as const });
    return Object.freeze({ buildingRoot: mountedRoot, doorEntities: Object.freeze([...placedBuilding.doors]),
      furniture: Object.freeze(furniture.map((entry) => Object.freeze({ ...entry, colliders: Object.freeze([...entry.colliders]), sockets: Object.freeze([...entry.sockets]) }))),
      fire: mountedFire, inventory, trace, get disposed() { return disposed; }, dispose: async () => {
        if (disposed) return; const failures: unknown[] = [];
        if (!fireDisposed) try { await mountedFire.dispose(); fireDisposed = true; } catch (error) { failures.push(error); }
        if (fireDisposed) for (const root of [...remainingFurniture]) try { await invoke("furniture.destroyFunctional", { root }); remainingFurniture.delete(root); } catch (error) { failures.push(error); }
        if (fireDisposed && remainingFurniture.size === 0 && !buildingDisposed) try { await invoke("building.destroyFunctional", { root: mountedRoot }); buildingDisposed = true; } catch (error) { failures.push(error); }
        disposed = fireDisposed && remainingFurniture.size === 0 && buildingDisposed;
        if (failures.length) throw new AggregateError(failures, "production package disposal failed");
        if (!disposed) throw new Error("production package disposal did not complete");
      } });
  } catch (error) {
    const failures: unknown[] = [error];
    if (fire !== undefined) try { await fire.dispose(); } catch (failure) { failures.push(failure); }
    for (const entry of [...furniture].reverse()) try { await invoke("furniture.destroyFunctional", { root: entry.root }); } catch (failure) { failures.push(failure); }
    if (buildingRoot !== undefined) try { await invoke("building.destroyFunctional", { root: buildingRoot }); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "production package mount failed and rollback reported errors");
    throw error;
  }
}
