// cutscene.* skills — a deterministic, tick-driven TIMELINE SEQUENCER.
//
// The missing primitive for scripted set-pieces (intros, scripted reveals, the Half-Life-style
// "the world does a thing on a timeline" beat). An agent authors a cutscene as a list of
// KEYFRAMES — { atTick, action } — then plays it; the host pumps `tick(simTick)` each fixed step
// and DISPATCHES the fired action descriptors through its other skills (camera.cut, dialogue.open,
// vfx.play, …). This mirrors the trigger pump exactly: the manager resolves WHAT fires and WHEN;
// it never performs side effects itself.
//
// DETERMINISM (the replay invariant): the pump is pure tick arithmetic — a keyframe at relative
// tick K fires on the first pump where (simTick - startTick) >= K. No Date.now / wall clock / RNG.
// `play` stamps startTick from the recorded sim tick (ctx.tick), so a recorded session replays the
// same fired sequence bit-identically. Authoring + playing flow entirely through the recorded
// skill surface; the host-driven `tick()` is deterministic infra (like TriggerManager.tick).

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

/** A data-driven action descriptor (the agent-authored WHAT) a keyframe fires. The host maps
 *  `type` to one of its skills (e.g. "camera.cut" → camera.cut(data)). Opaque to the manager. */
export interface CutsceneAction {
  type: string;
  data?: Record<string, unknown>;
}

/** One keyframe: fire `action` once, the first pump at/after relative tick `atTick` (0-based from
 *  the cutscene's start). */
export interface CutsceneKeyframe {
  atTick: number;
  action: CutsceneAction;
}

/** An action the pump resolved as fired this tick (the host drives it via its other skills). */
export interface FiredCutsceneAction {
  cutsceneId: string;
  /** The keyframe's authored relative tick (for logging / ordering). */
  atTick: number;
  action: CutsceneAction;
}

interface StoredCutscene {
  keyframes: CutsceneKeyframe[]; // sorted ascending by atTick
  durationTicks: number; // max atTick (the last keyframe), 0 when empty
  loop: boolean;
}

interface ActivePlayback {
  id: string;
  startTick: number;
  firedThrough: number; // count of keyframes already fired (index into the sorted list)
}

/** A read-only view of the current playback (for cutscene.status / hosts / tests). */
export interface CutsceneStatus {
  playing: boolean;
  id?: string;
  startTick?: number;
  firedThrough?: number;
  total?: number;
  loop?: boolean;
}

export class CutsceneManager {
  private readonly defs = new Map<string, StoredCutscene>();
  private active: ActivePlayback | undefined;

  /** Register (or replace) a cutscene definition. Keyframes are sorted ascending by atTick so the
   *  pump can fire them in deterministic order regardless of authoring order. */
  define(id: string, keyframes: CutsceneKeyframe[], loop: boolean): { keyframes: number; durationTicks: number } {
    const sorted = [...keyframes].sort((a, b) => (a.atTick - b.atTick) || 0);
    const durationTicks = sorted.length > 0 ? sorted[sorted.length - 1].atTick : 0;
    this.defs.set(id, { keyframes: sorted, durationTicks, loop });
    return { keyframes: sorted.length, durationTicks };
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  /** Start playing `id` with its timeline anchored at `startTick`. Returns false if unknown. A new
   *  play supersedes any in-progress playback. */
  play(id: string, startTick: number): boolean {
    if (!this.defs.has(id)) return false;
    this.active = { id, startTick, firedThrough: 0 };
    return true;
  }

  /** Stop the active playback. Returns whether something was playing. */
  stop(): boolean {
    const was = this.active !== undefined;
    this.active = undefined;
    return was;
  }

  isPlaying(): boolean {
    return this.active !== undefined;
  }

  status(): CutsceneStatus {
    if (this.active === undefined) return { playing: false };
    const def = this.defs.get(this.active.id);
    return {
      playing: true,
      id: this.active.id,
      startTick: this.active.startTick,
      firedThrough: this.active.firedThrough,
      total: def?.keyframes.length ?? 0,
      loop: def?.loop ?? false,
    };
  }

  /** Deterministic pump: fire every not-yet-fired keyframe whose relative tick has arrived
   *  (atTick <= simTick - startTick), in order, and return their action descriptors. When the
   *  last keyframe has fired, the playback ENDS (or, if `loop`, re-anchors to `simTick` and
   *  repeats). Pure over (defs, active, simTick) — safe to call every fixed step. */
  tick(simTick: number): FiredCutsceneAction[] {
    if (this.active === undefined) return [];
    const def = this.defs.get(this.active.id);
    if (def === undefined) { this.active = undefined; return []; }

    const elapsed = simTick - this.active.startTick;
    const fired: FiredCutsceneAction[] = [];
    while (
      this.active.firedThrough < def.keyframes.length &&
      def.keyframes[this.active.firedThrough].atTick <= elapsed
    ) {
      const kf = def.keyframes[this.active.firedThrough];
      fired.push({ cutsceneId: this.active.id, atTick: kf.atTick, action: kf.action });
      this.active.firedThrough++;
    }
    if (this.active.firedThrough >= def.keyframes.length) {
      if (def.loop) {
        this.active.startTick = simTick; // re-anchor the next cycle to now
        this.active.firedThrough = 0;
      } else {
        this.active = undefined; // playback complete
      }
    }
    return fired;
  }
}

const actionSchema = z.object({
  type: z.string().min(1).describe("Action type the host maps to a skill, e.g. \"camera.cut\"."),
  data: z.record(z.string(), z.unknown()).optional().describe("Action payload passed through to the host's dispatch."),
});
const keyframeSchema = z.object({
  atTick: z.number().int().min(0).describe("Relative tick (0-based from the cutscene start) at/after which the action fires once."),
  action: actionSchema,
});

export function registerCutsceneSkills(registry: SkillRegistry): { cutsceneManager: CutsceneManager } {
  const mgr = new CutsceneManager();

  const defineInput = z.object({
    id: z.string().min(1).describe("Cutscene id (stable across runs)."),
    keyframes: z.array(keyframeSchema).min(1).max(512).describe("Timeline keyframes; sorted by atTick internally."),
    loop: z.boolean().default(false).describe("Restart from the top after the last keyframe."),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  const define: SkillDefinition<z.infer<typeof defineInput>, { ok: boolean; keyframes: number; durationTicks: number }> = {
    name: "cutscene.define",
    version: "1.0.0",
    description: "Author a scripted timeline as keyframes ({atTick, action}). The host pumps it and dispatches each fired action through its other skills. Deterministic (tick-driven).",
    category: "game",
    permissions: ["game.configure"],
    input: defineInput,
    output: z.object({ ok: z.boolean(), keyframes: z.number(), durationTicks: z.number() }),
    handler: (input, ctx) => {
      const { keyframes, durationTicks } = mgr.define(input.id, input.keyframes, input.loop);
      ctx.emit("cutscene.defined", { id: input.id, keyframes, durationTicks, loop: input.loop, ...input.meta });
      return { ok: true, keyframes, durationTicks };
    },
  };

  const playInput = z.object({
    id: z.string().min(1).describe("Cutscene id to play."),
    startTick: z.number().int().min(0).optional().describe("Tick to anchor the timeline at. Defaults to the current sim tick (replay-deterministic)."),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  const play: SkillDefinition<z.infer<typeof playInput>, { ok: boolean; reason?: string }> = {
    name: "cutscene.play",
    version: "1.0.0",
    description: "Start playing a defined cutscene, anchoring its timeline at startTick (default: the current sim tick). Supersedes any in-progress playback. On failure returns ok:false with a reason.",
    category: "game",
    permissions: ["game.write"],
    input: playInput,
    output: z.object({ ok: z.boolean(), reason: z.string().optional() }),
    handler: (input, ctx) => {
      const startTick = input.startTick ?? ctx.tick;
      if (!mgr.play(input.id, startTick)) return { ok: false, reason: `unknown cutscene "${input.id}" (define it first)` };
      ctx.emit("cutscene.started", { id: input.id, startTick, ...input.meta });
      return { ok: true };
    },
  };

  const stopInput = z.object({ meta: z.record(z.string(), z.unknown()).optional() });
  const stop: SkillDefinition<z.infer<typeof stopInput>, { ok: boolean; wasPlaying: boolean }> = {
    name: "cutscene.stop",
    version: "1.0.0",
    description: "Stop the active cutscene playback (no-op if none is playing).",
    category: "game",
    permissions: ["game.write"],
    input: stopInput,
    output: z.object({ ok: z.boolean(), wasPlaying: z.boolean() }),
    handler: (input, ctx) => {
      const wasPlaying = mgr.stop();
      if (wasPlaying) ctx.emit("cutscene.stopped", { ...input.meta });
      return { ok: true, wasPlaying };
    },
  };

  const statusSkill: SkillDefinition<Record<string, never>, CutsceneStatus> = {
    name: "cutscene.status",
    version: "1.0.0",
    description: "Read the current cutscene playback state (playing, id, progress). Pure read.",
    category: "game",
    permissions: ["scene.read"],
    input: z.object({}),
    output: z.object({
      playing: z.boolean(),
      id: z.string().optional(),
      startTick: z.number().optional(),
      firedThrough: z.number().optional(),
      total: z.number().optional(),
      loop: z.boolean().optional(),
    }),
    handler: () => mgr.status(),
  };

  registry.register(define);
  registry.register(play);
  registry.register(stop);
  registry.register(statusSkill);

  return { cutsceneManager: mgr };
}
