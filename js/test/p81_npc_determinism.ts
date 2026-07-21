// P81 — REASONING NPCs are DETERMINISTIC through the engine.
//
// NPCs run on Engine A (perceptionSystem -> decisionSystem -> actionSystem under the
// AgentScheduler). The real LLM brain is non-deterministic BY DESIGN, so this gate
// swaps in a ScriptedProvider (a PURE ambient-social policy) and proves the ENGINE —
// perceive -> validate -> act -> RECORD — is bit-deterministic and replay-faithful:
//
//   1. Run the NPC loop twice, independently, over a fixed seed + fixed spawn. Assert
//      the recorded world-log (recorder.toJsonl) AND the captured world state
//      (captureWorldState) are BYTE-IDENTICAL between the two runs. This falsifies
//      any hidden nondeterminism in perception, decision admission, action draining,
//      Locomotion, or recording.
//   2. REPLAY run-A's recorded skill-call stream into a fresh, identically-spawned
//      world — re-applying each recorded social.approach/say/emote at its recorded
//      tick, then stepping the deterministic Locomotion, with NO provider/perception/
//      decision ever running (the model is NEVER re-run). Assert the replayed world
//      state + re-recorded log match run A exactly. This is the world-log replay
//      contract: the ordered skill stream reproduces the world without the LLM.
//
// Spawn is from a real planVillage settlement (the same pure layout p76 gates), so
// perception surfaces the built world, not hand-placed constants.
//
// Run: ./target/release/limina js/test/p81_npc_determinism.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import { ScriptedProvider } from "../src/agents/llm.ts";
import type { ProviderMap } from "../src/agents/systems.ts";
import { captureWorldState, compareWorldState, type WorldStateSnapshot } from "../src/worldlog/log.ts";
import type { SkillCommand, WorldCommand } from "../src/worldlog/log.ts";
import { planVillage } from "../src/world/pipeline/village-layout.mjs";
import {
  driveNpcTick,
  makeAmbientSocialPolicy,
  spawnNpcsFromSettlement,
  type NpcSpec,
  type SettlementSpawnContext,
} from "../src/agents/npc.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p81_npc_determinism: " + msg);
}

const SEED = 0x0badf00d;
const SESSION = "ses_npc_det";
const TICKS = 220;
const DT = 1000 / 30; // 30 fixed steps/s

// ── A deterministic analytic terrain + settlement (mirrors p76's knoll) ───────
function makeSampler() {
  const amp = 18, sigma = 34, half = 60;
  const heightAt = (x: number, z: number): number => amp * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
  const e = 1;
  const slopeAt = (x: number, z: number): number => {
    const hx = heightAt(x + e, z) - heightAt(x - e, z);
    const hz = heightAt(x, z + e) - heightAt(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  };
  return { heightAt, slopeAt, halfSize: half, seaLevel: -2, amplitude: amp };
}
const sampler = makeSampler();
const direction = { palette: { stone: "#9b9890", timber: "#5c4632" }, mood: "weathered, lived-in" };
const steering = {
  buildings: [
    { role: "longhall", style: "nordic", count: 1 },
    { role: "cottage", style: "wattle-and-daub", count: 3 },
    { role: "watchtower", style: "timber", count: 1 },
  ],
  layout: { focal: "longhall on the high knoll", density: "tight" },
};
const radii = [8.5, 5.1, 5.1, 5.1, 7.0];
// deno-lint-ignore no-explicit-any
const village = (planVillage as any)(sampler, direction, steering, radii) as { placements: SettlementSpawnContext["placements"]; center: { x: number; z: number } };
assert(village.placements.length >= 3, `settlement must yield >=3 plots, got ${village.placements.length}`);
// NPCs stand on flat ground (y=0) so perception distance == planar distance; the
// knoll sampler still drives the (spread) settlement LAYOUT above. (Terrain-follow
// spawn is available via heightAt; a flat spawn keeps this gate's distances clean.)
const settlement: SettlementSpawnContext = { placements: village.placements, center: village.center };

// ── Three NPCs spawned at real settlement plots ───────────────────────────────
const specs: NpcSpec[] = [
  {
    id: "agt_birch", persona: { name: "Birch", voice: "A gruff old warden of the settlement." },
    spawn: { plot: 1 }, perceptionRadius: 40, actionProfile: "npc.bundle",
    model: { provider: "scripted", model: "" }, cadence: 3, speed: 4.0,
  },
  {
    id: "agt_willow", persona: { name: "Willow", voice: "A gentle herbalist who tends the cottages." },
    spawn: { plot: 2 }, perceptionRadius: 40, actionProfile: "npc.bundle",
    model: { provider: "scripted", model: "" }, cadence: 3, speed: 4.0,
  },
  {
    id: "agt_rowan", persona: { name: "Rowan", voice: "A restless young lookout from the watchtower." },
    spawn: { plot: 4 }, perceptionRadius: 40, actionProfile: "npc.bundle",
    model: { provider: "scripted", model: "" }, cadence: 3, speed: 4.0,
  },
];
const nameByAgentId = Object.fromEntries(specs.map((s) => [s.id, s.persona.name]));
const policy = makeAmbientSocialPolicy({ talkDistance: 2.0, nameByAgentId });

interface RunResult {
  jsonl: string;
  state: WorldStateSnapshot;
  commands: WorldCommand[];
  moved: number; // total planar displacement of all NPCs (proves motion happened)
}

/** One full LIVE run through Engine A with a recorder attached. */
async function runLive(): Promise<RunResult> {
  const agents = new AgentRegistry();
  const ctx = createHeadlessContext({ session: SESSION, agentId: "agt_settlement", agents, record: { seed: SEED } });
  const spawned = spawnNpcsFromSettlement(ctx, agents, specs, settlement);
  const spawnState = captureWorldState(ctx.world);
  const providers: ProviderMap = { scripted: new ScriptedProvider(policy) };
  const scheduler = new AgentScheduler({
    defaultAgentBudget: { weight: 1, maxQueueDepth: 8, maxToolCallsPerDecision: 4, maxActionsPerTick: 2, decisionTimeoutMs: Number.POSITIVE_INFINITY },
  });
  for (let tick = 1; tick <= TICKS; tick++) {
    await driveNpcTick({ ctx, agents, providers, scheduler, tracer: ctx.tracer, tick, dtMs: DT });
  }
  const endState = captureWorldState(ctx.world);
  // Total NPC displacement from spawn (a nonzero value proves the loop moved bodies).
  let moved = 0;
  for (const npc of spawned) {
    const a = spawnState.entities.find((e) => e.id === npc.entityId)!;
    const b = endState.entities.find((e) => e.id === npc.entityId)!;
    moved += Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
  }
  return { jsonl: ctx.recorder!.toJsonl(), state: endState, commands: ctx.recorder!.commands.slice(), moved };
}

/** REPLAY: re-apply run-A's recorded skill calls at their recorded ticks into a
 *  fresh, identically-spawned world, stepping deterministic Locomotion — NEVER
 *  running a provider/perception/decision. Proves the recorded call stream alone
 *  (no LLM) reconstructs the world. */
async function runReplay(recorded: WorldCommand[]): Promise<RunResult> {
  const agents = new AgentRegistry();
  const ctx = createHeadlessContext({ session: SESSION, agentId: "agt_settlement", agents, record: { seed: SEED } });
  spawnNpcsFromSettlement(ctx, agents, specs, settlement); // same spawn -> same entities/positions
  // Group recorded skill calls by tick, preserving recorded (seq) order.
  const byTick = new Map<number, SkillCommand[]>();
  for (const cmd of recorded) {
    if (cmd.kind !== "skill") continue;
    const list = byTick.get(cmd.tick);
    if (list === undefined) byTick.set(cmd.tick, [cmd]);
    else list.push(cmd);
  }
  for (let tick = 1; tick <= TICKS; tick++) {
    ctx.setTick(tick);
    for (const cmd of byTick.get(tick) ?? []) {
      const res = await ctx.registry.invoke(cmd.tool, cmd.input, {
        agentId: cmd.actorId,
        sessionId: cmd.sessionId,
        permissions: new Set(cmd.perms),
        tick,
        world: ctx.world,
      });
      assert(res.success, `replay invoke of ${cmd.tool} @tick ${tick} failed: ${JSON.stringify(res.error)}`);
    }
    ctx.core.locomotion.step(ctx.world, DT);
    ctx.world.spatial?.invalidate();
  }
  return { jsonl: ctx.recorder!.toJsonl(), state: captureWorldState(ctx.world), commands: ctx.recorder!.commands.slice(), moved: 0 };
}

// ── Run + assert ──────────────────────────────────────────────────────────────
const runA = await runLive();
const runB = await runLive();

// The NPCs genuinely acted: the recorded stream is non-empty and exercises all three
// verbs (move / speak / gesture), and the bodies actually moved.
const tools = new Set(runA.commands.filter((c): c is SkillCommand => c.kind === "skill").map((c) => c.tool));
assert(runA.commands.some((c) => c.kind === "skill"), "run recorded no NPC skill calls — the loop did nothing");
assert(tools.has("social.approach"), "expected recorded social.approach (move)");
assert(tools.has("social.say"), "expected recorded social.say (speak)");
assert(tools.has("npc.memorize"), "expected recorded npc.memorize (interaction) — NPCs never reached talk range");
assert(runA.moved > 1, `NPCs must move through the world; total displacement was ${runA.moved.toFixed(3)}m`);

// 1) Two independent live runs are byte-identical (recorded stream + world state).
assert(runA.jsonl === runB.jsonl, "recorded world-log diverged between two identical live runs (nondeterministic decision/action/record)");
const liveCmp = compareWorldState(runA.state, runB.state);
assert(liveCmp.identical, `world state diverged between two identical live runs (${liveCmp.comparisons} fields): ${liveCmp.detail ?? "?"}`);

// 2) Replaying run-A's recorded calls (no model) reproduces run A exactly.
const replay = await runReplay(runA.commands);
const replayCmp = compareWorldState(runA.state, replay.state);
assert(replayCmp.identical, `replay world state diverged from the live run (${replayCmp.comparisons} fields): ${replayCmp.detail ?? "?"}`);
assert(runA.jsonl === replay.jsonl, "re-recorded log from replaying the calls diverged from the live log");

// 3) Falsifiability: perturbing one recorded input must break replay (proves the
//    comparison actually bites — it is not vacuously passing).
const perturbed = runA.commands.map((c) => {
  if (c.kind === "skill" && c.tool === "social.approach") {
    const inp = c.input as { target?: unknown };
    if (Array.isArray(inp.target)) return c;
    // Redirect one approach to a far world point; its walker ends up elsewhere.
    return { ...c, input: { target: [40, 0, 40] } };
  }
  return c;
});
const perturbedReplay = await runReplay(perturbed);
const perturbedCmp = compareWorldState(runA.state, perturbedReplay.state);
assert(!perturbedCmp.identical, "perturbing a recorded approach target did NOT change the world — the determinism check is vacuous");

const skillCount = runA.commands.filter((c) => c.kind === "skill").length;
ops.op_log(
  `[js] p81_npc_determinism OK: 3 reasoning NPCs on Engine A over ${TICKS} ticks — ` +
  `${skillCount} recorded skill calls (move/speak/remember), ${runA.moved.toFixed(1)}m total motion; ` +
  `two live runs byte-identical (log + world state); recorded call-stream replays WITHOUT the model to a ` +
  `bit-identical world (${replayCmp.comparisons} fields checked); perturbation falsifies the check.`,
);
