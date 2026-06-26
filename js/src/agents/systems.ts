// Agent systems run under the fixed-timestep scheduler. Perception + Action are
// on-frame (deterministic); Decision fires the (slow, async) provider OFF the
// frame path and enqueues validated tool calls when it resolves.

import { Position } from "../ecs/world.ts";
import { ops } from "../engine.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { Tracer } from "../observability/event.ts";
import { agentGrants } from "./agent.ts";
import type { AgentRecord, AgentRegistry, PerceivedEntity, Perception } from "./agent.ts";
import type { LLMProvider } from "./llm.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import { type AgentScheduler, defaultAgentScheduler } from "./scheduler.ts";
import { querySpatialEntities } from "../spatial/index.ts";

export type ProviderMap = Record<string, LLMProvider>;

function dueForDecision(agent: AgentRecord, tick: number): boolean {
  return tick - agent.lastDecisionTick >= agent.decisionIntervalTicks;
}

/** A native-batched spatial result for one due agent: its self position and the
 *  `nearby` list — byte-identical to the per-agent JS query — reconstructed from
 *  a single `op_ecs_spatial_query_batch` call. */
interface BatchedNearby {
  selfPos: [number, number, number];
  nearby: PerceivedEntity[];
}

/** Build one agent's perception. `batched` (when supplied by the native batch)
 *  carries the precomputed self position + nearby list; otherwise this falls back
 *  to the per-agent JS grid query (the determinism oracle / agents with no
 *  resolvable position). The perception envelope + recentEvents are assembled in
 *  one place so the native and fallback paths are byte-identical. */
function buildPerception(
  agent: AgentRecord,
  world: WorldContext,
  tracer: Tracer,
  tick: number,
  batched?: BatchedNearby,
): Perception {
  let selfPos = batched?.selfPos;
  let nearby = batched?.nearby;
  if (nearby === undefined) {
    if (agent.entityId !== undefined) {
      const e = world.entities.resolve(agent.entityId);
      if (e !== undefined) selfPos = [Position.x[e.eid], Position.y[e.eid], Position.z[e.eid]];
    }
    nearby = querySpatialEntities(world, {
      near: selfPos,
      radius: selfPos === undefined ? undefined : agent.perceptionRadius,
      excludeEntity: agent.entityId,
      sortBy: "distance",
    }).entities.map((entity) => ({ id: entity.entity, position: entity.position, distance: entity.distance }));
  }
  const recentEvents = tracer.trace(agent.id).slice(-5).map((e) => ({ type: e.type }));
  return { selfId: agent.id, selfEntity: agent.entityId, position: selfPos, nearby, recentEvents, tick };
}

/** Serve every due agent's spatial query with ONE native grid build + batched
 *  radius query (replacing one `querySpatialEntities` per agent) when a
 *  `UniformGridSpatialIndex` is present. Each agent's `nearby` is rebuilt with the
 *  SAME f64 distance math and insertion-order tiebreak as the oracle, so
 *  perception stays bit-identical. Agents with no resolvable self position — or
 *  every agent when no index exists — are left to `buildPerception`'s JS path.
 *  Returns `undefined` when nothing is batchable. */
function batchPerception(
  all: AgentRecord[],
  world: WorldContext,
  tick: number,
): Map<AgentRecord, BatchedNearby> | undefined {
  const spatial = world.spatial;
  if (spatial === undefined) return undefined;
  const targets: { agent: AgentRecord; eid: number; selfPos: [number, number, number] }[] = [];
  for (const agent of all) {
    if (!dueForDecision(agent, tick) || agent.inFlight) continue;
    if (agent.entityId === undefined) continue;
    const entry = world.entities.resolve(agent.entityId);
    if (entry === undefined) continue;
    targets.push({ agent, eid: entry.eid, selfPos: [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]] });
  }
  if (targets.length === 0) return undefined;

  // orderedEids[order] = eid + a reverse eid->ent_ map, built in world.entities.ids()
  // order so the op's `order` tiebreak matches the oracle's compareRecordOrder.
  const ids = world.entities.ids();
  const orderedEids = new Uint32Array(ids.length);
  const reverse = new Map<number, string>();
  let n = 0;
  for (const id of ids) {
    const entry = world.entities.resolve(id);
    if (entry === undefined) continue;
    orderedEids[n++] = entry.eid;
    reverse.set(entry.eid, id);
  }
  const ordered = n === ids.length ? orderedEids : orderedEids.subarray(0, n);

  // maxHits = active-entity count: a query can match at most every entity, so it
  // can never truncate (count <= n). The per-query guard still drops any over-cap
  // result to the JS fallback, keeping correctness if that invariant ever changes.
  const maxHits = n;
  const stride = 1 + maxHits;
  const queries = new Float64Array(targets.length * 5);
  for (let q = 0; q < targets.length; q++) {
    const t = targets[q];
    queries[q * 5] = t.selfPos[0];
    queries[q * 5 + 1] = t.selfPos[1];
    queries[q * 5 + 2] = t.selfPos[2];
    queries[q * 5 + 3] = t.agent.perceptionRadius;
    queries[q * 5 + 4] = t.eid; // exclude self
  }
  const out = new Uint32Array(targets.length * stride);
  ops.op_ecs_spatial_query_batch(Position.x, Position.y, Position.z, ordered, spatial.cellSize, queries, maxHits, out);

  const result = new Map<AgentRecord, BatchedNearby>();
  for (let q = 0; q < targets.length; q++) {
    const base = q * stride;
    const count = out[base];
    if (count > maxHits) continue; // truncated -> leave this agent for the JS fallback
    const selfPos = targets[q].selfPos;
    const nearby: PerceivedEntity[] = [];
    for (let i = 0; i < count; i++) {
      const eid = out[base + 1 + i];
      const hx = Position.x[eid];
      const hy = Position.y[eid];
      const hz = Position.z[eid];
      const dx = hx - selfPos[0];
      const dy = hy - selfPos[1];
      const dz = hz - selfPos[2];
      nearby.push({ id: reverse.get(eid)!, position: [hx, hy, hz], distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }
    result.set(targets[q].agent, { selfPos, nearby });
  }
  return result;
}

/** Populate perception only when a decision is due (avoids O(agents*entities) every tick). */
export function perceptionSystem(agents: AgentRegistry, world: WorldContext, tracer: Tracer, tick: number): void {
  const all = agents.all();
  const batched = batchPerception(all, world, tick);
  for (const agent of all) {
    if (!dueForDecision(agent, tick) || agent.inFlight) continue;
    agent.perception = buildPerception(agent, world, tracer, tick, batched?.get(agent));
    agent.lastPerceptionEventId = tracer.emit({
      type: "agent.perception.updated",
      actorId: agent.id,
      threadId: agent.sessionId,
      parentEventId: null,
      causedBy: [],
      payload: { nearby: agent.perception.nearby.length, tick },
    });
  }
}

/** Fire the provider async (off-loop); validate + enqueue on resolve. */
export function decisionSystem(
  agents: AgentRegistry,
  registry: SkillRegistry,
  providers: ProviderMap,
  tracer: Tracer,
  tick: number,
  scheduler: AgentScheduler = defaultAgentScheduler,
): void {
  scheduler.sweepDecisionTimeouts(agents.all(), tick, tracer);
  const admitted = scheduler.admitDecisions(agents.all(), tick, tracer, (agent) => dueForDecision(agent, tick));
  for (const { agent, generation } of admitted) {
    const provider = providers[agent.llm.provider];
    if (provider === undefined) {
      scheduler.failDecision(agent, generation);
      continue;
    }

    agent.inFlight = true;
    agent.lastDecisionTick = tick;
    scheduler.armDecisionTimeout(agent, generation);
    const decisionId = tracer.emit({
      type: "agent.decision.made",
      actorId: agent.id,
      threadId: agent.sessionId,
      parentEventId: null,
      causedBy: agent.lastPerceptionEventId !== undefined ? [agent.lastPerceptionEventId] : [],
      payload: { tick, provider: agent.llm.provider },
    });
    const tools = registry.list(agentGrants(agent));

    provider
      .decide({ systemPrompt: agent.llm.systemPrompt, perception: agent.perception, tools, previousResults: [] })
      .then(({ toolCalls }) => {
        const calls = toolCalls.map((call) => {
          const skill = registry.describe(call.tool);
          if (skill === undefined) {
            return {
              req: { tool: call.tool, input: call.input },
              valid: false,
              reject: () => tracer.emit({ type: "agent.toolcall.rejected", actorId: agent.id, threadId: agent.sessionId, parentEventId: null, causedBy: [decisionId], payload: { reason: "unknown_tool", tool: call.tool } }),
            };
          }
          if (!skill.input.safeParse(call.input).success) {
            return {
              req: { tool: call.tool, input: call.input },
              valid: false,
              reject: () => tracer.emit({ type: "agent.toolcall.rejected", actorId: agent.id, threadId: agent.sessionId, parentEventId: null, causedBy: [decisionId], payload: { reason: "invalid_args", tool: call.tool } }),
            };
          }
          return { req: { tool: call.tool, input: call.input }, valid: true };
        });
        scheduler.enqueueDecisionToolCalls(agent, generation, decisionId, calls, tracer, tick);
      })
      .catch((err: unknown) => {
        if (!scheduler.failDecision(agent, generation)) return;
        tracer.emit({ type: "agent.toolcall.rejected", actorId: agent.id, threadId: agent.sessionId, parentEventId: null, causedBy: [decisionId], payload: { reason: "provider_error", message: err instanceof Error ? err.message : String(err) } });
      });
  }
}

/** Drain one validated action per agent per tick through the registry (so player
 *  actions get the same permission/trace path as builders). */
export async function actionSystem(
  agents: AgentRegistry,
  registry: SkillRegistry,
  world: WorldContext,
  tick: number,
  scheduler: AgentScheduler = defaultAgentScheduler,
): Promise<void> {
  let globalExecuted = 0;
  const orderedAgents = agents.all().sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of orderedAgents) {
    while (agent.queue.length > 0 && scheduler.canExecuteAction(agent, tick, globalExecuted, registry.tracer)) {
      const action = agent.queue.shift();
      if (action === undefined) break;
      const response = await registry.invoke(action.req.tool, action.req.input, {
        agentId: agent.id,
        sessionId: agent.sessionId,
        permissions: agentGrants(agent),
        profile: agent.profile,
        tick,
        world,
        causedBy: [action.decisionId],
      });
      globalExecuted++;
      scheduler.emitActionExecuted(registry.tracer, agent, tick, action.req.tool, action.decisionId, response.success);
    }
  }
}

export interface BoundedMultiTurnOptions {
  startTick: number;
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxTokens?: number;
}

export interface BoundedMultiTurnResult {
  steps: number;
  toolCalls: number;
  tokensUsed: number;
  reason: "no_tool_calls" | "max_steps" | "max_tool_calls" | "timeout" | "token_budget" | "provider_missing";
}

function elapsed(start: number): number {
  return Date.now() - start;
}

function tokenUsage(res: { usage?: { totalTokens?: number } }): number {
  return typeof res.usage?.totalTokens === "number" && Number.isFinite(res.usage.totalTokens)
    ? Math.max(0, res.usage.totalTokens)
    : 0;
}

function timeoutAfter(ms: number): Promise<"timeout"> {
  return ops.op_sleep_ms(Math.max(0, Math.ceil(ms))).then(() => "timeout" as const);
}

async function decideWithTimeout(
  provider: LLMProvider,
  req: Parameters<LLMProvider["decide"]>[0],
  remainingMs: number,
): Promise<Awaited<ReturnType<LLMProvider["decide"]>> | "timeout"> {
  if (remainingMs <= 0) return "timeout";
  return await Promise.race([provider.decide(req), timeoutAfter(remainingMs)]);
}

function emitToolResult(tracer: Tracer, agent: AgentRecord, response: MCPResponse, causedBy: string[]): string {
  return tracer.emit({
    type: "agent.tool_result",
    actorId: agent.id,
    threadId: agent.sessionId,
    parentEventId: null,
    causedBy,
    payload: { success: response.success, error: response.error?.code },
  });
}

/** Run a bounded provider -> tool-result -> perception loop for external and
 *  player agents that need more than one decision before yielding control. */
export async function runBoundedMultiTurn(
  agent: AgentRecord,
  registry: SkillRegistry,
  providers: ProviderMap,
  world: WorldContext,
  tracer: Tracer,
  options: BoundedMultiTurnOptions,
): Promise<BoundedMultiTurnResult> {
  const provider = providers[agent.llm.provider];
  if (provider === undefined) return { steps: 0, toolCalls: 0, tokensUsed: 0, reason: "provider_missing" };

  const start = Date.now();
  const previousResults: unknown[] = [];
  let lastToolResultId: string | undefined;
  let steps = 0;
  let toolCalls = 0;
  let tokensUsed = 0;

  for (; steps < options.maxSteps; steps++) {
    if (elapsed(start) >= options.timeoutMs) return { steps, toolCalls, tokensUsed, reason: "timeout" };
    if (toolCalls >= options.maxToolCalls) return { steps, toolCalls, tokensUsed, reason: "max_tool_calls" };
    if (options.maxTokens !== undefined && tokensUsed >= options.maxTokens) {
      return { steps, toolCalls, tokensUsed, reason: "token_budget" };
    }

    const tick = options.startTick + steps;
    agent.perception = buildPerception(agent, world, tracer, tick);
    agent.lastPerceptionEventId = tracer.emit({
      type: "agent.perception.updated",
      actorId: agent.id,
      threadId: agent.sessionId,
      parentEventId: null,
      causedBy: lastToolResultId === undefined ? [] : [lastToolResultId],
      payload: { nearby: agent.perception.nearby.length, tick, turnStep: steps },
    });

    const decisionCauses = lastToolResultId === undefined
      ? [agent.lastPerceptionEventId]
      : [agent.lastPerceptionEventId, lastToolResultId];
    const decisionId = tracer.emit({
      type: "agent.decision.made",
      actorId: agent.id,
      threadId: agent.sessionId,
      parentEventId: null,
      causedBy: decisionCauses,
      payload: { tick, provider: agent.llm.provider, turnStep: steps },
    });

    const decision = await decideWithTimeout(provider, {
      systemPrompt: agent.llm.systemPrompt,
      perception: agent.perception,
      tools: registry.list(agentGrants(agent)),
      previousResults: [...previousResults],
    }, options.timeoutMs - elapsed(start));
    if (decision === "timeout") {
      return { steps: steps + 1, toolCalls, tokensUsed, reason: "timeout" };
    }
    tokensUsed += tokenUsage(decision);
    if (options.maxTokens !== undefined && tokensUsed > options.maxTokens) {
      return { steps: steps + 1, toolCalls, tokensUsed, reason: "token_budget" };
    }
    if (decision.toolCalls.length === 0) {
      return { steps: steps + 1, toolCalls, tokensUsed, reason: "no_tool_calls" };
    }

    for (const call of decision.toolCalls) {
      if (elapsed(start) >= options.timeoutMs) return { steps: steps + 1, toolCalls, tokensUsed, reason: "timeout" };
      if (toolCalls >= options.maxToolCalls) return { steps: steps + 1, toolCalls, tokensUsed, reason: "max_tool_calls" };
      const skill = registry.describe(call.tool);
      if (skill === undefined) {
        const rejected = tracer.emit({ type: "agent.toolcall.rejected", actorId: agent.id, threadId: agent.sessionId, parentEventId: null, causedBy: [decisionId], payload: { reason: "unknown_tool", tool: call.tool } });
        lastToolResultId = rejected;
        previousResults.push({ success: false, error: { code: "not_found", message: `unknown skill: ${call.tool}` } });
        continue;
      }
      if (!skill.input.safeParse(call.input).success) {
        const rejected = tracer.emit({ type: "agent.toolcall.rejected", actorId: agent.id, threadId: agent.sessionId, parentEventId: null, causedBy: [decisionId], payload: { reason: "invalid_args", tool: call.tool } });
        lastToolResultId = rejected;
        previousResults.push({ success: false, error: { code: "invalid_input", message: `invalid input: ${call.tool}` } });
        continue;
      }
      const response = await registry.invoke(call.tool, call.input, {
        agentId: agent.id,
        sessionId: agent.sessionId,
        permissions: agentGrants(agent),
        profile: agent.profile,
        tick,
        world,
        causedBy: [decisionId],
      });
      toolCalls++;
      lastToolResultId = emitToolResult(tracer, agent, response, response.metadata?.eventsEmitted.length ? [decisionId, ...response.metadata.eventsEmitted] : [decisionId]);
      previousResults.push(response);
    }
  }
  return { steps, toolCalls, tokensUsed, reason: "max_steps" };
}
