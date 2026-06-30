// DIRECT-PATH GAME LOOP (M1 of the game-director roadmap).
//
// Owns the load-bearing per-frame ORDER so game authors never re-derive it (the order that
// repeatedly bit us: skinning MUST refresh AFTER the ECS→three transform sync, or rigged
// limbs detach). One place encodes the invariant; games supply the game-specific pieces.
//
// FIXED STEP (sim): re-entrancy-guarded — a tick that arrives while an async `step` is still
//   in flight is SKIPPED, never overlapped (sim steps are async because skill invokes are).
// FRAME (render), in strict order:
//   1. beforeSync(alpha)      — game-side posing: pose models + update the camera from sim state
//   2. renderSyncSystem(ecs)  — copy ECS transforms onto the three.js objects (the ONE bridge)
//   3. synced[*].syncSkinning — refresh rig bone matrices AFTER the sync, BEFORE the draw
//   4. present()              — renderer.render + surface present
//
// `frame()` and `fixedStep()` are public + side-effect-isolated (present/step are injected) so
// the order invariant and the re-entrancy guard are unit-testable headlessly, without a GPU.

import { renderSyncSystem } from "../ecs/world.ts";
import type { EngineOps } from "../engine.ts";
import type { GameContext } from "./context.ts";

/** Something the loop refreshes AFTER the ECS→three sync and BEFORE the draw — e.g. a rigged
 *  character's skinning. (CharacterModel from world/character_model.ts satisfies this.) */
export interface FrameSynced {
  syncSkinning(): void;
}

export interface GameLoopOptions<TInput> {
  /** Sample raw host input into the typed sim input. Called once per fixed step. */
  sampleInput(dt: number): TInput;
  /** The deterministic sim tick. May be async (skill invokes are); the loop guards re-entry.
   *  `frame` is the monotonic fixed-step counter (also stamped onto the sim tick). */
  step(dt: number, input: TInput, frame: number): void | Promise<void>;
  /** Game-side render posing: pose models + update the camera from sim state. Runs FIRST each
   *  frame, before the ECS sync. Optional (a headless/no-render game omits it). */
  beforeSync?(alpha: number): void;
  /** Rigged renderables refreshed after renderSyncSystem, before the draw. */
  synced?: readonly FrameSynced[];
  /** Draw + present (renderer.render + op_surface_present). Injected so the render tail is
   *  swappable and the frame order is testable without a GPU. */
  present(): void;
  /** Optional host resize handler (swapchain + camera aspect). */
  resize?(w: number, h: number): void;
}

/** Drives a direct-path game: owns the frame order + the async-step re-entrancy guard, and
 *  registers itself with the host. The substrate (physics, managers) is called by the game's
 *  own `step`/`beforeSync` — the loop only sequences the frame and never calls registry.invoke. */
export class GameLoop<TInput = unknown> {
  private stepping = false;
  private frameNo = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly opts: GameLoopOptions<TInput>,
  ) {}

  /** Monotonic count of fixed steps that have started. */
  get frame(): number {
    return this.frameNo;
  }

  /** ONE fixed sim step. Re-entrancy-guarded: while an async step is in flight, further ticks
   *  are skipped rather than overlapped (which would corrupt sim ordering). */
  fixedStep(dt: number): void {
    if (this.stepping) return;
    const frame = this.frameNo++;
    this.ctx.setTick(frame);
    const input = this.opts.sampleInput(dt);
    const result = this.opts.step(dt, input, frame);
    if (result instanceof Promise) {
      this.stepping = true;
      void result
        .catch((e) =>
          this.ctx.ops.op_log("game step error: " + (e instanceof Error ? e.message : String(e))),
        )
        .finally(() => {
          this.stepping = false;
        });
    }
  }

  /** ONE render frame, in the load-bearing order. */
  frameTick(alpha: number): void {
    this.opts.beforeSync?.(alpha);
    renderSyncSystem(this.ctx.world.ecs as never);
    if (this.opts.synced) {
      for (const s of this.opts.synced) s.syncSkinning();
    }
    this.opts.present();
  }

  /** Register with the host: a warm-up frame (compile pipelines uncontended), then the
   *  fixed-step + frame (+ optional resize) callbacks. Windowed runs only. */
  start(ops: EngineOps = this.ctx.ops): void {
    this.frameTick(0);
    ops.op_set_fixed_step_callback((dt) => this.fixedStep(dt));
    ops.op_set_frame_callback((alpha) => this.frameTick(alpha));
    if (this.opts.resize) {
      const resize = this.opts.resize;
      ops.op_set_resize_callback((w, h) => resize(w, h));
    }
  }
}
