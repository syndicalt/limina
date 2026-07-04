// Reasoning NPCs — the FIRST CUT of NPCs that run on limina's GENERAL reasoning-
// agent engine (Engine A: perceptionSystem -> decisionSystem -> actionSystem under
// the AgentScheduler), NOT the conversation-specific ConversationDirector.
//
// An NPC is nothing more than an AgentRecord of type "npc" whose body is a
// procedural humanoid, whose movement is the deterministic Locomotion system, and
// whose "brain" is an LLMProvider (ScriptedProvider for the determinism gate,
// OllamaProvider for the live-reasoning smoke). Perception surfaces the built world
// (other NPCs, the settlement) with zero extra plumbing; the model decides ONE of a
// tiny, least-privilege action space — move (social.approach), speak (social.say),
// gesture (animation.emote) — and malformed/hallucinated calls are rejected by the
// decisionSystem before they can execute. Every executed call flows through
// registry.invoke, so it is permission-checked, traced, and (when a WorldRecorder is
// attached) RECORDED to the world log for deterministic replay.
//
// The durable artifact is `NpcSpec`: a clean, replay-safe data model that maps to a
// NewAgent + a settlement spawn. Author it once; the engine consumes it.

import { z } from "../../build/zod.bundle.mjs";
import type { GameContext } from "../game/context.ts";
import type { AgentRecord, AgentRegistry } from "./agent.ts";
import { spawnHumanoid, type Humanoid } from "../world/humanoid.ts";
import type { MCPRequest } from "../mcp/protocol.ts";
import type { DecideRequest } from "./llm.ts";
import { actionSystem, decisionSystem, perceptionSystem, type ProviderMap } from "./systems.ts";
import { AgentScheduler } from "./scheduler.ts";
import type { Tracer } from "../observability/event.ts";

// ── The least-privilege NPC action bundle ────────────────────────────────────
// The npc.agent PROFILE grants ~20 capabilities (combat, behavior, dialogue, nav…);
// a first-cut ambient NPC needs only a few verbs. This capability BUNDLE governs
// BOTH what the model SEES (registry.list) and what it may INVOKE (agentGrants), so
// the model is offered a tiny surface: social.approach (move), social.say (speak),
// and the npc.* behaviour verbs — npc.memorize / npc.setAttitude (a simple, stateful
// "reasoning" interaction: remember or form an opinion about who it just met).
// Nothing else is reachable — a hallucinated `scene.deleteEntity` is not even
// advertised and would be rejected on invocation.
//
// (animation.emote is the classic "gesture" verb but needs a rigged glTF clip our
//  procedural humanoids don't carry, so it fails cleanly rather than executing; the
//  behaviour verbs are the honest cheap interaction for the first cut. v2: rig glTF
//  humanoids and add animation.write for visible emotes.)
export const NPC_ACTION_BUNDLE: ReadonlySet<string> = new Set(["social.act", "behavior.write"]);

/** Sentinel `actionProfile` selecting the least-privilege NPC_ACTION_BUNDLE above
 *  (as opposed to naming a full PERMISSION_PROFILES entry like "npc.agent"). */
export const NPC_BUNDLE_PROFILE = "npc.bundle";

// ── NpcSpec — the durable, replay-safe data model ────────────────────────────

/** Where an NPC spawns: at a settlement building by ROLE, by placement PLOT index,
 *  or at an explicit world XZ. Role/plot resolve against a planVillage layout. */
const npcSpawnSchema = z.union([
  z.object({ role: z.string().min(1) }).strict(),
  z.object({ plot: z.number().int().nonnegative() }).strict(),
  z.object({ xz: z.tuple([z.number(), z.number()]) }).strict(),
]);

export const npcSpecSchema = z.object({
  /** Agent id (agt_…) — stable identity across trace + world log. */
  id: z.string().min(1),
  persona: z.object({
    name: z.string().min(1),
    /** The character voice — becomes the head of the agent's system prompt. */
    voice: z.string().min(1),
  }).strict(),
  spawn: npcSpawnSchema,
  /** Perception radius (world units) the engine surfaces nearby entities within. */
  perceptionRadius: z.number().positive().max(500).default(18),
  /** "npc.bundle" (the least-privilege NPC_ACTION_BUNDLE) or a PERMISSION_PROFILES name. */
  actionProfile: z.string().default(NPC_BUNDLE_PROFILE),
  /** Optional short goal lines woven into the system prompt (v1 = prompt only; v2 =
   *  first-class goal planning / memory). */
  goals: z.array(z.string()).optional(),
  model: z.object({
    provider: z.string().min(1), // "scripted" | "ollama" | …
    model: z.string(), // e.g. "qwen2.5:7b" ("" for scripted)
  }).strict(),
  /** Reasoning-LOD cadence: ticks between decisions (decisionIntervalTicks). */
  cadence: z.number().int().positive().max(600).default(30),
  /** Cosmetic humanoid clothing color (0xRRGGBB); derived from id when omitted. */
  color: z.number().int().nonnegative().optional(),
  /** Walk speed (world units / second); Locomotion default 1.6 when omitted. */
  speed: z.number().positive().optional(),
}).strict();

export type NpcSpec = z.infer<typeof npcSpecSchema>;

// ── Settlement spawn ─────────────────────────────────────────────────────────

/** The subset of a planVillage result an NPC spawner reads: building placements
 *  (role/plot -> world XZ + facing) plus an optional terrain height sampler so an
 *  NPC's feet rest on the ground. */
export interface SettlementSpawnContext {
  placements: Array<{ role: string; style?: string; index: number; x: number; z: number; yaw: number }>;
  center?: { x: number; z: number };
  /** Terrain height at (x,z); NPCs spawn with feet at this y. Default 0. */
  heightAt?: (x: number, z: number) => number;
}

/** How far in front of a building (along its facing) an NPC stands, so it is AT the
 *  door rather than clipping inside the footprint. */
const FRONT_OFFSET = 2.5;

/** A deterministic, id-derived clothing color so distinct NPCs read as distinct
 *  bodies without the author hand-picking one (djb2 over the id, masked to RGB). */
function colorFromId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  // Bias toward light, saturated clothing tones (avoid near-black).
  return 0x404040 | (h & 0x7f7f7f);
}

/** Resolve an NpcSpec spawn to a world position [x, y, z]. Role/plot need a
 *  settlement; xz is self-sufficient. Throws a clear error on an unresolved
 *  role/plot so a bad spec fails loudly rather than spawning at the origin. */
export function resolveSpawnPosition(spec: NpcSpec, settlement?: SettlementSpawnContext): [number, number, number] {
  const spawn = spec.spawn;
  const y = (x: number, z: number): number => settlement?.heightAt?.(x, z) ?? 0;
  if ("xz" in spawn) {
    const [x, z] = spawn.xz;
    return [x, y(x, z), z];
  }
  if (settlement === undefined) {
    throw new Error(`resolveSpawnPosition: NPC '${spec.id}' spawns by ${"role" in spawn ? "role" : "plot"} but no settlement was provided`);
  }
  const placement = "plot" in spawn
    ? settlement.placements[spawn.plot]
    : settlement.placements.find((p) => p.role === spawn.role);
  if (placement === undefined) {
    throw new Error(`resolveSpawnPosition: NPC '${spec.id}' — no settlement placement for ${JSON.stringify(spawn)}`);
  }
  // Stand FRONT_OFFSET out along the building's facing (local +Z -> [sin,cos]).
  const fx = Math.sin(placement.yaw);
  const fz = Math.cos(placement.yaw);
  const x = placement.x + fx * FRONT_OFFSET;
  const z = placement.z + fz * FRONT_OFFSET;
  return [x, y(x, z), z];
}

/** A live NPC: its spec, agent record, body, and spawn position. */
export interface SpawnedNpc {
  spec: NpcSpec;
  agentId: string;
  agent: AgentRecord;
  entityId: string;
  eid: number;
  humanoid: Humanoid;
  position: [number, number, number];
}

/** Spawn ONE NPC onto the running world: a procedural humanoid body, a Locomotion
 *  actor (deterministic walk), and an AgentRecord of type "npc" wired to the
 *  perception->decision->action engine with a least-privilege action bundle (or a
 *  named profile). The humanoid lands in world.entities, so perception surfaces it
 *  automatically — no manual spatial-index insert. */
export function spawnNpc(
  ctx: GameContext,
  agents: AgentRegistry,
  spec: NpcSpec,
  settlement?: SettlementSpawnContext,
): SpawnedNpc {
  const position = resolveSpawnPosition(spec, settlement);
  const body = spawnHumanoid(ctx.world, {
    color: spec.color ?? colorFromId(spec.id),
    position,
  });
  ctx.core.locomotion.add({
    agentId: spec.id,
    entityId: body.entityId,
    eid: body.eid,
    humanoid: body.humanoid,
    speed: spec.speed,
  });

  const useBundle = spec.actionProfile === NPC_BUNDLE_PROFILE;
  const agent = agents.add({
    id: spec.id,
    type: "npc",
    entityId: body.entityId,
    perceptionRadius: spec.perceptionRadius,
    decisionIntervalTicks: spec.cadence,
    // When the bundle governs grants, `profile` is identity/trace only (agentGrants
    // returns the bundle); "npc.agent" is the honest label for a reasoning NPC.
    profile: useBundle ? "npc.agent" : spec.actionProfile,
    bundle: useBundle ? NPC_ACTION_BUNDLE : undefined,
    sessionId: ctx.base.sessionId,
    llm: {
      provider: spec.model.provider,
      model: spec.model.model,
      systemPrompt: buildNpcSystemPrompt(spec),
    },
  });

  return { spec, agentId: spec.id, agent, entityId: body.entityId, eid: body.eid, humanoid: body.humanoid, position };
}

/** Spawn several NPCs from a settlement, in spec order (so entity ids are assigned
 *  deterministically). */
export function spawnNpcsFromSettlement(
  ctx: GameContext,
  agents: AgentRegistry,
  specs: NpcSpec[],
  settlement?: SettlementSpawnContext,
): SpawnedNpc[] {
  return specs.map((spec) => spawnNpc(ctx, agents, spec, settlement));
}

// ── System prompt ────────────────────────────────────────────────────────────

/** Build the NPC's system prompt: the persona voice, its goals, and a crisp
 *  description of the tiny action space plus an imperative to CALL exactly one tool
 *  (small local models otherwise narrate instead of acting). */
export function buildNpcSystemPrompt(spec: NpcSpec): string {
  const lines: string[] = [
    spec.persona.voice.trim(),
    "",
    `You are ${spec.persona.name}, an autonomous character living in a settlement.`,
    "Each turn you receive your perception as JSON: your own position and a `nearby`",
    "list of entities/characters with their ids and distances (metres). Decide ONE",
    "action for this turn by CALLING exactly one tool:",
    "  • social.approach({ target }) — walk toward a nearby character. Pass the",
    "    character's id from `nearby` (or a world point [x,y,z]).",
    "  • social.say({ text }) — speak a short line, in character.",
    "  • npc.memorize({ entity, key, value }) — remember a fact about someone you",
    "    met. Pass your OWN entity id, a short key, and a value (e.g. the id you saw).",
    "  • npc.setAttitude({ entity, towardEntity, attitude }) — set how you regard",
    "    another character (\"friendly\", \"neutral\", or \"hostile\"). Use your own id.",
  ];
  if (spec.goals !== undefined && spec.goals.length > 0) {
    lines.push("", "Your goals:");
    for (const g of spec.goals) lines.push(`  • ${g}`);
  }
  lines.push(
    "",
    "Behave naturally: approach a nearby character you have not reached yet, then",
    "greet them; keep lines short and in character. Do NOT narrate — CALL a tool.",
  );
  return lines.join("\n");
}

// ── Engine-A tick driver ─────────────────────────────────────────────────────

export interface NpcTickParams {
  ctx: GameContext;
  agents: AgentRegistry;
  providers: ProviderMap;
  scheduler: AgentScheduler;
  tracer: Tracer;
  tick: number;
  /** Fixed-step duration (ms) the Locomotion system advances by. */
  dtMs: number;
  /** Microtask drains between the (async) decision fire and the action drain, so a
   *  same-tick scripted decision enqueues before actionSystem runs. Default 8. */
  drain?: number;
}

/** Advance the NPC world ONE fixed step through the REAL agent engine:
 *  perception -> decision (off-loop provider) -> action (validated invoke) ->
 *  deterministic Locomotion walk -> spatial reindex. This is the exact
 *  perceptionSystem/decisionSystem/actionSystem pipeline the deterministic agent
 *  demos use; NPCs add no bespoke loop. `ctx.setTick` stamps the tick onto the
 *  recorder + base so recorded commands log at the right tick. */
export async function driveNpcTick(params: NpcTickParams): Promise<void> {
  const { ctx, agents, providers, scheduler, tracer, tick, dtMs } = params;
  ctx.setTick(tick);
  perceptionSystem(agents, ctx.world, tracer, tick);
  decisionSystem(agents, ctx.registry, providers, tracer, tick, scheduler);
  const drain = params.drain ?? 8;
  for (let d = 0; d < drain; d++) await Promise.resolve();
  await actionSystem(agents, ctx.registry, ctx.world, tick, scheduler);
  ctx.core.locomotion.step(ctx.world, dtMs);
  ctx.world.spatial?.invalidate();
}

// ── A deterministic ambient-social policy (for the determinism gate) ──────────

export interface AmbientPolicyOptions {
  /** Stop/greet threshold (metres): beyond it the NPC approaches; within it it
   *  speaks + gestures. Keep >= the Locomotion talkDistance so arrival is stable. */
  talkDistance?: number;
  /** agentId -> display name, for deterministic in-character greeting text. */
  nameByAgentId?: Record<string, string>;
}

/** A PURE, deterministic decision policy (no Math.random / Date) standing in for the
 *  LLM in the determinism gate: perceive the nearest other character and either walk
 *  to it (approach), or — once within talk range — greet it (say) and remember the
 *  meeting (npc.memorize). Because it is a pure function of perception, the
 *  ScriptedProvider wrapping it produces byte-identical decisions on every run — the
 *  ENGINE, not the model, is what the gate proves deterministic. */
export function makeAmbientSocialPolicy(opts: AmbientPolicyOptions = {}): (req: DecideRequest) => MCPRequest[] {
  const talk = opts.talkDistance ?? 2.0;
  const names = opts.nameByAgentId ?? {};
  return (req: DecideRequest): MCPRequest[] => {
    const p = req.perception;
    if (p.selfEntity === undefined || p.position === undefined) return [];
    const nearest = p.nearby[0];
    if (nearest === undefined) return []; // alone -> idle
    const selfName = names[p.selfId] ?? p.selfId;
    if (nearest.distance > talk) {
      // Walk toward the nearest character; announce the intent (drains over ticks).
      return [
        { tool: "social.approach", input: { target: nearest.id } },
        { tool: "social.say", input: { text: `${selfName}: well met, traveller.` } },
      ];
    }
    // Arrived: greet in character and remember who was met.
    return [
      { tool: "social.say", input: { text: `${selfName}: good to see you.` } },
      { tool: "npc.memorize", input: { entity: p.selfEntity, key: "met", value: nearest.id, source: p.selfId } },
    ];
  };
}
