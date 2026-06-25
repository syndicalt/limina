// limina world-log RECORDER -- hooks the engine's command sources so a running
// session emits the authoritative, replay-complete command stream (see log.ts).
//
// Three hooks, matching the three command sources:
//   1. seed()       -- installs the seeded PRNG (Math.random) and records the seed.
//   2. wrapOps(ops) -- returns an EngineOps proxy that records every MUTATING
//                      native physics op issued OUTSIDE a skill (depth 0). Ops
//                      issued INSIDE a skill (depth > 0) are NOT recorded -- the
//                      skill command reproduces them on re-invoke.
//   3. attach(reg)  -- patches SkillRegistry.invoke (the single mutation choke
//                      point) to record each top-level invocation (tool + input +
//                      tick + actor + perms). Agent actions flow through the same
//                      registry, so they are captured here with no agent coupling.
//
// A single `depth` counter is shared by the ops proxy and the invoke hook so a
// physics op is recorded iff it is NOT nested inside a skill invocation.

import type { EngineOps } from "../engine.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import type { InvokeBase, SkillRegistry } from "../skills/registry.ts";
import {
  installSeededRandom,
  LOG_VERSION,
  RECORDED_PHYSICS_METHODS,
  serializeWorldLog,
  type WorldCommand,
  type WorldLogMeta,
} from "./log.ts";

export class WorldRecorder {
  readonly commands: WorldCommand[] = [];
  /** Current simulation tick; the scenario updates it each loop iteration. */
  tick = 0;
  private seq = 0;
  private depth = 0;
  private maxTick = 0;
  private seeded = false;

  constructor(readonly sessionId: string) {}

  /** Record + install the deterministic PRNG seed. Call once, before any
   *  command that could consume randomness. */
  seed(seed: number): () => number {
    if (this.seeded) throw new Error("WorldRecorder: seed already recorded");
    this.seeded = true;
    this.commands.push({ kind: "seed", seq: this.seq++, seed: seed >>> 0 });
    return installSeededRandom(seed);
  }

  /** Wrap an EngineOps so mutating physics ops issued at depth 0 are recorded.
   *  Reads and host services pass straight through. */
  wrapOps(ops: EngineOps): EngineOps {
    const rec = this;
    return new Proxy(ops, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        // `value` is a verified EngineOps method; give it a callable signature.
        const method = value as (...a: number[]) => unknown;
        const opName = typeof prop === "string" ? RECORDED_PHYSICS_METHODS[prop] : undefined;
        if (opName === undefined) return method.bind(target);
        return (...args: number[]): unknown => {
          if (rec.depth === 0) {
            const tick = rec.tick;
            if (tick > rec.maxTick) rec.maxTick = tick;
            rec.commands.push({ kind: "physics", seq: rec.seq++, tick, op: opName, args: args.slice() });
          }
          return method.apply(target, args);
        };
      },
    });
  }

  /** Patch a registry instance's invoke() to record each top-level invocation.
   *  Nested invokes (depth > 0) are NOT recorded -- re-invoking the outer skill
   *  reproduces them. */
  attach(registry: SkillRegistry): void {
    const rec = this;
    const original = registry.invoke.bind(registry);
    registry.invoke = function patched(name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
      if (rec.depth === 0) {
        const tick = base.tick;
        if (tick > rec.maxTick) rec.maxTick = tick;
        rec.commands.push({
          kind: "skill",
          seq: rec.seq++,
          tick,
          tool: name,
          input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)),
          actorId: base.agentId,
          sessionId: base.sessionId,
          perms: [...base.permissions].sort(),
        });
      }
      rec.depth++;
      // depth must drop whether the invoke resolves or rejects (re-entrancy guard).
      return original(name, input, base).finally(() => {
        rec.depth--;
      });
    };
  }

  meta(): WorldLogMeta {
    return {
      kind: "meta",
      logVersion: LOG_VERSION,
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      commands: this.commands.length,
      ticks: this.maxTick,
    };
  }

  /** Count of recorded commands of a given kind (for reporting/assertions). */
  count(kind: WorldCommand["kind"]): number {
    let n = 0;
    for (const c of this.commands) if (c.kind === kind) n++;
    return n;
  }

  toJsonl(): string {
    return serializeWorldLog(this.meta(), this.commands);
  }
}
