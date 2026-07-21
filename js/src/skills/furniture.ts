import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { parseFunctionalFurnitureContract, type FurnitureV3, type FunctionalFurnitureSocket } from "../assets/furniture-functional-contract.ts";
import { MAX_ENTITIES, Rotation, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { EntityOrigin } from "../engine.ts";
import { computeLocalOffset } from "../ecs/hierarchy.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { loadGltfIntoScene } from "./three.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const inert = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });
const add = (a: readonly number[], b: readonly number[]): FurnitureV3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const rotateY = (v: readonly number[], yaw: number): FurnitureV3 => {
  const c = Math.cos(yaw), s = Math.sin(yaw); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};
const quatYaw = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

export interface PlacedFurnitureSocket extends Omit<FunctionalFurnitureSocket, "position" | "facing"> { position: FurnitureV3; facing: FurnitureV3; }

function spawnCollider(world: WorldContext, position: FurnitureV3, half: FurnitureV3, yaw: number, origin: EntityOrigin): string {
  const eid = spawnRenderable(world.ecs, inert() as never, ...position);
  if (eid >= MAX_ENTITIES) { despawnRenderable(world.ecs, eid); throw new Error("functional furniture: entity capacity exceeded"); }
  const q = quatYaw(yaw); Rotation.x[eid] = q[0]; Rotation.y[eid] = q[1]; Rotation.z[eid] = q[2]; Rotation.w[eid] = q[3];
  let bodyId: number | undefined;
  try {
    bodyId = world.ops.op_physics_add_static_box(position[0], position[1], position[2], half[0], half[1], half[2], 0.85, 0);
    world.ops.op_physics_set_body_transform(bodyId, ...position, ...q);
    const entity = world.entities.create({ eid, bodyId, origin });
    world.tags.set(eid, new Set(["functional-furniture-collider"]));
    return entity;
  } catch (error) {
    const failures: unknown[] = [error];
    if (bodyId !== undefined) try { world.ops.op_physics_remove_body(bodyId); } catch (failure) { failures.push(failure); }
    try { despawnRenderable(world.ecs, eid); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "functional furniture collider publication and rollback failed");
    throw error;
  }
}

function spawnSemanticRoot(world: WorldContext, position: FurnitureV3, yaw: number, origin: EntityOrigin): string {
  const eid = spawnRenderable(world.ecs, inert() as never, ...position);
  if (eid >= MAX_ENTITIES) { despawnRenderable(world.ecs, eid); throw new Error("functional furniture: entity capacity exceeded"); }
  const q = quatYaw(yaw); Rotation.x[eid] = q[0]; Rotation.y[eid] = q[1]; Rotation.z[eid] = q[2]; Rotation.w[eid] = q[3];
  try { return world.entities.create({ eid, origin }); }
  catch (error) {
    try { despawnRenderable(world.ecs, eid); }
    catch (failure) { throw new AggregateError([error, failure], "functional furniture semantic root publication and rollback failed"); }
    throw error;
  }
}

export function registerFurnitureSkills(registry: SkillRegistry, assets: AssetRegistry): void {
  const inputSchema = z.object({ assetId: z.string(), position: Vec3.default([0, 0, 0]), yaw: z.number().default(0), visual: z.boolean().default(true), hash: z.string().optional(), contractHash: z.string().optional() });
  const socketSchema = z.object({ id: z.string(), kind: z.enum(["occupancy", "approach", "inspect"]), position: Vec3, facing: Vec3, supportedBy: z.string(), clearanceRadiusM: z.number().positive() });
  const place: SkillDefinition<z.infer<typeof inputSchema>, { root: string; colliders: string[]; sockets: PlacedFurnitureSocket[]; hash: string; contractHash: string }> = {
    name: "furniture.placeFunctional", version: "1.1.0", description: "Place exact-hash authored furniture with semantic sockets and compound collision; visual=false publishes semantics without duplicating a GLB scene.", category: "scene", permissions: ["scene.write"],
    input: inputSchema, output: z.object({ root: z.string(), colliders: z.array(z.string()), sockets: z.array(socketSchema), hash: z.string(), contractHash: z.string() }), commitFields: ["hash", "contractHash"],
    handler: async (input, ctx) => {
      const resolved = assets.resolve(input.assetId);
      // Committed-asset-hash pin: WARN (never THROW) on a mismatch — mirrors asset.place exactly.
      // resolved.hash comes from op_sha256, which is NOT byte-identical across the Rust and JS
      // hosts, so a cross-host replay of a healthy placement can mismatch; throwing here aborts
      // the replay (failure mode #12, shipped three times). assetId pins authored identity; a
      // genuinely swapped asset surfaces as a visible furniture.hash_mismatch event. The
      // contractHash pin below still throws: it is a pure-JS sha256 over canonical JSON
      // (host-independent), so a mismatch there is genuine contract drift.
      if (input.hash !== undefined && input.hash !== resolved.hash) {
        ctx.emit("furniture.hash_mismatch", { assetId: input.assetId, committed: input.hash, resolved: resolved.hash });
      }
      const contract = parseFunctionalFurnitureContract(resolved.bytes);
      if (input.contractHash !== undefined && input.contractHash !== contract.contractHash) throw new Error(`functional furniture: pinned contract hash mismatch for ${input.assetId}`);
      const sockets = contract.sockets.map((socket): PlacedFurnitureSocket => ({ ...socket, position: add(input.position, rotateY(socket.position, input.yaw)), facing: rotateY(socket.facing, input.yaw) }));
      const created: string[] = [];
      try {
        const origin: EntityOrigin = { tool: "furniture.placeFunctional", input: { ...input, hash: resolved.hash, contractHash: contract.contractHash, furnitureId: contract.furnitureId, sockets } };
        const root = input.visual
          ? (await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, { position: input.position, rotationEuler: [0, input.yaw, 0] })).entity
          : spawnSemanticRoot(ctx.world, input.position, input.yaw, origin);
        created.push(root);
        const rootEntry = ctx.world.entities.resolve(root);
        if (rootEntry === undefined) throw new Error("functional furniture: root was not published");
        if (input.visual && ctx.world.simWorker !== true && rootEntry.mesh === undefined) throw new Error("functional furniture: exact visual GLB failed to mount");
        ctx.world.entities.bindOrigin(root, origin);
        const rootTags = ctx.world.tags.get(rootEntry.eid) ?? new Set<string>(); rootTags.add("functional-furniture-root");
        if (!input.visual) rootTags.add("functional-furniture-semantic-only");
        ctx.world.tags.set(rootEntry.eid, rootTags);
        const colliders: string[] = [];
        for (const collider of contract.colliders) {
          const center = add(input.position, rotateY(collider.center, input.yaw));
          const entity = spawnCollider(ctx.world, center, collider.halfExtents, input.yaw, { tool: "furniture.functionalCollider", input: { assetId: input.assetId, hash: resolved.hash, contractHash: contract.contractHash, semanticId: collider.id } });
          created.push(entity); colliders.push(entity);
          ctx.world.entities.setParent(entity, root, computeLocalOffset(ctx.world, root, ctx.world.entities.resolve(entity)!.eid));
        }
        const priorDispose = rootEntry.runtimeDispose, owned = [...colliders];
        rootEntry.runtimeDispose = () => {
          const errors: unknown[] = [];
          // EntityTable.destroy(root) runs before runtimeDispose and may detach hierarchy
          // links, so retain the exact owned identities rather than rediscovering children.
          for (const child of [...owned].reverse()) try { teardownEntity(ctx.world, child); } catch (error) { errors.push(error); }
          try { priorDispose?.(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, "functional furniture child teardown failed");
        };
        ctx.emit("furniture.functionalPlaced", { root, furnitureId: contract.furnitureId, assetId: input.assetId, hash: resolved.hash, contractHash: contract.contractHash, visual: input.visual, colliders: colliders.length, sockets: sockets.length });
        return { root, colliders, sockets, hash: resolved.hash, contractHash: contract.contractHash };
      } catch (error) {
        const failures: unknown[] = [error];
        for (const entity of created.reverse()) try { teardownEntity(ctx.world, entity); } catch (failure) { failures.push(failure); }
        if (failures.length > 1) throw new AggregateError(failures, "functional furniture placement and rollback failed");
        throw error;
      }
    },
  };
  const destroyInput = z.object({ root: z.string() });
  const destroy: SkillDefinition<z.infer<typeof destroyInput>, { root: string; removed: string[]; removedEids: number[] }> = {
    name: "furniture.destroyFunctional", version: "1.0.0", description: "Destroy a functional furniture root and every exact owned compound-collider entity, including after snapshot restore.",
    category: "scene", permissions: ["scene.write"], input: destroyInput,
    output: z.object({ root: z.string(), removed: z.array(z.string()), removedEids: z.array(z.number().int().nonnegative()) }),
    handler: (input, ctx) => {
      const root = ctx.world.entities.resolve(input.root);
      if (root === undefined) return { root: input.root, removed: [], removedEids: [] };
      if (root.origin?.tool !== "furniture.placeFunctional") throw new Error(`functional furniture: '${input.root}' is not a functional furniture root`);
      const owner = root.origin.input as { assetId?: unknown; hash?: unknown; contractHash?: unknown };
      const children = ctx.world.entities.childrenOf(input.root);
      for (const childId of children) {
        const child = ctx.world.entities.resolve(childId), origin = child?.origin;
        const details = origin?.input as { assetId?: unknown; hash?: unknown; contractHash?: unknown } | undefined;
        if (child === undefined || origin?.tool !== "furniture.functionalCollider"
          || details?.assetId !== owner.assetId || details?.hash !== owner.hash || details?.contractHash !== owner.contractHash) {
          throw new Error(`functional furniture: '${input.root}' has an unowned child '${childId}'`);
        }
      }
      const ordered = [...children, input.root], removed: string[] = [], removedEids: number[] = [];
      for (const entity of ordered) {
        const entry = ctx.world.entities.resolve(entity);
        if (entry === undefined) continue;
        const eid = entry.eid;
        if (teardownEntity(ctx.world, entity) !== undefined) { removed.push(entity); removedEids.push(eid); }
      }
      ctx.emit("furniture.functionalDestroyed", { root: input.root, removed: removed.length, removedEids });
      return { root: input.root, removed, removedEids };
    },
  };
  registry.register(place as never); registry.register(destroy as never);
}
