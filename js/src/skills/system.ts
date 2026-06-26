// system.* skills — registry discovery (skills.list / skills.describe).

import { z } from "../../build/zod.bundle.mjs";
import { Position, Rotation, Scale } from "../ecs/world.ts";
import type { LoadedResourceMetadata } from "../engine.ts";
import type { LiminaTracer } from "../observability/event.ts";
import { PERMISSION_PROFILES } from "./permissions.ts";
import type { ExecutionContext, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const n = value[key];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const s = value[key];
  return typeof s === "string" ? s : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const b = value[key];
  return typeof b === "boolean" ? b : undefined;
}

function agentSnapshot(agent: unknown): Record<string, unknown> {
  return {
    id: stringField(agent, "id") ?? "unknown",
    type: stringField(agent, "type") ?? "unknown",
    entityId: stringField(agent, "entityId"),
    profile: stringField(agent, "profile") ?? "unknown",
    sessionId: stringField(agent, "sessionId") ?? "unknown",
    perceptionRadius: numberField(agent, "perceptionRadius") ?? 0,
    decisionIntervalTicks: numberField(agent, "decisionIntervalTicks") ?? 0,
    inFlight: booleanField(agent, "inFlight") ?? false,
    lastDecisionTick: numberField(agent, "lastDecisionTick") ?? 0,
    queueLength: Array.isArray(isRecord(agent) ? agent.queue : undefined) ? (agent as { queue: unknown[] }).queue.length : 0,
    lastPerceptionEventId: stringField(agent, "lastPerceptionEventId"),
  };
}

function resourceCounts(resources: LoadedResourceMetadata[]): Record<string, number> {
  const counts: Record<string, number> = { total: resources.length, gltf: 0, objects: 0, meshes: 0, materials: 0, textures: 0, bytes: 0 };
  for (const resource of resources) {
    counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
    counts.objects += resource.objectCount;
    counts.meshes += resource.meshCount;
    counts.materials += resource.materialCount;
    counts.textures += resource.textureCount;
    counts.bytes += resource.bytes;
  }
  return counts;
}

function sceneMetadata(ctx: ExecutionContext): Record<string, unknown> {
  const scene = ctx.world.scene;
  const camera = ctx.world.camera;
  return {
    mode: ctx.world.mode ?? (ctx.world.renderer === undefined ? "headless" : "windowed"),
    renderer: {
      present: ctx.world.renderer !== undefined,
      width: ctx.world.width,
      height: ctx.world.height,
    },
    scene: {
      background: isRecord(scene.background) && typeof scene.background.toString === "function" ? scene.background.toString() : scene.background,
      position: [scene.position.x, scene.position.y, scene.position.z],
    },
    camera: {
      aspect: camera.aspect,
    },
  };
}

export function registerSystemSkills(registry: SkillRegistry): void {
  registry.register({
    name: "skills.list",
    version: "1.0.0",
    description: "List the skills the caller is authorized to invoke (names + descriptions).",
    category: "system",
    permissions: [],
    input: z.object({}),
    output: z.object({ tools: z.array(z.object({ name: z.string(), description: z.string() })) }),
    handler: (_input, ctx) => ({
      // Least-privilege: list only what THIS caller could invoke (its grants).
      tools: registry.list(ctx.permissions).map((t) => ({ name: t.name, description: t.description })),
    }),
  });

  const describeInput = z.object({ name: z.string() });
  registry.register({
    name: "skills.describe",
    version: "1.0.0",
    description: "Describe a skill: version, category, and JSON-Schema input.",
    category: "system",
    permissions: [],
    input: describeInput,
    output: z.object({
      name: z.string(),
      version: z.string(),
      category: z.string(),
      description: z.string(),
      input_schema: z.unknown(),
    }),
    handler: (input, ctx) => {
      // Only describe a skill the caller could invoke — don't leak the catalog.
      const tool = registry.list(ctx.permissions).find((t) => t.name === input.name);
      const def = registry.describe(input.name);
      if (tool === undefined || def === undefined) throw new Error(`unknown skill: ${input.name}`);
      return {
        name: def.name,
        version: def.version,
        category: def.category,
        description: def.description,
        input_schema: tool.input_schema,
      };
    },
  });

  const searchInput = z.object({
    query: z.string(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  });
  registry.register({
    name: "skills.search",
    version: "1.0.0",
    description: "Search the AUTHORIZED skills by name/description (+ optional category) — browse a large catalog instead of listing everything.",
    category: "system",
    permissions: [],
    input: searchInput,
    output: z.object({ matches: z.array(z.object({ name: z.string(), description: z.string(), category: z.string() })) }),
    handler: (input, ctx) => {
      const q = input.query.toLowerCase();
      const limit = input.limit ?? 25;
      const matches: { name: string; description: string; category: string }[] = [];
      for (const t of registry.list(ctx.permissions)) {
        const def = registry.describe(t.name);
        if (def === undefined) continue;
        if (input.category !== undefined && def.category !== input.category) continue;
        if (q.length > 0 && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) continue;
        matches.push({ name: t.name, description: t.description, category: def.category });
        if (matches.length >= limit) break;
      }
      return { matches };
    },
  });

  const tracer = (registry as unknown as { tracer: LiminaTracer }).tracer;
  const eventSchema = z.object({
    id: z.string(),
    type: z.string(),
    actorId: z.string(),
    threadId: z.string(),
    parentEventId: z.string().nullable(),
    causedBy: z.array(z.string()),
    timestamp: z.string(),
    payload: z.unknown(),
    integrity: z.object({ hash: z.string(), previousHash: z.string().nullable() }).optional(),
  });

  registry.register({
    name: "trace.tail",
    version: "1.0.0",
    description: "Tail trace events with cursor pagination and optional actor/type filters.",
    category: "system",
    // The trace is CROSS-AGENT: tailing it reveals every actor's events. Gate it
    // behind `trace.read` so only observer profiles (reviewer / reviewer.coordinator
    // / system.readonly) can read it — a scoped delegate worker must NOT.
    permissions: ["trace.read"],
    input: z.object({
      afterSeq: z.number().int().min(-1).optional(),
      limit: z.number().int().min(0).max(1000).optional(),
      actorId: z.string().optional(),
      type: z.string().optional(),
    }),
    output: z.object({
      events: z.array(eventSchema),
      nextAfterSeq: z.number().int().nullable(),
    }),
    handler: (input) => tracer.tail(input),
  });

  registry.register({
    name: "trace.explainEvent",
    version: "1.0.0",
    description: "Explain a trace event with resolved causal parents and children.",
    category: "system",
    // Resolves a cross-agent event + its causal neighbours — same read surface as
    // trace.tail, so it is gated behind the same `trace.read` capability.
    permissions: ["trace.read"],
    input: z.object({ eventId: z.string() }),
    output: z.object({
      event: eventSchema,
      parents: z.array(eventSchema),
      children: z.array(eventSchema),
    }),
    handler: (input) => {
      const explanation = tracer.explainEvent(input.eventId);
      if (explanation === undefined) throw new Error(`unknown event: ${input.eventId}`);
      return explanation;
    },
  });

  registry.register({
    name: "trace.export",
    version: "1.0.0",
    description: "Flush the durable trace history to a sandboxed trace JSONL file.",
    category: "system",
    // Reads the WHOLE durable trace AND writes it to disk — strictly more powerful
    // than trace.tail, so it stays behind the same `trace.read` observer capability
    // (one cap, kept simple). A scoped worker has neither read nor export.
    permissions: ["trace.read"],
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ name: z.string(), events: z.number().int(), bytes: z.number().int() }),
    handler: (input) => tracer.flush(input.name),
  });

  const snapshotInput = z.object({
    afterEntity: z.string().optional(),
    limit: z.number().int().min(0).max(500).default(100),
  });
  registry.register({
    name: "inspector.snapshot",
    version: "1.0.0",
    description: "Return a bounded, paginated snapshot of world, entities, agents, skills, permissions, resources, and trace metadata.",
    category: "system",
    permissions: ["scene.read", "ecs.read", "physics.read", "agent.read"],
    input: snapshotInput,
    output: z.object({
      page: z.object({
        limit: z.number().int(),
        totalEntities: z.number().int(),
        nextAfterEntity: z.string().nullable(),
      }),
      world: z.unknown(),
      entities: z.array(z.object({
        entity: z.string(),
        eid: z.number().int(),
        generation: z.number().int(),
        transform: z.object({ position: Vec3, rotation: Quat, scale: Vec3 }),
        tags: z.array(z.string()),
        physics: z.object({ bodyId: z.number().int().optional() }),
        resource: z.unknown().optional(),
      })),
      agents: z.array(z.unknown()),
      skills: z.array(z.object({
        name: z.string(),
        version: z.string(),
        category: z.string(),
        permissions: z.array(z.string()),
      })),
      permissions: z.object({
        caller: z.array(z.string()),
        profiles: z.record(z.string(), z.array(z.string())),
      }),
      resources: z.object({
        counts: z.record(z.string(), z.number()),
        loaded: z.array(z.unknown()),
      }),
      trace: z.object({
        threadId: z.string(),
        eventCount: z.number().int(),
        actors: z.array(z.string()),
        recent: z.array(eventSchema),
      }),
    }),
    handler: (input, ctx) => {
      const ids = ctx.world.entities.ids();
      const start = input.afterEntity === undefined ? 0 : ids.indexOf(input.afterEntity) + 1;
      const offset = Math.max(0, start);
      const selected = ids.slice(offset, offset + input.limit);
      const nextAfterEntity = offset + input.limit < ids.length && selected.length > 0 ? selected[selected.length - 1] : null;
      const entities = selected.flatMap((entity) => {
        const entry = ctx.world.entities.resolve(entity);
        if (entry === undefined) return [];
        const tags = [...(ctx.world.tags.get(entry.eid) ?? new Set<string>())].sort();
        return [{
          entity,
          eid: entry.eid,
          generation: entry.generation,
          transform: {
            position: [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]] as [number, number, number],
            rotation: [Rotation.x[entry.eid], Rotation.y[entry.eid], Rotation.z[entry.eid], Rotation.w[entry.eid]] as [number, number, number, number],
            scale: [Scale.x[entry.eid], Scale.y[entry.eid], Scale.z[entry.eid]] as [number, number, number],
          },
          tags,
          physics: { bodyId: entry.bodyId },
          resource: entry.resource,
        }];
      });
      const loaded = ids.flatMap((entity) => {
        const resource = ctx.world.entities.resolve(entity)?.resource;
        return resource === undefined ? [] : [{ entity, ...resource }];
      });
      const resources = loaded.map((r) => r as LoadedResourceMetadata);
      // The trace block is the SAME cross-agent surface trace.tail exposes — so it is
      // gated by the SAME `trace.read` capability (Fix 1). inspector.snapshot stays
      // invocable by the four-read profiles (world/entities/agents/skills still
      // returned), but a caller WITHOUT trace.read gets a count-only stub: no actor
      // identities, no event payloads. Otherwise inspector.snapshot would be a
      // trace.read bypass for any agent holding the four reads.
      const traceView = tracer.inspect();
      const trace = ctx.permissions.has("trace.read")
        ? traceView
        : { threadId: traceView.threadId, eventCount: traceView.eventCount, actors: [], recent: [] };
      return {
        page: { limit: input.limit, totalEntities: ids.length, nextAfterEntity },
        world: sceneMetadata(ctx),
        entities,
        agents: ctx.world.agents?.all?.().map(agentSnapshot) ?? [],
        // NOTE: this is the FULL skill catalog ON PURPOSE — inspector.snapshot is an
        // observability surface (it also dumps every profile's permissions just below),
        // and an observer/reviewer that cannot INVOKE build skills still needs to SEE
        // the catalog (the Phase 7 editor renders it). Skill name + required-perms are
        // static catalog metadata, NOT sensitive cross-agent runtime data, so this is
        // not a capability leak. The trace block (real cross-agent events WITH payloads)
        // IS sensitive and is gated by trace.read below.
        skills: [...registry.list()].map((tool) => {
          const def = registry.describe(tool.name);
          return {
            name: tool.name,
            version: def?.version ?? "unknown",
            category: def?.category ?? "unknown",
            permissions: [...(def?.permissions ?? [])],
          };
        }),
        permissions: {
          caller: [...ctx.permissions].sort(),
          profiles: Object.fromEntries(Object.entries(PERMISSION_PROFILES).map(([name, permissions]) => [name, [...permissions]])),
        },
        resources: {
          counts: resourceCounts(resources),
          loaded,
        },
        trace,
      };
    },
  });

  const reloadTarget = z.enum(["skill", "scene", "data"]);
  const reloadInput = z.object({
    target: reloadTarget,
    name: z.string().min(1).optional(),
    reason: z.string().max(200).optional(),
  });
  registry.register({
    name: "dev.reload",
    version: "2.0.0",
    description: "Live-reload a skill (registry unregister+re-register so a later callTool runs the new handler) or re-run a registered scene builder; emits an honest dev.*.reload.completed/.failed trace event listing what was invalidated. Targets that genuinely cannot reload fail honestly instead of pretending success.",
    category: "system",
    permissions: ["scene.read"],
    input: reloadInput,
    output: z.object({
      ok: z.boolean(),
      target: reloadTarget,
      invalidated: z.array(z.string()),
      reason: z.string().optional(),
    }),
    handler: async (input, ctx) => {
      const reason = input.reason ?? null;
      if (input.target === "skill") {
        if (input.name === undefined) {
          const why = "skill reload requires a target skill name";
          ctx.emit("dev.skill.reload.failed", { target: "skill", name: null, reason: why, tick: ctx.tick });
          return { ok: false, target: "skill" as const, invalidated: [], reason: why };
        }
        const result = await registry.reloadSkill(input.name);
        if (result.ok) {
          ctx.emit("dev.skill.reload.completed", { target: "skill", name: input.name, invalidated: result.invalidated, summary: result.summary ?? null, reason, tick: ctx.tick });
        } else {
          ctx.emit("dev.skill.reload.failed", { target: "skill", name: input.name, reason: result.reason ?? "reload failed", tick: ctx.tick });
        }
        return { ok: result.ok, target: "skill" as const, invalidated: result.invalidated, reason: result.reason };
      }
      if (input.target === "scene") {
        const sceneName = input.name ?? registry.sceneBuilderNames()[0];
        if (sceneName === undefined || !registry.hasSceneBuilder(sceneName)) {
          const why = sceneName === undefined
            ? "no scene builder is registered to reload"
            : `no scene builder registered for '${sceneName}'`;
          ctx.emit("dev.scene.reload.failed", { target: "scene", name: sceneName ?? null, reason: why, tick: ctx.tick });
          return { ok: false, target: "scene" as const, invalidated: [], reason: why };
        }
        const result = await registry.reloadScene(sceneName, ctx);
        if (result.ok) {
          ctx.emit("dev.scene.reload.completed", { target: "scene", name: sceneName, invalidated: result.invalidated, summary: result.summary ?? null, reason, tick: ctx.tick });
        } else {
          ctx.emit("dev.scene.reload.failed", { target: "scene", name: sceneName, reason: result.reason ?? "reload failed", tick: ctx.tick });
        }
        return { ok: result.ok, target: "scene" as const, invalidated: result.invalidated, reason: result.reason };
      }
      // target: "data" — opaque assets cannot be hot-swapped in-process (re-import
      // is runtime-owned); fail honestly rather than emit a no-op "success".
      const why = "data reload is runtime-owned and cannot be applied in-process; reload the owning skill or scene instead";
      ctx.emit("dev.data.reload.failed", { target: "data", reason: why, tick: ctx.tick });
      return { ok: false, target: "data" as const, invalidated: [], reason: why };
    },
  });
}
