// director.* skills — a deterministic AI DIRECTOR (pacing + orchestration), the missing
// "world-scale orchestration of events/NPCs" primitive.
//
// Modeled on the Left-4-Dead pacing director: it runs a tension state machine —
// build_up → sustain (peak) → fade → rest → build_up — and emits a DIRECTIVE on every phase
// transition (peak / sustain_end / lull / build). The host maps directives to its own skills
// (spawn a wave on "peak", ease off on "lull", …). Tension rises during build_up, is held at the
// peak through sustain, decays during fade, and idles through rest; a per-tick `pressure` signal
// (0..1 — e.g. current threat / how stressed the player already is) DAMPS the build-up so the
// director never piles on while the world is already hot.
//
// DETERMINISM (replay invariant): the pump is a pure function of (config, state, simTick,
// pressure) — no Date.now / RNG. Given the same recorded inputs it emits a byte-identical
// directive stream, so a recorded session replays identically. The manager NEVER performs the
// directives itself (exactly like TriggerManager / CutsceneManager); the host dispatches them.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

export type DirectorPhase = "build_up" | "sustain" | "fade" | "rest";

export interface DirectorConfig {
  /** Tension gained per tick during build_up (before pressure damping). */
  buildRate: number;
  /** Tension lost per tick during fade. */
  fadeRate: number;
  /** Ticks held at peak tension during sustain. */
  sustainTicks: number;
  /** Ticks idled at rest before the next build_up. */
  restTicks: number;
  /** Tension at/above which build_up flips to sustain. */
  peakLevel: number;
  /** Tension at/below which fade flips to rest. */
  restLevel: number;
  /** How strongly `pressure` (0..1) slows build_up: effectiveRate = buildRate*(1 - pressure*damping). */
  pressureDamping: number;
}

const DEFAULTS: DirectorConfig = {
  buildRate: 0.02, fadeRate: 0.03, sustainTicks: 180, restTicks: 240,
  peakLevel: 1, restLevel: 0.1, pressureDamping: 0.9,
};

/** A directive the director emitted on a phase transition (the host acts on it). */
export interface Directive {
  /** "peak" (enter sustain), "sustain_end" (enter fade), "lull" (enter rest), "build" (enter build_up). */
  type: "peak" | "sustain_end" | "lull" | "build";
  phase: DirectorPhase;
  tension: number;
  tick: number;
}

export interface DirectorStatus {
  running: boolean;
  phase?: DirectorPhase;
  tension?: number;
  phaseTicksLeft?: number;
}

export class DirectorManager {
  private cfg: DirectorConfig = { ...DEFAULTS };
  private running = false;
  private phase: DirectorPhase = "build_up";
  private tension = 0;
  private phaseTicksLeft = 0;

  /** Set config (merged over current) and RESET the state machine to a fresh build_up. */
  configure(partial: Partial<DirectorConfig>): DirectorConfig {
    this.cfg = { ...this.cfg, ...partial };
    this.phase = "build_up";
    this.tension = 0;
    this.phaseTicksLeft = 0;
    return { ...this.cfg };
  }

  start(): void {
    this.running = true;
    this.phase = "build_up";
    this.tension = 0;
    this.phaseTicksLeft = 0;
  }

  stop(): boolean {
    const was = this.running;
    this.running = false;
    return was;
  }

  isRunning(): boolean {
    return this.running;
  }

  status(): DirectorStatus {
    if (!this.running) return { running: false };
    return { running: true, phase: this.phase, tension: this.tension, phaseTicksLeft: this.phaseTicksLeft };
  }

  /** Advance one tick. `pressure` (0..1, clamped) damps build_up. Returns the directive emitted on a
   *  phase transition this tick, or null. Deterministic over (config, state, tick, pressure). */
  tick(tick: number, pressure = 0): Directive | null {
    if (!this.running) return null;
    const p = pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
    const c = this.cfg;
    switch (this.phase) {
      case "build_up": {
        const rate = c.buildRate * (1 - p * c.pressureDamping);
        this.tension += rate;
        if (this.tension >= c.peakLevel) {
          this.tension = c.peakLevel;
          this.phase = "sustain";
          this.phaseTicksLeft = c.sustainTicks;
          return { type: "peak", phase: this.phase, tension: this.tension, tick };
        }
        return null;
      }
      case "sustain": {
        this.phaseTicksLeft -= 1;
        if (this.phaseTicksLeft <= 0) {
          this.phase = "fade";
          return { type: "sustain_end", phase: this.phase, tension: this.tension, tick };
        }
        return null;
      }
      case "fade": {
        this.tension -= c.fadeRate;
        if (this.tension <= c.restLevel) {
          this.tension = c.restLevel;
          this.phase = "rest";
          this.phaseTicksLeft = c.restTicks;
          return { type: "lull", phase: this.phase, tension: this.tension, tick };
        }
        return null;
      }
      case "rest": {
        this.phaseTicksLeft -= 1;
        if (this.phaseTicksLeft <= 0) {
          this.phase = "build_up";
          return { type: "build", phase: this.phase, tension: this.tension, tick };
        }
        return null;
      }
    }
  }
}

const configInput = z.object({
  buildRate: z.number().positive().max(1).optional(),
  fadeRate: z.number().positive().max(1).optional(),
  sustainTicks: z.number().int().min(0).max(100000).optional(),
  restTicks: z.number().int().min(0).max(100000).optional(),
  peakLevel: z.number().positive().max(1).optional(),
  restLevel: z.number().min(0).max(1).optional(),
  pressureDamping: z.number().min(0).max(1).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export function registerDirectorSkills(registry: SkillRegistry): { directorManager: DirectorManager } {
  const mgr = new DirectorManager();

  const configure: SkillDefinition<z.infer<typeof configInput>, { ok: boolean; config: DirectorConfig }> = {
    name: "director.configure",
    version: "1.0.0",
    description: "Configure the AI director's pacing model (build/fade rates, sustain/rest durations, peak/rest levels, pressure damping) and reset its state. Deterministic, tick-driven.",
    category: "agent",
    permissions: ["agent.write"],
    input: configInput,
    output: z.object({
      ok: z.boolean(),
      config: z.object({
        buildRate: z.number(), fadeRate: z.number(), sustainTicks: z.number(), restTicks: z.number(),
        peakLevel: z.number(), restLevel: z.number(), pressureDamping: z.number(),
      }),
    }),
    handler: (input, ctx) => {
      const { meta, ...partial } = input;
      const config = mgr.configure(partial);
      ctx.emit("director.configured", { ...config, ...meta });
      return { ok: true, config };
    },
  };

  const startStop = z.object({ meta: z.record(z.string(), z.unknown()).optional() });
  const start: SkillDefinition<z.infer<typeof startStop>, { ok: boolean }> = {
    name: "director.start",
    version: "1.0.0",
    description: "Start (or restart) the AI director from a fresh build_up. The host pumps director tick(simTick, pressure) each step and dispatches the returned directives.",
    category: "agent",
    permissions: ["agent.write"],
    input: startStop,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => { mgr.start(); ctx.emit("director.started", { ...input.meta }); return { ok: true }; },
  };
  const stop: SkillDefinition<z.infer<typeof startStop>, { ok: boolean; wasRunning: boolean }> = {
    name: "director.stop",
    version: "1.0.0",
    description: "Stop the AI director (no-op if not running).",
    category: "agent",
    permissions: ["agent.write"],
    input: startStop,
    output: z.object({ ok: z.boolean(), wasRunning: z.boolean() }),
    handler: (input, ctx) => { const wasRunning = mgr.stop(); if (wasRunning) ctx.emit("director.stopped", { ...input.meta }); return { ok: true, wasRunning }; },
  };
  const statusSkill: SkillDefinition<Record<string, never>, DirectorStatus> = {
    name: "director.status",
    version: "1.0.0",
    description: "Read the director's current phase, tension, and ticks left in the phase. Pure read.",
    category: "agent",
    permissions: ["agent.read"],
    input: z.object({}),
    output: z.object({
      running: z.boolean(),
      phase: z.enum(["build_up", "sustain", "fade", "rest"]).optional(),
      tension: z.number().optional(),
      phaseTicksLeft: z.number().optional(),
    }),
    handler: () => mgr.status(),
  };

  registry.register(configure);
  registry.register(start);
  registry.register(stop);
  registry.register(statusSkill);

  return { directorManager: mgr };
}
