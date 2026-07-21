import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type V3 = readonly [number, number, number];
type Hash = `sha256:${string}`;
export interface StagedShellReviewAuthority {
  readonly schema: "limina.staged-shell-review-scene/v1";
  readonly artifact: {
    readonly path: string;
    readonly sha256: Hash;
    readonly contentHash: Hash;
    readonly artifactId: string;
    readonly contractHash: Hash;
    readonly assetContentHash: Hash;
  };
  readonly asset: { readonly assetId: string; readonly sha256: Hash; readonly assetHash: Hash };
  readonly buildEvidence: { readonly path: string; readonly sha256: Hash };
  readonly source: {
    readonly blendPath: string;
    readonly blendSha256: Hash;
    readonly buildToolPath: string;
    readonly buildToolSha256: Hash;
    readonly adapterPath: string;
    readonly adapterSha256: Hash;
    readonly blenderVersion: string;
  };
  readonly environment: {
    readonly authorityPath: string;
    readonly authoritySha256: Hash;
    readonly bundlePath: string;
    readonly bundleSha256: Hash;
  };
  readonly functional: {
    readonly buildingId: string;
    readonly doors: number;
    readonly colliders: number;
    readonly rooms: number;
    readonly portals: number;
  };
  readonly exclusions: {
    readonly furniture: true;
    readonly domesticProps: true;
    readonly fireVisuals: true;
    readonly practicalLights: true;
  };
  readonly placement: { readonly position: V3; readonly yaw: number };
  readonly evidenceViews: readonly {
    readonly id: string;
    readonly state: "open" | "closed";
    readonly role: string;
    readonly renderLevel: "source-lod0";
    readonly distanceM: number;
    readonly camera: {
      readonly position: V3;
      readonly target: V3;
      readonly fovDeg: number;
      readonly near: number;
      readonly far: number;
    };
  }[];
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: number;
    readonly warmupFrames: number;
  };
}
const HASH = /^sha256:[0-9a-f]{64}$/,
  IDS =
    "exterior-closed,exterior-open,roof-chimney-bumpout-junction,dormer-eave,threshold-stair-grade,empty-interior-traversal,hearth-structure,lod-25m",
  STATES = "closed,open,closed,closed,open,open,open,closed";
const finiteV3 = (value: unknown): value is V3 =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
export function validateStagedShellReviewAuthority(value: unknown): StagedShellReviewAuthority {
  const a = value as Partial<StagedShellReviewAuthority>;
  if (a.schema !== "limina.staged-shell-review-scene/v1") throw new Error("unsupported staged shell review authority");
  for (const [label, record] of [
    ["asset", a.asset],
    ["artifact", a.artifact],
    ["build evidence", a.buildEvidence],
  ] as const)
    if (
      !record ||
      Object.values(record).some(
        (entry) => typeof entry === "string" && entry.startsWith("sha256:") && !HASH.test(entry),
      )
    )
      throw new Error(`staged shell authority has invalid ${label} hashes`);
  if (
    !a.artifact?.path ||
    !a.artifact.artifactId ||
    !HASH.test(a.artifact.contractHash) ||
    a.artifact.assetContentHash !== a.asset?.sha256 ||
    !a.asset?.assetId ||
    !HASH.test(a.asset.assetHash)
  )
    throw new Error("staged shell authority is missing exact artifact/asset closure");
  if (
    !a.source?.blendPath ||
    ![a.source.blendSha256, a.source.buildToolSha256, a.source.adapterSha256].every((entry) => HASH.test(entry)) ||
    a.source.blenderVersion !== "4.0.2"
  )
    throw new Error("staged shell authority is missing exact Blender source closure");
  if (
    !a.environment?.authorityPath ||
    !a.environment.bundlePath ||
    ![a.environment.authoritySha256, a.environment.bundleSha256].every((entry) => HASH.test(entry))
  )
    throw new Error("staged shell authority is missing temperate environment closure");
  if (
    a.functional?.doors !== 1 ||
    ![a.functional.colliders, a.functional.rooms, a.functional.portals].every(
      (entry) => Number.isSafeInteger(entry) && entry > 0,
    ) ||
    !a.functional.buildingId
  )
    throw new Error("staged shell authority requires one door and positive functional inventory counts");
  if (!a.exclusions || Object.values(a.exclusions).some((entry) => entry !== true))
    throw new Error("staged shell authority exclusions must remain absolute");
  if (!finiteV3(a.placement?.position) || !Number.isFinite(a.placement?.yaw))
    throw new Error("staged shell authority has invalid placement");
  if (
    !Array.isArray(a.evidenceViews) ||
    a.evidenceViews.map((entry) => entry.id).join(",") !== IDS ||
    a.evidenceViews.map((entry) => entry.state).join(",") !== STATES
  )
    throw new Error("staged shell authority lacks the canonical A1 view set");
  for (const view of a.evidenceViews) {
    if (
      view.renderLevel !== "source-lod0" ||
      !view.role ||
      !finiteV3(view.camera?.position) ||
      !finiteV3(view.camera?.target) ||
      ![view.camera?.fovDeg, view.camera?.near, view.camera?.far, view.distanceM].every(Number.isFinite) ||
      view.camera.near <= 0 ||
      view.camera.far <= view.camera.near ||
      view.distanceM <= 0
    )
      throw new Error(`staged shell view ${view.id} is invalid`);
    const position: V3 = view.camera.position,
      target: V3 = view.camera.target,
      actual = Math.hypot(...position.map((entry: number, index: number) => entry - target[index]));
    if (Math.abs(actual - view.distanceM) > 0.01) throw new Error(`staged shell view ${view.id} distance drifted`);
  }
  if (
    !Array.isArray(a.presentation?.minimumResolution) ||
    a.presentation.minimumResolution.length !== 2 ||
    !a.presentation.minimumResolution.every((entry) => Number.isSafeInteger(entry) && entry >= 720) ||
    !Number.isSafeInteger(a.presentation.warmupFrames) ||
    a.presentation.warmupFrames < 1 ||
    a.presentation.warmupFrames > 120 ||
    !Number.isFinite(a.presentation.fixedTimeSeconds) ||
    a.presentation.fixedTimeSeconds < 0
  )
    throw new Error("staged shell authority has invalid presentation policy");
  return a as StagedShellReviewAuthority;
}

export function inspectStagedShellExclusions(
  bytes: Uint8Array,
): Readonly<{ nodes: number; meshes: number; lights: 0 }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error("staged shell asset is not canonical GLB2");
  const json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + view.getUint32(12, true))).trim(),
    ),
    nodes = Array.isArray(json.nodes) ? json.nodes : [],
    forbidden = /^(?:furnishing|domestic-prop)\/|\/(?:flame|fuel|ember)(?:\/|$)/;
  for (const node of nodes) {
    const semantic = node.extras?.limina?.id ?? node.extras?.["limina.id"] ?? node.name;
    if (typeof semantic === "string" && forbidden.test(semantic))
      throw new Error(`staged shell contains excluded visual ${semantic}`);
  }
  if (json.extensions?.KHR_lights_punctual?.lights?.length || json.extensionsUsed?.includes("KHR_lights_punctual"))
    throw new Error("staged shell contains excluded practical lights");
  return Object.freeze({
    nodes: nodes.length,
    meshes: Array.isArray(json.meshes) ? json.meshes.length : 0,
    lights: 0 as const,
  });
}

function success(response: Awaited<ReturnType<SkillRegistry["invoke"]>>, skill: string): Record<string, unknown> {
  if (!response.success) throw new Error(`${skill} failed: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}
export async function mountStagedShellReview(
  world: WorldContext,
  authority: StagedShellReviewAuthority,
  rootWorldY: number,
) {
  if (!Number.isFinite(rootWorldY)) throw new Error("staged shell review requires a terrain foundation height");
  const bytes = world.ops.op_read_asset(`assets/${authority.asset.assetId}`);
  if (
    `sha256:${sha256(bytes)}` !== authority.asset.sha256 ||
    portableAssetContentHash(bytes) !== authority.asset.assetHash
  )
    throw new Error("staged shell bytes do not match authority");
  inspectStagedShellExclusions(bytes);
  const assets = new AssetRegistry(world.ops);
  assets.seed(authority.asset.assetId, bytes);
  const registry = new SkillRegistry(new LiminaTracer("staged-shell-a1-review"));
  registerCoreSkills(registry, { assets });
  const base = {
    agentId: "staged-shell-a1-review",
    sessionId: "staged-shell-a1-review",
    permissions: resolveProfile("builder.readWrite"),
    tick: 0,
    world,
  };
  let root: string | undefined,
    tick = 1;
  try {
    const placed = success(
        await registry.invoke(
          "building.placeFunctional",
          {
            assetId: authority.asset.assetId,
            hash: authority.asset.assetHash,
            position: [authority.placement.position[0], rootWorldY, authority.placement.position[2]],
            yaw: authority.placement.yaw,
          },
          base,
        ),
        "building.placeFunctional",
      ),
      doors = placed.doors as string[],
      parts = placed.parts as string[];
    root = placed.root as string;
    if (
      placed.hash !== authority.asset.assetHash ||
      doors.length !== authority.functional.doors ||
      parts.length !== authority.functional.colliders
    )
      throw new Error(
        `staged shell functional inventory drifted: doors=${doors.length}/${authority.functional.doors}, colliders=${parts.length}/${authority.functional.colliders}`,
      );
    const renderEntries = [root, doors[0]].map((entity) => world.entities.resolve(entity));
    if (renderEntries.some((entry) => entry?.mesh === undefined))
      throw new Error("staged shell functional mount lacks render roots");
    return Object.freeze({
      root,
      door: doors[0],
      parts: Object.freeze([...parts]),
      assetHash: placed.hash as string,
      setRenderVisible: (visible: boolean) => {
        for (const entry of renderEntries) entry!.mesh!.visible = visible;
      },
      setDoorOpen: async (open: boolean) => {
        success(
          await registry.invoke("door.setOpen", { door: doors[0], open }, { ...base, tick: tick++ }),
          "door.setOpen",
        );
      },
      dispose: async () => {
        if (root !== undefined) {
          success(
            await registry.invoke("building.destroyFunctional", { root }, { ...base, tick: tick++ }),
            "building.destroyFunctional",
          );
          root = undefined;
        }
      },
    });
  } catch (error) {
    const failures = [error];
    if (root !== undefined)
      try {
        await registry.invoke("building.destroyFunctional", { root }, { ...base, tick: tick++ });
      } catch (cleanup) {
        failures.push(cleanup);
      }
    if (failures.length > 1) throw new AggregateError(failures, "staged shell mount rollback failed");
    throw error;
  }
}
