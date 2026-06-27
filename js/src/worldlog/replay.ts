// limina world-log REPLAY harness -- rebuilds final world state from a persisted
// world log ALONE, into a FRESH engine, with NO reuse of the original run's
// in-memory or final-snapshot state (Phase 4 global anti-hack rule).
//
// Replay re-applies the authoritative command stream (see log.ts) in seq order:
//   - seed     -> re-install the SAME seeded PRNG (Math.random).
//   - physics  -> call the native op directly on the fresh world; `step` also
//                 runs the per-tick engine rule (sync all body transforms into
//                 ECS), exactly as the windowed loop does after op_physics_step.
//   - skill    -> RE-INVOKE the recorded tool call through the registry. This is
//                 how recorded AGENT ACTIONS are reproduced WITHOUT re-running any
//                 LLM / scripted decision provider -- replay never constructs
//                 agents, perception, decisions, or providers at all.
//
// The caller supplies factories for a fresh world + registry (the SAME skill set
// the recording used -- skills are code, the log carries invocations). Replay
// zeroes the JS-owned transform SoA before applying anything, so any entity it
// fails to rebuild reads back as 0 and is caught by the bit-identical check.

import { Position, Rotation, Scale } from "../ecs/world.ts";
import { LiminaTracer, type Tracer } from "../observability/event.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import {
  captureWorldState,
  installSeededRandom,
  parseWorldLog,
  PHYSICS_OP_FN,
  PHYSICS_OP_OUT_BUFFER,
  syncAllBodies,
  type WorldCommand,
  type WorldStateSnapshot,
} from "./log.ts";

export interface ReplayDeps {
  /** Build a fresh, empty world (new bitECS world + entity table + stub or real
   *  scene/camera). Its `ops` MUST target the same native physics OpState the
   *  `create_world` command resets. */
  makeWorld: () => WorldContext;
  /** Build a registry with the SAME skills registered as the recording. */
  makeRegistry: (tracer: Tracer) => SkillRegistry;
  /** Optional tracer; replay creates a throwaway one when omitted. */
  tracer?: Tracer;
}

export interface ReplayResult {
  state: WorldStateSnapshot;
  /** Highest tick observed across replayed commands. */
  ticks: number;
  commands: number;
  skillInvokes: number;
  physicsOps: number;
  steps: number;
  seeds: number;
  world: WorldContext;
  registry: SkillRegistry;
}

/** Replay an in-memory command stream into a fresh world. */
export async function replayCommands(commands: WorldCommand[], deps: ReplayDeps): Promise<ReplayResult> {
  const tracer = deps.tracer ?? new LiminaTracer("ses_worldlog_replay");
  const registry = deps.makeRegistry(tracer);
  const world = deps.makeWorld();

  // Fresh transform storage: the SoA arrays are module globals, so zero them so
  // a not-rebuilt entity is detectably wrong rather than carrying stale values.
  Position.x.fill(0); Position.y.fill(0); Position.z.fill(0);
  Rotation.x.fill(0); Rotation.y.fill(0); Rotation.z.fill(0); Rotation.w.fill(0);
  Scale.x.fill(0); Scale.y.fill(0); Scale.z.fill(0);

  let ticks = 0;
  let skillInvokes = 0;
  let physicsOps = 0;
  let steps = 0;
  let seeds = 0;

  for (const cmd of commands) {
    if (cmd.kind === "seed") {
      installSeededRandom(cmd.seed);
      seeds++;
      continue;
    }
    // physics + skill both carry a tick.
    if (cmd.tick > ticks) ticks = cmd.tick;
    if (cmd.kind === "physics") {
      // EngineOps method resolved dynamically from the recorded op name. Ops with a
      // trailing out-buffer get a fresh scratch buffer appended (the recorded args
      // are the scalar inputs only); move_shape re-resolves deterministically.
      const op = world.ops[PHYSICS_OP_FN[cmd.op]] as (...a: unknown[]) => unknown;
      const outLen = PHYSICS_OP_OUT_BUFFER[cmd.op];
      if (outLen === undefined) op(...cmd.args);
      else op(...cmd.args, new Float32Array(outLen));
      physicsOps++;
      if (cmd.op === "step") {
        steps++;
        syncAllBodies(world);
      }
      continue;
    }
    // cmd.kind === "skill": re-apply the recorded tool call (agent or scripted).
    await registry.invoke(cmd.tool, cmd.input, {
      agentId: cmd.actorId,
      sessionId: cmd.sessionId,
      permissions: new Set(cmd.perms),
      tick: cmd.tick,
      world,
      causedBy: [],
    });
    skillInvokes++;
  }

  return {
    state: captureWorldState(world),
    ticks,
    commands: commands.length,
    skillInvokes,
    physicsOps,
    steps,
    seeds,
    world,
    registry,
  };
}

/** Replay from a persisted JSONL world log -- the disk-only recovery path. */
export async function replayWorldLog(jsonl: string, deps: ReplayDeps): Promise<ReplayResult> {
  return replayCommands(parseWorldLog(jsonl).commands, deps);
}
