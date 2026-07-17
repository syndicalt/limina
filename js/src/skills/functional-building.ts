import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract, type FunctionalBuildingContractV2, type FunctionalBuildingDoor, type V3 } from "../assets/functional-building-contract.ts";
import { MAX_ENTITIES, Position, Rotation, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { EntityOrigin, SceneObject } from "../engine.ts";
import { computeLocalOffset } from "../ecs/hierarchy.ts";
import type { ExecutionContext, SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { FunctionalBuildingLodController, parseFunctionalBuildingStaticBatch, resolveFunctionalBuildingLodRoots } from "./functional-building-lod.ts";
import { loadGltfIntoScene } from "./three.ts";
import type { InteractionManager } from "./interaction.ts";
import type { InventoryManager } from "./inventory.ts";
import type { NavmeshManager } from "./navmesh.ts";
import type { FunctionalBuildingTopologyManager } from "./functional-building-topology.ts";

interface DoorRuntimeState {
  assetId: string;
  hash: string;
  position: V3;
  buildingYaw: number;
  door: FunctionalBuildingDoor;
  colliderEntity: string;
  open: boolean;
  locked: boolean;
  keyId?: string;
  portalRuntimeId: string;
  buildingRoot?: string;
}
export interface DoorAudio { playAt(freq:number,secs:number,pos:readonly [number,number,number],bus:"sfx",volume:number,maxDistance?:number,entityId?:string): string; }

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const inert = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

function rotateY(value: readonly number[], yaw: number): V3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [value[0] * c + value[2] * s, value[1], -value[0] * s + value[2] * c];
}
function add(a: readonly number[], b: readonly number[]): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function quatYaw(yaw: number): [number, number, number, number] { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }

function spawnBodyEntity(world: WorldContext, position: V3, half: V3, yaw: number, origin: EntityOrigin, mesh?: SceneObject): string {
  if (mesh !== undefined) world.scene.add(mesh);
  const eid = spawnRenderable(world.ecs, (mesh ?? inert()) as never, ...position);
  if (eid >= MAX_ENTITIES) {
    despawnRenderable(world.ecs, eid);
    if (mesh !== undefined) world.scene.remove(mesh);
    throw new Error("functional building: entity capacity exceeded");
  }
  const q = quatYaw(yaw);
  Rotation.x[eid] = q[0]; Rotation.y[eid] = q[1]; Rotation.z[eid] = q[2]; Rotation.w[eid] = q[3];
  const bodyId = world.ops.op_physics_add_static_box(position[0], position[1], position[2], half[0], half[1], half[2], 0.85, 0);
  world.ops.op_physics_set_body_transform(bodyId, ...position, ...q);
  const entity = world.entities.create({ eid, bodyId, origin, ...(mesh === undefined ? {} : { mesh }) });
  world.tags.set(eid, new Set(["functional-building-part"]));
  return entity;
}

function spawnVisualEntity(world: WorldContext, position: V3, yaw: number, origin: EntityOrigin, mesh?: SceneObject): string {
  if (mesh !== undefined) world.scene.add(mesh);
  const eid = spawnRenderable(world.ecs, (mesh ?? inert()) as never, ...position);
  if (eid >= MAX_ENTITIES) {
    despawnRenderable(world.ecs, eid);
    if (mesh !== undefined) world.scene.remove(mesh);
    throw new Error("functional building: entity capacity exceeded");
  }
  const q = quatYaw(yaw);
  Rotation.x[eid] = q[0]; Rotation.y[eid] = q[1]; Rotation.z[eid] = q[2]; Rotation.w[eid] = q[3];
  const entity = world.entities.create({ eid, origin, ...(mesh === undefined ? {} : { mesh }) });
  world.tags.set(eid, new Set(["functional-building-part"]));
  return entity;
}

function doorPose(door: FunctionalBuildingDoor, position: V3, buildingYaw: number, open: boolean): { hinge: V3; center: V3; yaw: number } {
  const angle = open ? door.openYaw : door.closedYaw;
  const localCenter = add(door.hinge, rotateY(door.center, angle));
  return { hinge: add(position, rotateY(door.hinge, buildingYaw)), center: add(position, rotateY(localCenter, buildingYaw)), yaw: buildingYaw + angle };
}

function doorOrigin(state: DoorRuntimeState): EntityOrigin {
  return { tool: "building.functionalDoor", input: state as unknown as Record<string,unknown> };
}

export function registerFunctionalBuildingSkills(registry: SkillRegistry, assets: AssetRegistry, deps?: {
  interaction?: InteractionManager; inventory?: InventoryManager; audio?: DoorAudio; nav?: NavmeshManager;
  topology?: FunctionalBuildingTopologyManager;
}): void {
  let dispatchDoor: (door: string, actorEntity: string, ctx: ExecutionContext) => { door: string; open: boolean; ok: boolean; reason?: string };
  const reconciledVersions = new WeakMap<WorldContext, number>();
  const prompt = (state: DoorRuntimeState) => state.locked ? "Locked" : state.open ? "Close door" : "Open door";
  const portalBounds = (state: DoorRuntimeState) => {
    const pose = doorPose(state.door, state.position, state.buildingYaw, false);
    const c = Math.abs(Math.cos(pose.yaw)), s = Math.abs(Math.sin(pose.yaw));
    const hx = c * state.door.halfExtents[0] + s * state.door.halfExtents[2];
    const hz = s * state.door.halfExtents[0] + c * state.door.halfExtents[2];
    return { minX: pose.center[0] - hx, minZ: pose.center[2] - hz, maxX: pose.center[0] + hx, maxZ: pose.center[2] + hz };
  };
  const derive = (_world: WorldContext, entity: string, state: DoorRuntimeState) => {
    deps?.interaction?.register({ entity, prompt: prompt(state), maxRange: 3, type: "toggle", action: "door.interact", state: {} });
    deps?.interaction?.registerHandler(entity, (actor, ctx) => dispatchDoor(entity, actor, ctx));
    const layered = state.buildingRoot !== undefined && deps?.topology?.hasBuilding(state.buildingRoot);
    if (layered) deps?.topology?.setPortalOpen(state.buildingRoot!, state.door.portalId, state.open);
    else {
      const nav = deps?.nav;
      if (nav?.isPortalOpen(state.portalRuntimeId) === undefined) nav?.registerPortal(state.portalRuntimeId, portalBounds(state), state.open);
      else nav.setPortalOpen(state.portalRuntimeId, state.open);
    }
  };
  const reconcile = (world: WorldContext) => {
    if (reconciledVersions.get(world) === world.entities.version) return;
    for (const id of world.entities.ids()) {
      const entry = world.entities.resolve(id);
      if (entry?.origin?.tool !== "building.placeFunctional" || deps?.topology?.hasBuilding(id)) continue;
      const input = entry.origin.input as { functionalSchema?: unknown; topologyContract?: unknown; position?: unknown; yaw?: unknown };
      if (input.functionalSchema !== FUNCTIONAL_BUILDING_CONTRACT_V2 || !Array.isArray(input.position) || input.position.length !== 3
        || typeof input.yaw !== "number" || (input.topologyContract as { schema?: unknown } | undefined)?.schema !== FUNCTIONAL_BUILDING_CONTRACT_V2) continue;
      deps?.topology?.registerBuilding(id, input.topologyContract as FunctionalBuildingContractV2, { position: input.position as V3, yaw: input.yaw });
    }
    for (const id of world.entities.ids()) {
      const entry = world.entities.resolve(id);
      if (entry?.origin?.tool === "building.functionalDoor") derive(world, id, entry.origin.input as unknown as DoorRuntimeState);
    }
    reconciledVersions.set(world, world.entities.version);
  };
  registry.registerWorldReconciler(reconcile);
  const placeInput = z.object({ assetId: z.string(), position: Vec3.default([0, 0, 0]), yaw: z.number().default(0), hash: z.string().optional(),
    locks: z.record(z.string(),z.string()).default({}),
    lodDistances: z.tuple([z.number().positive(), z.number().positive()]).default([28, 72]), lodHysteresis: z.number().min(0).max(0.49).default(0.1) });
  const place: SkillDefinition<z.infer<typeof placeInput>, { root: string; doors: string[]; parts: string[]; hash: string }> = {
    name: "building.placeFunctional", version: "1.1.0",
    description: "Place a contract-bearing enterable building with decomposed collision, operable doors, and packaged whole-primitive camera LOD. Rejects decorative or whole-AABB assets.",
    category: "scene", permissions: ["scene.write"], commitFields: ["hash"], input: placeInput,
    output: z.object({ root: z.string(), doors: z.array(z.string()), parts: z.array(z.string()), hash: z.string() }),
    handler: async (input, ctx) => {
      if (input.lodDistances[1] <= input.lodDistances[0]) throw new Error("functional building LOD: distances must be strictly increasing");
      const resolved = assets.resolve(input.assetId);
      if (input.hash !== undefined && input.hash !== resolved.hash) throw new Error(`functional building: pinned hash mismatch for ${input.assetId}`);
      const contract = parseFunctionalBuildingContract(resolved.bytes); // validate every byte before mutation
      const staticBatch = parseFunctionalBuildingStaticBatch(resolved.bytes);
      const created: string[] = [];
      try {
        const loaded = await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, { position: input.position, rotationEuler: [0, input.yaw, 0] });
        const root = loaded.entity;
        created.push(root);
        ctx.world.entities.bindOrigin(root, { tool: "building.placeFunctional", input: { ...input, hash: resolved.hash,
          functionalSchema: contract.schema, ...(contract.schema === FUNCTIONAL_BUILDING_CONTRACT_V2 ? { topologyContract: contract } : {}) } });
        if (contract.schema === FUNCTIONAL_BUILDING_CONTRACT_V2 && !deps?.topology?.registerBuilding(root, contract, { position: input.position, yaw: input.yaw }))
          throw new Error("functional building: multi-room topology registration failed");
        const rootEntry = ctx.world.entities.resolve(root);
        const authoredDoorNodes = new Map<string, SceneObject>();
        if (rootEntry !== undefined) {
          const tags = ctx.world.tags.get(rootEntry.eid) ?? new Set<string>(); tags.add("functional-building-root"); ctx.world.tags.set(rootEntry.eid, tags);
          // The authored leaf proves pivot/clip structure. Runtime owns a separate leaf entity so its
          // transform and collider have one authoritative lifecycle in render, worker, replay, and snapshot.
          const doorNodeIds = new Set(contract.doors.map((door) => door.nodeId));
          (rootEntry.mesh as unknown as { traverse?: (fn: (node: { name?: string; userData?: { limina?: { id?: string } } }) => void) => void } | undefined)?.traverse?.((node) => {
            // GLTFLoader sanitizes Object3D.name (`door/front` -> `doorfront`) but preserves the
            // exported extras verbatim. Semantic extras are authoritative; name is compatibility only.
            const semanticId = node.userData?.limina?.id ?? node.name;
            if (semanticId !== undefined && doorNodeIds.has(semanticId)) authoredDoorNodes.set(semanticId, node as unknown as SceneObject);
          });
        }
        if (ctx.world.simWorker !== true && authoredDoorNodes.size !== contract.doors.length) {
          throw new Error("functional building: rendered GLB is missing an authored semantic door subtree");
        }
        if (rootEntry?.mesh !== undefined) {
          const doorNodeIds = new Set(contract.doors.map((door) => door.nodeId));
          const lodRoots = resolveFunctionalBuildingLodRoots(rootEntry.mesh as unknown as Parameters<typeof resolveFunctionalBuildingLodRoots>[0], doorNodeIds);
          if (staticBatch !== undefined || lodRoots.length > 0) {
            if (staticBatch === undefined || lodRoots.length !== staticBatch.lodRoots.length) throw new Error(`functional building LOD: manifest/root mismatch (${staticBatch?.lodRoots.length ?? 0}/${lodRoots.length})`);
            const controller = new FunctionalBuildingLodController(lodRoots, { anchor: input.position, distances: input.lodDistances, hysteresis: input.lodHysteresis });
            const lods = (ctx.world.lods ??= []);
            lods.push(controller);
            const priorDispose = rootEntry.runtimeDispose;
            rootEntry.runtimeDispose = () => {
              const index = lods.indexOf(controller);
              if (index >= 0) lods.splice(index, 1);
              priorDispose?.();
            };
          }
        }
        const parts: string[] = [];
        for (const collider of contract.colliders) {
          const center = add(input.position, rotateY(collider.center, input.yaw));
          const entity = spawnBodyEntity(ctx.world, center, collider.halfExtents, input.yaw,
            { tool: "building.functionalCollider", input: { assetId: input.assetId, hash: resolved.hash, semanticId: collider.id } });
          created.push(entity); parts.push(entity);
          const eid = ctx.world.entities.resolve(entity)!.eid;
          ctx.world.entities.setParent(entity, root, computeLocalOffset(ctx.world, root, eid));
        }
        const doors: string[] = [];
        for (const door of contract.doors) {
          const pose = doorPose(door, input.position, input.yaw, false);
          const colliderEntity = spawnBodyEntity(ctx.world, pose.center, door.halfExtents, pose.yaw,
            { tool: "building.functionalDoorCollider", input: { assetId: input.assetId, hash: resolved.hash, semanticId: door.id } });
          created.push(colliderEntity);
          const colliderEntry = ctx.world.entities.resolve(colliderEntity)!;
          ctx.world.entities.setParent(colliderEntity, root, computeLocalOffset(ctx.world, root, colliderEntry.eid));
          const authored = authoredDoorNodes.get(door.nodeId) as unknown as {
            parent?: { remove(child: unknown): void };
            position: { set(x: number, y: number, z: number): void };
            quaternion: { set(x: number, y: number, z: number, w: number): void };
            scale: { set(x: number, y: number, z: number): void };
          } | undefined;
          authored?.parent?.remove(authored);
          authored?.position.set(0, 0, 0); authored?.quaternion.set(0, 0, 0, 1); authored?.scale.set(1, 1, 1);
          const portalRuntimeId=`${root}:${door.portalId}`,keyId=input.locks[door.id];
          const state:DoorRuntimeState={assetId:input.assetId,hash:resolved.hash,position:input.position,buildingYaw:input.yaw,door,colliderEntity,open:false,locked:keyId!==undefined,...(keyId===undefined?{}:{keyId}),portalRuntimeId,buildingRoot:root};
          const entity = spawnVisualEntity(ctx.world, pose.hinge, pose.yaw,
            doorOrigin(state), authored as unknown as SceneObject | undefined);
          created.push(entity); doors.push(entity);
          const entry = ctx.world.entities.resolve(entity)!;
          const tags = ctx.world.tags.get(entry.eid)!; tags.add("functional-door"); tags.add("door-closed");
          ctx.world.entities.setParent(entity, root, computeLocalOffset(ctx.world, root, entry.eid));
          derive(ctx.world,entity,state);
        }
        ctx.emit("building.functionalPlaced", { root, buildingId: contract.buildingId, assetId: input.assetId, hash: resolved.hash, parts: parts.length, doors: doors.length });
        return { root, doors, parts, hash: resolved.hash };
      } catch (error) {
        const failures: unknown[] = [error];
        if (created[0] !== undefined) deps?.topology?.unregisterBuilding(created[0]);
        for (const entity of created.reverse()) try { teardownEntity(ctx.world, entity); } catch (failure) { failures.push(failure); }
        if (failures.length > 1) throw new AggregateError(failures, "functional building: placement failed and rollback reported errors");
        throw error;
      }
    },
  };

  const occupied = (world: WorldContext, state: DoorRuntimeState): boolean => {
    const pose = doorPose(state.door, state.position, state.buildingYaw, false), q = quatYaw(pose.yaw);
    const out = new Uint32Array(4096), collider = world.entities.resolve(state.colliderEntity);
    const count = world.ops.op_physics_overlap_box(...pose.center, ...state.door.halfExtents, ...q, collider?.bodyId ?? -1, out);
    if (count === out.length) return true; // truncated results cannot prove the doorway clear
    const occupantBodies = new Set<number>();
    for (const id of world.entities.ids()) {
      const entity = world.entities.resolve(id);
      if (entity?.bodyId !== undefined && !world.tags.get(entity.eid)?.has("functional-building-part")) occupantBodies.add(entity.bodyId);
    }
    for (let i = 0; i < count; i++) if (occupantBodies.has(out[i]!)) return true;
    return false;
  };
  const applyOpen = (doorId: string, open: boolean, ctx: ExecutionContext) => {
    const entry = ctx.world.entities.resolve(doorId);
    if (entry === undefined || entry.origin?.tool !== "building.functionalDoor") throw new Error(`door.setOpen: '${doorId}' is not a functional door`);
    const state = entry.origin.input as unknown as DoorRuntimeState;
    derive(ctx.world, doorId, state);
    if (!open && state.open && occupied(ctx.world, state)) return { door: doorId, open: true, ok: false, reason: "occupied" };
    const collider = ctx.world.entities.resolve(state.colliderEntity);
    if (collider?.bodyId === undefined) throw new Error(`door.setOpen: '${doorId}' lost its authored collider`);
    const pose = doorPose(state.door, state.position, state.buildingYaw, open), q = quatYaw(pose.yaw);
    Position.x[entry.eid] = pose.hinge[0]; Position.y[entry.eid] = pose.hinge[1]; Position.z[entry.eid] = pose.hinge[2];
    Rotation.x[entry.eid] = q[0]; Rotation.y[entry.eid] = q[1]; Rotation.z[entry.eid] = q[2]; Rotation.w[entry.eid] = q[3];
    Position.x[collider.eid] = pose.center[0]; Position.y[collider.eid] = pose.center[1]; Position.z[collider.eid] = pose.center[2];
    Rotation.x[collider.eid] = q[0]; Rotation.y[collider.eid] = q[1]; Rotation.z[collider.eid] = q[2]; Rotation.w[collider.eid] = q[3];
    ctx.world.ops.op_physics_set_body_transform(collider.bodyId, ...pose.center, ...q);
    state.open = open; entry.origin = doorOrigin(state);
    if (entry.parent !== undefined) ctx.world.entities.setParent(doorId, entry.parent, computeLocalOffset(ctx.world, entry.parent, entry.eid));
    if (collider.parent !== undefined) ctx.world.entities.setParent(state.colliderEntity, collider.parent, computeLocalOffset(ctx.world, collider.parent, collider.eid));
    const tags = ctx.world.tags.get(entry.eid) ?? new Set<string>();
    tags.delete(open ? "door-closed" : "door-open"); tags.add(open ? "door-open" : "door-closed"); ctx.world.tags.set(entry.eid, tags);
    derive(ctx.world, doorId, state);
    ctx.emit("door.stateChanged", { door: doorId, open });
    return { door: doorId, open, ok: true };
  };
  const doorInput = z.object({ door: z.string(), open: z.boolean() });
  const setOpen: SkillDefinition<z.infer<typeof doorInput>, { door: string; open: boolean; ok:boolean; reason?:string }> = {
    name: "door.setOpen", version: "1.0.0", description: "Set a functional building door to an absolute, replay-safe open state.",
    category: "interaction", permissions: ["scene.write"], input: doorInput,
    output: z.object({ door: z.string(), open: z.boolean(), ok: z.boolean(), reason: z.string().optional() }),
    handler: (input, ctx) => applyOpen(input.door, input.open, ctx),
  };

  dispatchDoor = (door, actorEntity, ctx) => {
    const entry = ctx.world.entities.resolve(door), actor = ctx.world.entities.resolve(actorEntity);
    if (entry?.origin?.tool !== "building.functionalDoor" || actor === undefined) throw new Error("door.interact: invalid door or actor");
    const state = entry.origin.input as unknown as DoorRuntimeState;
    const dx = Position.x[actor.eid] - Position.x[entry.eid], dy = Position.y[actor.eid] - Position.y[entry.eid], dz = Position.z[actor.eid] - Position.z[entry.eid];
    const targetOpen = !state.open;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 3) return { door, open: state.open, ok: false, reason: "out-of-range" };
    if (state.locked && (state.keyId === undefined || !deps?.inventory?.hasItem(actorEntity, state.keyId))) return { door, open: state.open, ok: false, reason: "locked" };
    if (!targetOpen && occupied(ctx.world, state)) return { door, open: state.open, ok: false, reason: "occupied" };
    const result = applyOpen(door, targetOpen, ctx);
    if (result.ok) {
      if (state.locked) {
        state.locked = false;
        entry.origin = doorOrigin(state);
        derive(ctx.world, door, state);
      }
      const position = doorPose(state.door, state.position, state.buildingYaw, result.open).hinge;
      deps?.audio?.playAt(result.open ? 240 : 160, .18, position, "sfx", .7, 12, door);
    }
    return result;
  };
  const interactInput = z.object({ door: z.string(), actorEntity: z.string() });
  const interact: SkillDefinition<z.infer<typeof interactInput>, { door: string; open: boolean; ok: boolean; reason?: string }> = {
    name: "door.interact", version: "1.0.0", description: "Interact with a nearby functional door, respecting locks and occupied-close safety.",
    category: "interaction", permissions: ["interaction.write"], input: interactInput,
    output: z.object({ door: z.string(), open: z.boolean(), ok: z.boolean(), reason: z.string().optional() }),
    handler: (input, ctx) => dispatchDoor(input.door, input.actorEntity, ctx),
  };
  const lockInput = z.object({ door: z.string(), locked: z.boolean(), keyId: z.string().optional() });
  const setLocked: SkillDefinition<z.infer<typeof lockInput>, { door: string; locked: boolean; keyId?: string }> = {
    name: "door.setLocked", version: "1.0.0", description: "Set persistent functional-door lock state.",
    category: "interaction", permissions: ["scene.write"], input: lockInput, output: lockInput,
    handler: (input, ctx) => {
      const entry = ctx.world.entities.resolve(input.door);
      if (entry?.origin?.tool !== "building.functionalDoor") throw new Error("door.setLocked: invalid door");
      const state = entry.origin.input as unknown as DoorRuntimeState;
      state.locked = input.locked;
      state.keyId = input.keyId ?? state.keyId;
      entry.origin = doorOrigin(state);
      derive(ctx.world, input.door, state);
      return input;
    },
  };

  const destroyInput = z.object({ root: z.string() });
  const destroy: SkillDefinition<z.infer<typeof destroyInput>, { removed: number }> = {
    name: "building.destroyFunctional", version: "1.0.0", description: "Destroy a functional building and all owned collision/door entities.",
    category: "scene", permissions: ["scene.write"], input: destroyInput, output: z.object({ removed: z.number() }),
    handler: (input, ctx) => {
      const root = ctx.world.entities.resolve(input.root);
      if (root === undefined || !ctx.world.tags.get(root.eid)?.has("functional-building-root")) return { removed: 0 };
      const children = ctx.world.entities.childrenOf(input.root);
      for (const child of children) {
        const entry = ctx.world.entities.resolve(child);
        if (entry?.origin?.tool === "building.functionalDoor") {
          const state = entry.origin.input as unknown as DoorRuntimeState;
          deps?.interaction?.unregister(child);
          deps?.nav?.unregisterPortal(state.portalRuntimeId);
        }
      }
      deps?.topology?.unregisterBuilding(input.root);
      let removed = 0;
      for (const child of children.reverse()) if (teardownEntity(ctx.world, child) !== undefined) removed++;
      if (teardownEntity(ctx.world, input.root) !== undefined) removed++;
      ctx.emit("building.functionalDestroyed", { root: input.root, removed });
      return { removed };
    },
  };
  const queryRoomInput = z.object({ position: Vec3, root: z.string().optional() });
  const queryRoom: SkillDefinition<z.infer<typeof queryRoomInput>, { found: boolean; root?: string; roomId?: string; storey?: number }> = {
    name: "building.queryRoom", version: "1.0.0", description: "Resolve a world position against layered functional-building room volumes.",
    category: "scene", permissions: ["scene.read"], effect: "read", input: queryRoomInput,
    output: z.object({ found: z.boolean(), root: z.string().optional(), roomId: z.string().optional(), storey: z.number().int().optional() }),
    handler: (input) => { const hit = deps?.topology?.queryRoom(input.position, input.root); return hit === undefined ? { found: false } : { found: true, root: hit.buildingId, roomId: hit.roomId, storey: hit.storey }; },
  };
  const roomPathInput = z.object({ root: z.string(), fromRoomId: z.string(), toRoomId: z.string() });
  const roomPath: SkillDefinition<z.infer<typeof roomPathInput>, { found: boolean; roomIds: string[]; connectionIds: string[] }> = {
    name: "building.findRoomPath", version: "1.0.0", description: "Find a deterministic layered room path through currently traversable portals and stairs.",
    category: "nav", permissions: ["nav.read"], effect: "read", input: roomPathInput,
    output: z.object({ found: z.boolean(), roomIds: z.array(z.string()), connectionIds: z.array(z.string()) }),
    handler: (input) => { const path = deps?.topology?.findRoomPath(input.root, input.fromRoomId, input.toRoomId); return path === undefined ? { found: false, roomIds: [], connectionIds: [] } : { found: true, roomIds: path.roomIds, connectionIds: path.connectionIds }; },
  };
  const cellsInput = z.object({ position: Vec3, root: z.string().optional(), maxConnections: z.number().int().min(0).max(32).default(2), maxCells: z.number().int().min(1).max(32).default(32) });
  const cells: SkillDefinition<z.infer<typeof cellsInput>, { found: boolean; roomId?: string; cellIds: string[] }> = {
    name: "building.queryResidentCells", version: "1.0.0", description: "Return the bounded visibility/residency cells reachable from an observer through open layered topology.",
    category: "scene", permissions: ["scene.read"], effect: "read", input: cellsInput,
    output: z.object({ found: z.boolean(), roomId: z.string().optional(), cellIds: z.array(z.string()) }),
    handler: (input) => { const result = deps?.topology?.queryResidentCells(input.position, input.root, input.maxConnections, input.maxCells); return result === undefined ? { found: false, cellIds: [] } : { found: true, roomId: result.roomId, cellIds: result.cellIds }; },
  };
  const acousticInput = z.object({ root: z.string(), sourceRoomId: z.string(), listenerRoomId: z.string() });
  const acoustic: SkillDefinition<z.infer<typeof acousticInput>, { gain: number }> = {
    name: "building.roomAcousticGain", version: "1.0.0", description: "Compute deterministic room-aware acoustic propagation through doors, passages, and stairs.",
    category: "audio", permissions: ["scene.read"], effect: "read", input: acousticInput, output: z.object({ gain: z.number().min(0).max(1) }),
    handler: (input) => ({ gain: deps?.topology?.acousticGain(input.root, input.sourceRoomId, input.listenerRoomId) ?? 0 }),
  };
  const anchorsInput = z.object({ root: z.string(), roomId: z.string().optional(), kind: z.enum(["player", "npc", "item"]).optional() });
  const anchors: SkillDefinition<z.infer<typeof anchorsInput>, { anchors: ReturnType<FunctionalBuildingTopologyManager["worldSpawnAnchors"]> }> = {
    name: "building.querySpawnAnchors", version: "1.0.0", description: "Return stable world-transformed, clearance-bearing interior spawn anchors.",
    category: "scene", permissions: ["scene.read"], effect: "read", input: anchorsInput,
    output: z.object({ anchors: z.array(z.object({ buildingId: z.string(), id: z.string(), roomId: z.string(), kind: z.enum(["player", "npc", "item"]), position: Vec3, direction: Vec3, clearanceRadius: z.number().positive(), clearanceHeight: z.number().positive() })) }),
    handler: (input) => ({ anchors: (deps?.topology?.worldSpawnAnchors(input.root, input.roomId) ?? []).filter((anchor) => input.kind === undefined || anchor.kind === input.kind) }),
  };
  registry.register(place as never);
  registry.register(setOpen as never);
  registry.register(interact as never);
  registry.register(setLocked as never);
  registry.register(destroy as never);
  registry.register(queryRoom as never);
  registry.register(roomPath as never);
  registry.register(cells as never);
  registry.register(acoustic as never);
  registry.register(anchors as never);
}
