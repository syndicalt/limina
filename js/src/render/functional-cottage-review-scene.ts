import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type V3 = readonly [number, number, number];
export interface FunctionalCottageReviewAuthority {
  readonly schema: "limina.functional-building-review-scene/v1";
  readonly asset: { readonly assetId: string; readonly sha256: string; readonly assetHash: string };
  readonly generator: { readonly path: string; readonly sha256: string; readonly blenderVersion: string };
  readonly environmentAuthority: { readonly path: string; readonly sha256: string };
  readonly iterationAuthority: { readonly path: string; readonly sha256: string };
  readonly placement: { readonly position: V3; readonly yaw: number; readonly doorOpen: boolean };
  readonly camera: { readonly id: string; readonly position: V3; readonly target: V3; readonly fovDeg: number; readonly near: number; readonly far: number };
  readonly evidenceViews: readonly ({ readonly id: string; readonly state: "open" | "closed"; readonly role: string; readonly lodLevel: number; readonly distanceM: number; readonly camera: "hero" | { readonly position: V3; readonly target: V3; readonly fovDeg: number } })[];
  readonly presentation: { readonly minimumResolution: readonly [number, number]; readonly fixedTimeSeconds: number; readonly warmupFrames: number };
}

export interface MountedFunctionalCottageReview {
  readonly world: WorldContext;
  readonly root: string;
  readonly door: string;
  readonly parts: readonly string[];
  readonly assetHash: string;
  setRenderVisible(visible: boolean): void;
  setLodLevel(level: number): void;
  setDoorOpen(open: boolean): Promise<void>;
  dispose(): Promise<void>;
}

function requireSuccess(response: Awaited<ReturnType<SkillRegistry["invoke"]>>, skill: string): Record<string, unknown> {
  if (!response.success) throw new Error(`${skill} failed: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}

export function validateFunctionalCottageReviewAuthority(value: unknown): FunctionalCottageReviewAuthority {
  const a = value as Partial<FunctionalCottageReviewAuthority>;
  if (a.schema !== "limina.functional-building-review-scene/v1") throw new Error("unsupported functional cottage review authority");
  if (!a.asset?.assetId || !/^sha256:[0-9a-f]{64}$/.test(a.asset.sha256) || !/^sha256:[0-9a-f]{64}$/.test(a.asset.assetHash)) {
    throw new Error("review authority is missing the raw-byte and engine content identities");
  }
  if (!a.generator?.path || !/^sha256:[0-9a-f]{64}$/.test(a.generator.sha256) || !a.generator.blenderVersion
      || !a.environmentAuthority?.path || !/^sha256:[0-9a-f]{64}$/.test(a.environmentAuthority.sha256)
      || !a.iterationAuthority?.path || !/^sha256:[0-9a-f]{64}$/.test(a.iterationAuthority.sha256)) {
    throw new Error("review authority is missing generator or environment closure");
  }
  const resolution = a.presentation?.minimumResolution;
  if (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every((n) => Number.isSafeInteger(n) && n >= 720)) throw new Error("review authority has an invalid minimum resolution");
  if (!Number.isSafeInteger(a.presentation?.warmupFrames) || a.presentation!.warmupFrames < 1 || a.presentation!.warmupFrames > 120) throw new Error("review authority has an invalid warmup schedule");
  if (!Number.isFinite(a.presentation?.fixedTimeSeconds) || a.presentation!.fixedTimeSeconds < 0) throw new Error("review authority has an invalid fixed time");
  for (const [label, vector] of [["placement", a.placement?.position], ["camera position", a.camera?.position], ["camera target", a.camera?.target]] as const) {
    if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) throw new Error(`review authority has an invalid ${label}`);
  }
  if (!Number.isFinite(a.placement?.yaw) || typeof a.placement?.doorOpen !== "boolean") throw new Error("review authority has an invalid placement state");
  if (!Number.isFinite(a.camera?.fovDeg) || !Number.isFinite(a.camera?.near) || !Number.isFinite(a.camera?.far)) throw new Error("review authority has an invalid camera");
  if (!Array.isArray(a.evidenceViews) || a.evidenceViews.map((view) => view.id).join(",") !== "exterior-closed,exterior-open,threshold-detail,interior-open,hearth-detail,lod-25m"
      || a.evidenceViews.map((view) => view.state).join(",") !== "closed,open,open,open,open,closed"
      || a.evidenceViews.some((view) => !Number.isSafeInteger(view.lodLevel) || view.lodLevel < 0 || !Number.isFinite(view.distanceM) || view.distanceM <= 0)) throw new Error("review authority is missing the canonical functional evidence set");
  return a as FunctionalCottageReviewAuthority;
}

/** Mount the review subject through the authoritative skill path. Direct GLB mounting here would
 * prove only pixels, while this route proves the same semantic contract, entities and colliders used by play. */
export async function mountFunctionalCottageReview(world: WorldContext, authority: FunctionalCottageReviewAuthority, terrainHeight: number): Promise<MountedFunctionalCottageReview> {
  if (!Number.isFinite(terrainHeight)) throw new Error("functional cottage review requires a terrain-sampled foundation height");
  const registry = new SkillRegistry(new LiminaTracer("functional-cottage-native-review"));
  // The production capture host uses the repository as its sandbox root because the shared scene
  // reads both art-direction authority and assets/. Seed the normal assets-relative registry from
  // that exact pinned byte source; placement still runs exclusively through building.placeFunctional.
  const assetBytes = world.ops.op_read_asset(`assets/${authority.asset.assetId}`);
  if (`sha256:${sha256(assetBytes)}` !== authority.asset.sha256 || portableAssetContentHash(assetBytes) !== authority.asset.assetHash) {
    throw new Error("functional cottage review asset bytes do not match the raw and engine content identities");
  }
  const assets = new AssetRegistry(world.ops);
  assets.seed(authority.asset.assetId, assetBytes);
  registerCoreSkills(registry, { assets });
  const base = { agentId: "functional-cottage-review", sessionId: "functional-cottage-review", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  let root: string | undefined;
  try {
    const position: V3 = [authority.placement.position[0], terrainHeight + authority.placement.position[1], authority.placement.position[2]];
    const placed = requireSuccess(await registry.invoke("building.placeFunctional", {
      assetId: authority.asset.assetId, hash: authority.asset.assetHash,
      position, yaw: authority.placement.yaw,
    }, base), "building.placeFunctional");
    root = placed.root as string;
    const doors = placed.doors as string[];
    const parts = placed.parts as string[];
    if (doors.length !== 1 || parts.length < 4) throw new Error("functional cottage review requires one operable door and decomposed shell collision");
    if (authority.placement.doorOpen) requireSuccess(await registry.invoke("door.setOpen", { door: doors[0], open: true }, { ...base, tick: 1 }), "door.setOpen");
    const renderEntries = [root, doors[0]].map((entity) => world.entities.resolve(entity));
    if (renderEntries.some((entry) => entry?.mesh === undefined)) throw new Error("functional cottage review is missing a render root for paired visibility evidence");
    let tick = 2;
    const lodRoots = new Map<number, { visible: boolean }>();
    (renderEntries[0]!.mesh as unknown as { traverse?: (fn: (node: { userData?: { liminaLod?: { level?: unknown } }; visible: boolean }) => void) => void }).traverse?.((node) => {
      const level = node.userData?.liminaLod?.level;
      if (Number.isInteger(level) && (level as number) >= 0 && (level as number) <= 2) lodRoots.set(level as number, node);
    });
    if (lodRoots.size !== 3) throw new Error("functional cottage review asset does not expose all three production LOD roots");
    return Object.freeze({ world, root, door: doors[0], parts: Object.freeze([...parts]), assetHash: placed.hash as string,
      setRenderVisible: (visible: boolean): void => { for (const entry of renderEntries) entry!.mesh!.visible = visible; },
      setLodLevel: (level: number): void => { if (!lodRoots.has(level)) throw new Error(`functional cottage review LOD ${level} is unavailable`); for (const [candidate, node] of lodRoots) node.visible = candidate === level; },
      setDoorOpen: async (open: boolean): Promise<void> => { requireSuccess(await registry.invoke("door.setOpen", { door: doors[0], open }, { ...base, tick: tick++ }), "door.setOpen"); },
      dispose: async (): Promise<void> => {
        const failures: unknown[] = [];
        try { requireSuccess(await registry.invoke("building.destroyFunctional", { root }, { ...base, tick: tick++ }), "building.destroyFunctional"); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "functional cottage review disposal failed");
      } });
  } catch (error) {
    const failures: unknown[] = [error];
    if (root !== undefined) try { await registry.invoke("building.destroyFunctional", { root }, { ...base, tick: 2 }); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "functional cottage review mount rollback failed");
    throw error;
  }
}
