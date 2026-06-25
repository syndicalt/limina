// physics.* skills — impulse + raycast over the native Rapier ops.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const collisionEventOutput = z.object({
  events: z.array(z.object({
    started: z.boolean(),
    bodyA: z.number().int().nonnegative(),
    bodyB: z.number().int().nonnegative(),
    entityA: z.string().optional(),
    entityB: z.string().optional(),
    point: Vec3.nullable(),
    normal: Vec3.nullable(),
  })),
});

const applyImpulseInput = z.object({ entity: z.string(), impulse: Vec3 });
const applyImpulse: SkillDefinition<z.infer<typeof applyImpulseInput>, { ok: boolean }> = {
  name: "physics.applyImpulse",
  version: "1.0.0",
  description: "Apply an impulse [x,y,z] to an entity's dynamic body (wakes it).",
  category: "physics",
  permissions: ["physics.write"],
  input: applyImpulseInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const bodyId = ctx.world.entities.resolve(input.entity)?.bodyId;
    if (bodyId === undefined) return { ok: false };
    ctx.world.ops.op_physics_apply_impulse(bodyId, input.impulse[0], input.impulse[1], input.impulse[2]);
    ctx.emit("physics.impulse.applied", { entity: input.entity, impulse: input.impulse });
    return { ok: true };
  },
};

const raycastInput = z.object({
  origin: Vec3,
  direction: Vec3,
  maxDistance: z.number().positive().default(1000),
});
const raycast: SkillDefinition<
  z.infer<typeof raycastInput>,
  { hit: boolean; distance?: number; point?: [number, number, number]; entity?: string }
> = {
  name: "physics.raycast",
  version: "1.0.0",
  description: "Cast a ray from origin along direction; returns the first hit (distance, point, entity).",
  category: "physics",
  permissions: ["physics.read"],
  input: raycastInput,
  output: z.object({
    hit: z.boolean(),
    distance: z.number().optional(),
    point: Vec3.optional(),
    entity: z.string().optional(),
  }),
  handler: (input, ctx) => {
    const out = new Float32Array(6);
    ctx.world.ops.op_physics_raycast(
      input.origin[0], input.origin[1], input.origin[2],
      input.direction[0], input.direction[1], input.direction[2],
      input.maxDistance, out,
    );
    if (out[0] !== 1) return { hit: false };
    const bodyId = out[5];
    let entity: string | undefined;
    if (bodyId >= 0) {
      for (const id of ctx.world.entities.ids()) {
        if (ctx.world.entities.resolve(id)?.bodyId === bodyId) { entity = id; break; }
      }
    }
    return { hit: true, distance: out[1], point: [out[2], out[3], out[4]], entity };
  },
};

const collisionEvents: SkillDefinition<unknown, z.infer<typeof collisionEventOutput>> = {
  name: "physics.collisionEvents",
  version: "1.0.0",
  description: "Drain physics collision start/stop events, mapped to entity ids where available.",
  category: "physics",
  permissions: ["physics.read"],
  input: z.object({}).default({}),
  output: collisionEventOutput,
  handler: (_input, ctx) => {
    const bodyToEntity = new Map<number, string>();
    for (const id of ctx.world.entities.ids()) {
      const bodyId = ctx.world.entities.resolve(id)?.bodyId;
      if (bodyId !== undefined) bodyToEntity.set(bodyId, id);
    }
    const events = ctx.world.ops.op_physics_drain_collisions().map((rec) => {
      const entityA = bodyToEntity.get(rec.a);
      const entityB = bodyToEntity.get(rec.b);
      const phase = rec.kind === 1 ? "started" : "stopped";
      // Publish the agent-facing envelope (entity ids when resolvable) carrying the
      // real world-space contact point + normal from the Rapier manifold.
      ctx.emit("physics.collision", {
        a: entityA ?? rec.a,
        b: entityB ?? rec.b,
        phase,
        point: rec.point,
        normal: rec.normal,
      });
      return {
        started: rec.kind === 1,
        bodyA: rec.a,
        bodyB: rec.b,
        entityA,
        entityB,
        point: rec.point,
        normal: rec.normal,
      };
    });
    return { events };
  },
};

export function registerPhysicsSkills(registry: SkillRegistry): void {
  registry.register(applyImpulse);
  registry.register(raycast);
  registry.register(collisionEvents);
}
