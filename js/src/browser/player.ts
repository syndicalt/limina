// Time-driven EXPORT PLAYER (Phase 8). Replays a recorded command stream
// tick-by-tick — body transforms served from keyframes (KeyframePhysics) — so a
// browser rAF loop can render between ticks. This is the time-driven form of the
// batch worldlog/replay.ts replayCommands: it applies commands by the SAME rule,
// just paused at each `step` (tick) boundary. Running it to completion leaves the
// world bit-identical to the native run (verified in p8_playback_parity).

import type { EngineOps } from "../engine.ts";
import { Position, Rotation, Scale } from "../ecs/world.ts";
import { LiminaTracer, type Tracer } from "../observability/event.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import {
  captureWorldState,
  installSeededRandom,
  PHYSICS_OP_FN,
  syncAllBodies,
  type WorldCommand,
  type WorldStateSnapshot,
} from "../worldlog/log.ts";
import type { LoadedExport } from "../export/package.ts";
import { KeyframePhysics, playbackOps } from "./keyframe-physics.ts";

export interface ReplayPlayerDeps {
  /** Build a fresh world bound to the given ops (the composed keyframe + host ops). */
  makeWorld: (ops: EngineOps) => WorldContext;
  /** Build a registry with the SAME skills the recording used. */
  makeRegistry: (tracer: Tracer) => SkillRegistry;
  tracer?: Tracer;
  /** Host op overrides merged over the keyframe physics (the browser host's
   *  render + trace surfaces; omitted in headless tests). */
  opsOverrides?: Partial<EngineOps>;
}

export class ReplayPlayer {
  readonly world: WorldContext;
  readonly registry: SkillRegistry;
  readonly physics: KeyframePhysics;
  private readonly commands: WorldCommand[];
  private cursor = 0;
  private tickCount = 0;

  constructor(loaded: LoadedExport, deps: ReplayPlayerDeps) {
    const tracer = deps.tracer ?? new LiminaTracer("ses_player");
    this.physics = new KeyframePhysics(loaded.keyframes);
    this.registry = deps.makeRegistry(tracer);
    this.world = deps.makeWorld(playbackOps(this.physics, deps.opsOverrides));
    this.commands = loaded.commands;
    // Fresh transform SoA (mirror replayCommands: a not-rebuilt entity reads 0).
    Position.x.fill(0); Position.y.fill(0); Position.z.fill(0);
    Rotation.x.fill(0); Rotation.y.fill(0); Rotation.z.fill(0); Rotation.w.fill(0);
    Scale.x.fill(0); Scale.y.fill(0); Scale.z.fill(0);
  }

  /** The last completed tick (the `step` command's tick). */
  get tick(): number { return this.tickCount; }
  /** True once every command has been applied. */
  get done(): boolean { return this.cursor >= this.commands.length; }

  /** Apply one command by the SAME rule as replayCommands. Returns true for a
   *  `step` (a tick boundary, after which bodies are synced from the keyframe). */
  private async apply(cmd: WorldCommand): Promise<boolean> {
    if (cmd.kind === "seed") { installSeededRandom(cmd.seed); return false; }
    if (cmd.kind === "physics") {
      const op = this.world.ops[PHYSICS_OP_FN[cmd.op]] as (...a: number[]) => unknown;
      op(...cmd.args);
      if (cmd.op === "step") { this.tickCount = cmd.tick; syncAllBodies(this.world); return true; }
      return false;
    }
    await this.registry.invoke(cmd.tool, cmd.input, {
      agentId: cmd.actorId, sessionId: cmd.sessionId, permissions: new Set(cmd.perms),
      tick: cmd.tick, world: this.world, causedBy: [],
    });
    return false;
  }

  /** Apply setup commands up to (not including) the first `step` — rebuilds the
   *  world structure (bodies, entities, meshes) at the initial keyframe. */
  async init(): Promise<void> {
    while (this.cursor < this.commands.length) {
      const cmd = this.commands[this.cursor];
      if (cmd.kind === "physics" && cmd.op === "step") break;
      await this.apply(cmd);
      this.cursor++;
    }
  }

  /** Advance exactly one tick: apply commands through the next `step` (inclusive).
   *  No-op once done. The browser rAF accumulator calls this per fixed step. */
  async stepTick(): Promise<void> {
    while (this.cursor < this.commands.length) {
      const cmd = this.commands[this.cursor++];
      if (await this.apply(cmd)) return;
    }
  }

  /** The current comparable world state (ECS transforms + body transforms). */
  state(): WorldStateSnapshot { return captureWorldState(this.world); }
}
