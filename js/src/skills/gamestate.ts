// gamestate.* skills — game state variables, flags, counters, timers, conditions, win/lose/restart.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// DETERMINISM (replay invariant — sacred): the world log records each skill REQUEST and replay
// RE-INVOKES it, so every handler + every manager method reachable from a handler MUST be a pure
// function of (recorded input, recorded ctx.tick, prior manager state). There is therefore NO
// Date.now() / new Date() / Math.random() / performance.now() anywhere below:
//   • timers advance only by an EXPLICIT `dt` carried on a recorded `game.timer { action:"tick" }`
//     invoke — never by wall-clock, so replay re-applies the identical advances;
//   • win/lose stamp `endedAtTick` from `ctx.tick` (the recorded propose tick), not a clock;
//   • conditions are evaluated by a SMALL SAFE boolean evaluator (no eval / no Function ctor),
//     so an expression can read only flags/counters/variables and can never reach a global or
//     run arbitrary code.
//
// CLOSURE PATTERN (matches terrain.ts): the SkillDefinitions are built INSIDE
// registerGameStateSkills, closing over the single local `mgr` instance — there is no
// `(ctx.world as ...).gameStateManager` back-channel (it was never set, so every handler used to
// no-op). The manager IS the shared state; a fresh replay registry builds a fresh manager and
// rebuilds its state by re-invoking the recorded skills.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// ─────────────────────────── SAFE BOOLEAN EXPRESSION EVALUATOR ───────────────────────────
// Replaces the old `new Function("flags","counters", "return "+expr)` — a code-injection AND a
// determinism hole (arbitrary JS, incl. Date.now/Math.random, ran inside a replayable handler).
// This is a tiny tokenizer + recursive-descent parser. It can read ONLY the three whitelisted
// accessors (flag/counter/variable) over the live state; ANY other identifier, property access,
// or call is a parse error → it throws (callers treat a throw as `false`). No globals reachable.
//
// GRAMMAR (lowest → highest precedence):
//   expr    := or
//   or      := and ( '||' and )*
//   and      := cmp ( '&&' cmp )*
//   cmp     := unary ( ('=='|'!='|'<'|'<='|'>'|'>=') unary )?
//   unary   := '!' unary | primary
//   primary := '(' expr ')' | call | number | string | 'true' | 'false'
//   call    := ('flag'|'counter'|'variable') '(' string ')'
// Values are boolean | number | string; '&&' '||' '!' coerce to boolean; the top-level result
// is coerced with !!. Comparisons use JS operators on the two resolved primitives (deterministic).

type Primitive = string | number | boolean;
/** Read-only accessors the evaluator exposes to an expression (and NOTHING else). */
export interface ExprEnv {
  flag(name: string): boolean;
  counter(name: string): number;
  variable(name: string): Primitive;
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    // string literal: '...' or "..." (no escapes — keep the grammar tiny + total)
    if (c === "'" || c === '"') {
      const quote = c; let j = i + 1; let s = "";
      while (j < src.length && src[j] !== quote) { s += src[j]; j++; }
      if (j >= src.length) throw new Error("unterminated string literal");
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    // number literal
    if (c >= "0" && c <= "9") {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j); const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`bad number: ${raw}`);
      toks.push({ t: "num", v: n }); i = j; continue;
    }
    // identifier (only flag/counter/variable/true/false survive the parser)
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) }); i = j; continue;
    }
    // multi-char operators first
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
      toks.push({ t: "op", v: two }); i += 2; continue;
    }
    if (c === "<" || c === ">" || c === "!" || c === "(" || c === ")") {
      toks.push({ t: "op", v: c }); i++; continue;
    }
    throw new Error(`unexpected character '${c}' in expression`);
  }
  return toks;
}

/** Evaluate a boolean expression against `env`. THROWS on any syntax error, unknown identifier,
 *  or disallowed construct (the safety teeth: nothing outside the grammar can execute). */
export function evalBoolExpr(src: string, env: ExprEnv): boolean {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const eat = (): Tok => { const t = toks[pos]; if (t === undefined) throw new Error("unexpected end of expression"); pos++; return t; };
  const expectOp = (v: string): void => { const t = eat(); if (t.t !== "op" || t.v !== v) throw new Error(`expected '${v}'`); };

  function parsePrimary(): Primitive {
    const t = peek();
    if (t === undefined) throw new Error("unexpected end of expression");
    if (t.t === "op" && t.v === "(") { eat(); const v = parseOr(); expectOp(")"); return v; }
    if (t.t === "num") { eat(); return t.v; }
    if (t.t === "str") { eat(); return t.v; }
    if (t.t === "id") {
      eat();
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      if (t.v === "flag" || t.v === "counter" || t.v === "variable") {
        expectOp("(");
        const arg = eat();
        if (arg.t !== "str") throw new Error(`${t.v}() takes a string name`);
        expectOp(")");
        if (t.v === "flag") return env.flag(arg.v);
        if (t.v === "counter") return env.counter(arg.v);
        return env.variable(arg.v);
      }
      // ANY other identifier (globalThis, process, constructor, …) is rejected — no eval reach.
      throw new Error(`unknown identifier '${t.v}'`);
    }
    throw new Error("expected a value");
  }

  function parseUnary(): Primitive {
    const t = peek();
    if (t !== undefined && t.t === "op" && t.v === "!") { eat(); return !truthy(parseUnary()); }
    return parsePrimary();
  }

  function parseCmp(): Primitive {
    const left = parseUnary();
    const t = peek();
    if (t !== undefined && t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      eat(); const right = parseUnary();
      switch (t.v) {
        case "==": return left === right;
        case "!=": return left !== right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
      }
    }
    return left;
  }

  function parseAnd(): Primitive {
    let v = parseCmp();
    while (true) {
      const t = peek();
      if (t === undefined || t.t !== "op" || t.v !== "&&") break;
      eat(); const r = parseCmp(); v = truthy(v) && truthy(r);
    }
    return v;
  }

  function parseOr(): Primitive {
    let v = parseAnd();
    while (true) {
      const t = peek();
      if (t === undefined || t.t !== "op" || t.v !== "||") break;
      eat(); const r = parseAnd(); v = truthy(v) || truthy(r);
    }
    return v;
  }

  const result = parseOr();
  if (pos !== toks.length) throw new Error("trailing tokens after expression");
  return truthy(result);
}

function truthy(v: Primitive): boolean {
  return typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v !== "";
}

// ─────────────────────────────────── GAME STATE MANAGER ───────────────────────────────────

/** A live timer. Latches `done` on completion (kept in the map so its terminal state is
 *  observable + replay-comparable, rather than vanishing). Advanced ONLY by an explicit dt. */
export interface TimerState {
  remaining: number;          // countdown: seconds left; countup: seconds elapsed
  duration: number;           // target duration in seconds
  paused: boolean;
  direction: "countdown" | "countup";
  onComplete: string;         // event name fired when the timer completes
  done: boolean;              // latched: completed, no longer ticks
}

export interface GameState {
  variables: Map<string, string | number | boolean | Record<string, unknown>>;
  flags: Map<string, boolean>;
  counters: Map<string, number>;
  timers: Map<string, TimerState>;
  conditions: Map<string, { expression: string; lastValue: boolean; onTrue?: string }>;
  state: "running" | "won" | "lost" | "paused";
  /** The tick win()/lose() landed on (from ctx.tick) — deterministic, no wall-clock. */
  endedAtTick?: number;
}

export class GameStateManager {
  private state: GameState = {
    variables: new Map(),
    flags: new Map(),
    counters: new Map(),
    timers: new Map(),
    conditions: new Map(),
    state: "running",
  };
  private readonly onStateChange?: (event: string, data: Record<string, unknown>) => void;

  constructor(opts?: { onStateChange?: (event: string, data: Record<string, unknown>) => void }) {
    this.onStateChange = opts?.onStateChange;
  }

  getState(): GameState {
    return this.state;
  }

  getVariable(name: string): string | number | boolean | Record<string, unknown> | undefined {
    return this.state.variables.get(name);
  }

  setVariable(name: string, value: string | number | boolean | Record<string, unknown>): void {
    this.state.variables.set(name, value);
  }

  setFlag(name: string, value: boolean): void {
    this.state.flags.set(name, value);
  }

  getFlag(name: string): boolean {
    return this.state.flags.get(name) ?? false;
  }

  setCounter(name: string, value: number): void {
    this.state.counters.set(name, value);
  }

  getCounter(name: string): number {
    return this.state.counters.get(name) ?? 0;
  }

  modifyCounter(name: string, delta: number): number {
    const newValue = this.getCounter(name) + delta;
    this.state.counters.set(name, newValue);
    return newValue;
  }

  startTimer(name: string, duration: number, direction: "countdown" | "countup" = "countdown", onComplete = "game.timer.complete"): void {
    this.state.timers.set(name, {
      remaining: direction === "countdown" ? duration : 0,
      duration,
      paused: false,
      direction,
      onComplete,
      done: false,
    });
  }

  pauseTimer(name: string): boolean {
    const timer = this.state.timers.get(name);
    if (timer === undefined) return false;
    timer.paused = true;
    return true;
  }

  resumeTimer(name: string): boolean {
    const timer = this.state.timers.get(name);
    if (timer === undefined || timer.done) return false;
    timer.paused = false;
    return true;
  }

  getTimerRemaining(name: string): number {
    const timer = this.state.timers.get(name);
    if (timer === undefined) return 0;
    return timer.direction === "countdown" ? timer.remaining : Math.max(0, timer.duration - timer.remaining);
  }

  /** Advance every running timer by `dtSec` (an EXPLICIT, recorded delta — never wall-clock).
   *  Latches completed timers (`done`) and returns those that completed THIS tick, with the
   *  event name to fire for each. Deterministic: same dt sequence ⇒ same completions. */
  tickTimers(dtSec: number): { name: string; onComplete: string }[] {
    const completed: { name: string; onComplete: string }[] = [];
    for (const [name, timer] of this.state.timers) {
      if (timer.paused || timer.done) continue;
      if (timer.direction === "countdown") {
        timer.remaining -= dtSec;
        if (timer.remaining <= 0) { timer.remaining = 0; timer.done = true; completed.push({ name, onComplete: timer.onComplete }); }
      } else {
        timer.remaining += dtSec;
        if (timer.remaining >= timer.duration) { timer.remaining = timer.duration; timer.done = true; completed.push({ name, onComplete: timer.onComplete }); }
      }
    }
    return completed;
  }

  defineCondition(name: string, expression: string, onTrue?: string): void {
    this.state.conditions.set(name, { expression, lastValue: false, onTrue });
  }

  /** Evaluate a named condition. Returns its boolean value AND whether it ROSE (false→true)
   *  this evaluation, so the caller can fire the condition's `onTrue` event on the edge only.
   *  A bad/unsafe expression evaluates to `false` (the throw from evalBoolExpr is swallowed —
   *  no eval ever runs). Unknown condition → { value:false, rose:false }. */
  evaluateCondition(name: string): { value: boolean; rose: boolean; onTrue?: string } {
    const cond = this.state.conditions.get(name);
    if (cond === undefined) return { value: false, rose: false };
    let value = false;
    try {
      value = evalBoolExpr(cond.expression, {
        flag: (n) => this.getFlag(n),
        counter: (n) => this.getCounter(n),
        variable: (n) => {
          const v = this.getVariable(n);
          // Only primitives are comparable in an expression; objects/undefined read as "".
          return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : "";
        },
      });
    } catch {
      value = false; // unsafe/invalid expression → false, never executed
    }
    const rose = value && !cond.lastValue;
    cond.lastValue = value;
    return { value, rose, onTrue: cond.onTrue };
  }

  win(tick: number): void {
    this.state.state = "won";
    this.state.endedAtTick = tick;
    this.onStateChange?.("game.won", { tick });
  }

  lose(tick: number): void {
    this.state.state = "lost";
    this.state.endedAtTick = tick;
    this.onStateChange?.("game.lost", { tick });
  }

  /** Restart the session: state back to running, run-progress (vars/flags/counters/timers/
   *  conditions) cleared. (A full WORLD reset still needs a scene reload — see game.restart.) */
  reset(): void {
    this.state.variables.clear();
    this.state.flags.clear();
    this.state.counters.clear();
    this.state.timers.clear();
    this.state.conditions.clear();
    this.state.state = "running";
    this.state.endedAtTick = undefined;
  }
}

// ───────────────────────────────────────── SKILLS ─────────────────────────────────────────

export function registerGameStateSkills(registry: SkillRegistry, opts?: { gameStateManager?: GameStateManager }): { gameStateManager: GameStateManager } {
  // The single shared manager every skill below closes over (the terrain.ts closure pattern).
  const mgr = opts?.gameStateManager ?? new GameStateManager();

  // ---- game.state ----------------------------------------------------------
  const stateInput = z.object({
    action: z.enum(["get", "set"]).default("get"),
    name: z.string().min(1).describe("State variable name."),
    value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]).optional().describe("Value to set (for action=set)."),
    meta: MetaField,
  });
  const gameState: SkillDefinition<z.infer<typeof stateInput>, { value: unknown }> = {
    name: "game.state",
    version: "1.0.0",
    description: "Get or set a named game state variable (string, number, bool, or JSON object).",
    category: "game",
    permissions: ["game.write"],
    input: stateInput,
    output: z.object({ value: z.unknown() }),
    handler: (input, ctx) => {
      if (input.action === "set" && input.value !== undefined) {
        mgr.setVariable(input.name, input.value);
        ctx.emit("game.state.set", { name: input.name, value: input.value, ...input.meta });
      }
      return { value: mgr.getVariable(input.name) }; // get is a pure read → no emit
    },
  };

  // ---- game.flag -----------------------------------------------------------
  const flagInput = z.object({
    name: z.string().min(1),
    value: z.boolean().optional().describe("Set the flag. If omitted, returns current value."),
    meta: MetaField,
  });
  const gameFlag: SkillDefinition<z.infer<typeof flagInput>, { value: boolean }> = {
    name: "game.flag",
    version: "1.0.0",
    description: "Get or set a boolean game flag (shorthand for commonly-checked conditions: bossDefeated, doorUnlocked, etc.).",
    category: "game",
    permissions: ["game.write"],
    input: flagInput,
    output: z.object({ value: z.boolean() }),
    handler: (input, ctx) => {
      if (input.value !== undefined) {
        mgr.setFlag(input.name, input.value);
        ctx.emit("game.flag.set", { name: input.name, value: input.value, ...input.meta });
      }
      return { value: mgr.getFlag(input.name) }; // bare get → pure read, no emit
    },
  };

  // ---- game.counter --------------------------------------------------------
  const counterInput = z.object({
    name: z.string().min(1),
    action: z.enum(["get", "set", "increment", "decrement"]).default("get"),
    value: z.number().int().optional().describe("Value for set action, or delta for increment/decrement."),
    meta: MetaField,
  });
  const gameCounter: SkillDefinition<z.infer<typeof counterInput>, { value: number }> = {
    name: "game.counter",
    version: "1.0.0",
    description: "Get, set, increment, or decrement a named game counter.",
    category: "game",
    permissions: ["game.write"],
    input: counterInput,
    output: z.object({ value: z.number() }),
    handler: (input, ctx) => {
      let result = mgr.getCounter(input.name);
      switch (input.action) {
        case "get":
          return { value: result }; // pure read → no emit
        case "set":
          result = input.value ?? result;
          mgr.setCounter(input.name, result);
          break;
        case "increment":
          result = mgr.modifyCounter(input.name, input.value ?? 1);
          break;
        case "decrement":
          result = mgr.modifyCounter(input.name, -(input.value ?? 1));
          break;
      }
      ctx.emit("game.counter.modified", { name: input.name, action: input.action, value: result, ...input.meta });
      return { value: result };
    },
  };

  // ---- game.timer ----------------------------------------------------------
  // `tick` is the DETERMINISTIC clock: a recorded invoke carrying an explicit `dt` (seconds)
  // advances ALL timers and fires the onComplete event for any that finished — replay re-applies
  // the identical dt sequence, so timer state is bit-identical. There is no wall-clock anywhere.
  const timerInput = z.object({
    name: z.string().min(1).optional().describe("Timer name (required for start/pause/resume/get)."),
    action: z.enum(["start", "pause", "resume", "get", "tick"]).default("start"),
    duration: z.number().positive().optional().describe("Duration in seconds (for start)."),
    direction: z.enum(["countdown", "countup"]).default("countdown"),
    dt: z.number().nonnegative().optional().describe("Seconds to advance all timers (for action=tick)."),
    onComplete: z.string().optional().describe("Event name to emit when this timer completes."),
    meta: MetaField,
  });
  const gameTimer: SkillDefinition<z.infer<typeof timerInput>, { ok: boolean; remaining: number; completed: string[] }> = {
    name: "game.timer",
    version: "1.0.0",
    description: "Start, pause, resume, query, or TICK named game timers. `tick` advances all timers by an explicit dt (deterministic — no wall-clock) and fires each completed timer's onComplete event. Supports countdown and countup.",
    category: "game",
    permissions: ["game.write"],
    input: timerInput,
    output: z.object({ ok: z.boolean(), remaining: z.number(), completed: z.array(z.string()) }),
    handler: (input, ctx) => {
      switch (input.action) {
        case "start": {
          if (input.name === undefined || input.duration === undefined) return { ok: false, remaining: 0, completed: [] };
          mgr.startTimer(input.name, input.duration, input.direction, input.onComplete ?? "game.timer.complete");
          ctx.emit("game.timer.started", { name: input.name, duration: input.duration, direction: input.direction, ...input.meta });
          return { ok: true, remaining: mgr.getTimerRemaining(input.name), completed: [] };
        }
        case "pause":
          if (input.name === undefined) return { ok: false, remaining: 0, completed: [] };
          return { ok: mgr.pauseTimer(input.name), remaining: mgr.getTimerRemaining(input.name), completed: [] };
        case "resume":
          if (input.name === undefined) return { ok: false, remaining: 0, completed: [] };
          return { ok: mgr.resumeTimer(input.name), remaining: mgr.getTimerRemaining(input.name), completed: [] };
        case "tick": {
          const completed = mgr.tickTimers(input.dt ?? 0);
          for (const c of completed) ctx.emit(c.onComplete, { name: c.name, tick: ctx.tick, ...input.meta });
          return { ok: true, remaining: 0, completed: completed.map((c) => c.name) };
        }
        default: // get → pure read, no emit
          return { ok: input.name !== undefined && mgr.getState().timers.has(input.name), remaining: input.name === undefined ? 0 : mgr.getTimerRemaining(input.name), completed: [] };
      }
    },
  };

  // ---- game.condition ------------------------------------------------------
  // `define` stores the expression (+ optional onTrue event) and immediately evaluates it;
  // `evaluate` re-evaluates an existing condition. Either fires `onTrue` on the RISING edge
  // (false→true) only. Evaluation goes through the SAFE evaluator — never eval/new Function.
  const conditionInput = z.object({
    name: z.string().min(1),
    action: z.enum(["define", "evaluate"]).default("define"),
    expression: z.string().min(1).optional().describe("Boolean expression: flag('n'), counter('n'), variable('n'), == != < <= > >=, && || ! and parens. Required for define."),
    onTrue: z.string().optional().describe("Event name to emit when the condition becomes true (rising edge)."),
    meta: MetaField,
  });
  const gameCondition: SkillDefinition<z.infer<typeof conditionInput>, { ok: boolean; value: boolean; fired: boolean }> = {
    name: "game.condition",
    version: "1.0.0",
    description: "Define and/or evaluate a named condition (a SAFE boolean expression over game flags/counters/variables — no eval). Fires its onTrue event on the rising edge.",
    category: "game",
    permissions: ["game.configure"],
    input: conditionInput,
    output: z.object({ ok: z.boolean(), value: z.boolean(), fired: z.boolean() }),
    handler: (input, ctx) => {
      if (input.action === "define") {
        if (input.expression === undefined) return { ok: false, value: false, fired: false };
        mgr.defineCondition(input.name, input.expression, input.onTrue);
        ctx.emit("game.condition.defined", { name: input.name, expression: input.expression, ...input.meta });
      } else if (!mgr.getState().conditions.has(input.name)) {
        return { ok: false, value: false, fired: false }; // evaluate of an undefined condition
      }
      const { value, rose, onTrue } = mgr.evaluateCondition(input.name);
      if (rose && onTrue !== undefined) ctx.emit(onTrue, { name: input.name, tick: ctx.tick, ...input.meta });
      ctx.emit("game.condition.evaluated", { name: input.name, value, fired: rose, ...input.meta });
      return { ok: true, value, fired: rose };
    },
  };

  // ---- game.win / game.lose / game.restart ---------------------------------
  const triggerEndInput = z.object({ meta: MetaField });

  const gameWin: SkillDefinition<z.infer<typeof triggerEndInput>, { ok: boolean }> = {
    name: "game.win",
    version: "1.0.0",
    description: "Trigger the win condition. Ends the game session with a victory state.",
    category: "game",
    permissions: ["game.write"],
    input: triggerEndInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.win(ctx.tick); // deterministic end-tick from the recorded ctx.tick
      ctx.emit("game.won", { tick: ctx.tick, ...input.meta });
      return { ok: true };
    },
  };

  const gameLose: SkillDefinition<z.infer<typeof triggerEndInput>, { ok: boolean }> = {
    name: "game.lose",
    version: "1.0.0",
    description: "Trigger the lose condition. Ends the game session with a failure state.",
    category: "game",
    permissions: ["game.write"],
    input: triggerEndInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.lose(ctx.tick);
      ctx.emit("game.lost", { tick: ctx.tick, ...input.meta });
      return { ok: true };
    },
  };

  const restartInput = z.object({ meta: MetaField });
  const gameRestart: SkillDefinition<z.infer<typeof restartInput>, { ok: boolean }> = {
    name: "game.restart",
    version: "1.0.0",
    description: "Restart the current game session (reset game state to running, clearing run progress). Full world reset requires scene reload.",
    category: "game",
    permissions: ["game.write"],
    input: restartInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.reset();
      ctx.emit("game.restarted", { tick: ctx.tick, ...input.meta });
      return { ok: true };
    },
  };

  registry.register(gameState);
  registry.register(gameFlag);
  registry.register(gameCounter);
  registry.register(gameTimer);
  registry.register(gameCondition);
  registry.register(gameWin);
  registry.register(gameLose);
  registry.register(gameRestart);

  return { gameStateManager: mgr };
}
