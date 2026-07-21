// M13 (live smoke) — REASONING NPCs driven by a REAL local model.
//
// Three humanoid NPCs are spawned at a real settlement and run on Engine A
// (perceptionSystem -> decisionSystem -> actionSystem under the AgentScheduler) with
// their "brain" = the OllamaProvider on qwen2.5:7b (installed + running on this box).
// NOTHING is scripted: each NPC's perception is fed to the model, the model chooses a
// tool call from the least-privilege NPC action space (move / speak / remember), and
// the chosen, schema-valid, permitted call is EXECUTED through the registry and
// TRACED. This prints the actual perception -> decision -> action transcript so the
// reasoning is visible, not asserted away.
//
// HONEST FAILURE: if Ollama is unreachable the smoke prints "__LIMINA_SKIP__ …" and
// exits cleanly — it never fabricates a decision.
//
// Run: ./target/release/limina js/test/m13_npc_ollama.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import { OllamaProvider } from "../src/agents/llm.ts";
import type { ProviderMap } from "../src/agents/systems.ts";
import { perceptionSystem, decisionSystem, actionSystem } from "../src/agents/systems.ts";
import type { EngineEvent } from "../src/observability/event.ts";
import { planVillage } from "../src/world/pipeline/village-layout.mjs";
import { spawnNpcsFromSettlement, type NpcSpec, type SettlementSpawnContext } from "../src/agents/npc.ts";

const MODEL = "qwen2.5:7b";
const SESSION = "ses_npc_ollama";
const TICKS = 10;
const DT = 1000 / 30;
const CADENCE = 2; // decide every 2 ticks

function makeSampler() {
  const amp = 18, sigma = 34, half = 60;
  const heightAt = (x: number, z: number): number => amp * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
  const e = 1;
  const slopeAt = (x: number, z: number): number => Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return { heightAt, slopeAt, halfSize: half, seaLevel: -2, amplitude: amp };
}

function buildSettlement(): SettlementSpawnContext {
  const sampler = makeSampler();
  const steering = {
    buildings: [{ role: "longhall", style: "nordic", count: 1 }, { role: "cottage", style: "wattle", count: 3 }, { role: "watchtower", style: "timber", count: 1 }],
    layout: { focal: "longhall on the knoll", density: "tight" },
  };
  // deno-lint-ignore no-explicit-any
  const village = (planVillage as any)(sampler, { palette: {}, mood: "weathered" }, steering, [8.5, 5.1, 5.1, 5.1, 7.0]) as { placements: SettlementSpawnContext["placements"] };
  return { placements: village.placements };
}

const specs: NpcSpec[] = [
  { id: "agt_birch", persona: { name: "Birch", voice: "You are Birch, a gruff old warden of the settlement: terse and wary, but fair." }, spawn: { plot: 1 }, perceptionRadius: 40, actionProfile: "npc.bundle", goals: ["Keep an eye on newcomers near the hall."], model: { provider: "ollama", model: MODEL }, cadence: CADENCE, speed: 2.2 },
  { id: "agt_willow", persona: { name: "Willow", voice: "You are Willow, a gentle herbalist who tends the cottages: warm and curious." }, spawn: { plot: 2 }, perceptionRadius: 40, actionProfile: "npc.bundle", goals: ["Greet the people you share the lane with."], model: { provider: "ollama", model: MODEL }, cadence: CADENCE, speed: 2.2 },
  { id: "agt_rowan", persona: { name: "Rowan", voice: "You are Rowan, a restless young lookout from the watchtower: eager and talkative." }, spawn: { plot: 4 }, perceptionRadius: 40, actionProfile: "npc.bundle", goals: ["Find someone to talk to."], model: { provider: "ollama", model: MODEL }, cadence: CADENCE, speed: 2.2 },
];

/** Reachability pre-flight: one tiny decide call. Returns false (skip) on a transport
 *  error so a missing local model is surfaced honestly, never fabricated. */
async function ollamaReachable(): Promise<{ ok: true } | { ok: false; msg: string }> {
  try {
    await new OllamaProvider(MODEL).decide({ systemPrompt: "reply with nothing", perception: { selfId: "agt_probe", nearby: [], recentEvents: [], tick: 0 }, tools: [], previousResults: [] });
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const reach = await ollamaReachable();
  if (!reach.ok) {
    ops.op_log(`__LIMINA_SKIP__ m13_npc_ollama: Ollama ${MODEL} unreachable (${reach.msg}); not fabricating a run.`);
    return; // clean exit 0 — an environment gap, not a code failure
  }
  ops.op_log(`M13: Ollama ${MODEL} reachable — running live reasoning smoke`);

  const settlement = buildSettlement();
  const agents = new AgentRegistry();
  const ctx = createHeadlessContext({ session: SESSION, agentId: "agt_settlement", agents });
  const spawned = spawnNpcsFromSettlement(ctx, agents, specs, settlement);
  const nameByEntity = new Map(spawned.map((n) => [n.entityId, n.spec.persona.name]));
  const nameByAgent = new Map(spawned.map((n) => [n.agentId, n.spec.persona.name]));
  const nm = (id: string): string => nameByEntity.get(id) ?? nameByAgent.get(id) ?? id.slice(-6);

  const providers: ProviderMap = { ollama: new OllamaProvider(MODEL) };
  const scheduler = new AgentScheduler({
    defaultAgentBudget: { weight: 1, maxQueueDepth: 4, maxToolCallsPerDecision: 2, maxActionsPerTick: 2, decisionTimeoutMs: 30000 },
  });

  const awaitDecisions = async (timeoutMs: number): Promise<void> => {
    const start = Date.now();
    while (agents.all().some((a) => a.inFlight) && Date.now() - start < timeoutMs) {
      await ops.op_sleep_ms(60);
    }
  };

  const fmt = (ev: EngineEvent): string | undefined => {
    const who = nm(ev.actorId);
    const p = ev.payload as Record<string, unknown> | null;
    const get = (k: string): unknown => (p && k in p ? p[k] : undefined);
    switch (ev.type) {
      case "social.approached": return `    ${who} -> social.approach(${nm(String(get("target")))})   [MOVE]`;
      case "social.said": return `    ${who} -> social.say: "${String(get("text"))}"   [SPEAK]`;
      case "npc.memorized": return `    ${who} -> npc.memorize(${String(get("key"))})   [REMEMBER]`;
      case "npc.attitudeSet": return `    ${who} -> npc.setAttitude(${nm(String(get("toward")))} = ${String(get("attitude"))})   [REMEMBER]`;
      case "agent.toolcall.rejected": return `    ${who} x rejected ${String(get("tool"))} (${String(get("reason"))})`;
      default: return undefined;
    }
  };

  ops.op_log(`M13: 3 NPCs spawned at settlement plots; running ${TICKS} ticks of live ${MODEL} reasoning...`);
  let cursor = 0;
  let realActions = 0;
  let rejects = 0;

  for (let tick = 1; tick <= TICKS; tick++) {
    ctx.setTick(tick);
    perceptionSystem(agents, ctx.world, ctx.tracer, tick);

    for (const a of agents.all()) {
      if (a.perception === undefined || a.inFlight) continue;
      if ((tick - a.lastDecisionTick) < a.decisionIntervalTicks) continue;
      const near = a.perception.nearby.slice(0, 3).map((e) => `${nm(e.id)} @ ${e.distance.toFixed(1)}m`).join(", ");
      ops.op_log(`[t${tick}] ${nm(a.id)} perceives: ${near.length > 0 ? near : "(no one nearby)"}`);
    }

    decisionSystem(agents, ctx.registry, providers, ctx.tracer, tick, scheduler);
    await awaitDecisions(30000);
    await actionSystem(agents, ctx.registry, ctx.world, tick, scheduler);
    ctx.core.locomotion.step(ctx.world, DT);
    ctx.world.spatial?.invalidate();

    const { events, nextAfterSeq } = ctx.tracer.tail({ afterSeq: cursor, limit: 2000 });
    for (const ev of events) {
      const line = fmt(ev);
      if (line === undefined) continue;
      ops.op_log(line);
      if (ev.type === "agent.toolcall.rejected") rejects++;
      else realActions++;
    }
    cursor = nextAfterSeq ?? cursor;
  }

  if (realActions === 0) {
    throw new Error(`m13_npc_ollama: the live model produced ZERO executed NPC actions in ${TICKS} ticks (rejects=${rejects}); reasoning smoke FAILED`);
  }
  ops.op_log(`M13 OK: ${realActions} REAL model-chosen NPC actions executed (move/speak/remember) over ${TICKS} ticks via live ${MODEL} (${rejects} malformed calls correctly rejected by the engine).`);
}

await main();
