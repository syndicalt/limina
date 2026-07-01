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
  PHYSICS_OP_OUT_BUFFER,
  RECORDED_PHYSICS_METHODS,
  serializeWorldLog,
  type SkillCommand,
  type WorldCommand,
  type WorldLogMeta,
} from "./log.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Deep-clone a skill input for the recorded command (a defensive snapshot, so a
// later mutation of the caller's object cannot rewrite an already-recorded call).
//
// This REPLACES `JSON.parse(JSON.stringify(input))`, which silently CORRUPTS
// replay determinism: it coerces NaN / +-Infinity to `null`, collapses -0 to 0,
// and DROPS `undefined`-valued properties. Here numbers are copied by value, so
// finite floats are byte-identical to before (existing recordings are unchanged)
// AND non-finite floats / -0 / explicit `undefined` survive exactly. Values that
// cannot be faithfully recorded/replayed (BigInt, functions, symbols) and circular
// references THROW a clear error instead of being silently mangled.
//
// NOTE: this preserves values in the IN-MEMORY command (the in-process replay
// path). On-wire (toJsonl) non-finite numbers remain a JSON limitation; finite
// values -- the only shape validated skill inputs carry -- round-trip unchanged.
// `undefined`-valued OBJECT KEYS are dropped (as JSON.stringify would), so the
// in-memory command and its serialized-then-parsed on-disk twin carry the SAME
// key set -- memory-replay and disk-replay stay byte-consistent.
function cloneInput(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean" || t === "undefined") return value;
  if (t === "bigint") throw new Error("WorldRecorder: cannot record a BigInt skill input (not replay-serializable)");
  if (t === "function" || t === "symbol") throw new Error(`WorldRecorder: cannot record a ${t} skill input`);
  const obj = value as object;
  if (seen.has(obj)) throw new Error("WorldRecorder: cannot record a circular skill input");
  seen.add(obj);
  // Mirror JSON.stringify: a value exposing toJSON() serializes as that result, so
  // clone the toJSON() output -- otherwise a Date/custom-serializer input would be an
  // empty object {} in memory yet its toJSON string on disk, diverging the two replay
  // paths. Cloning the toJSON result keeps the in-memory command and its on-disk twin
  // identical.
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    seen.delete(obj);
    return cloneInput((toJSON as () => unknown).call(obj), seen);
  }
  let out: unknown;
  if (Array.isArray(obj)) {
    const arr = new Array<unknown>(obj.length);
    for (let i = 0; i < obj.length; i++) arr[i] = cloneInput((obj as unknown[])[i], seen);
    out = arr;
  } else {
    const rec: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const cv = cloneInput((obj as Record<string, unknown>)[k], seen);
      // Drop `undefined`-valued keys so the clone matches JSON's on-disk key set
      // (JSON.stringify omits them) -- otherwise memory-replay would carry a key
      // that disk-replay does not, diverging the two replay paths.
      if (cv !== undefined) rec[k] = cv;
    }
    out = rec;
  }
  seen.delete(obj);
  return out;
}

export class WorldRecorder {
  readonly commands: WorldCommand[] = [];
  /** Current simulation tick; the scenario updates it each loop iteration. */
  tick = 0;
  private seq = 0;
  private depth = 0;
  /** Set while a TOP-LEVEL invoke chain is in flight (from the invoke that starts
   *  at depth 0 until it and every concurrent sibling/child has settled). Recording
   *  is classified by THIS flag -- not the raw depth counter, which fire-and-forget
   *  sibling invokes inflate -- so exactly one command is recorded per top-level
   *  chain and never mis-attributed. */
  private topInFlight = false;
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
            // Ops with a trailing out-buffer (e.g. move_character) carry no input in
            // that buffer; record only the leading scalar inputs so the logged args
            // stay `number[]` (replay re-supplies a fresh scratch buffer).
            const args2 =
              PHYSICS_OP_OUT_BUFFER[opName] === undefined ? args.slice() : args.slice(0, args.length - 1);
            rec.commands.push({ kind: "physics", seq: rec.seq++, tick, op: opName, args: args2 });
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
      // Classify by the top-level-in-flight flag, NOT the raw depth counter:
      // fire-and-forget sibling invokes (e.g. character_model's `void invoke("animation.stop"); void invoke("animation.play")`)
      // are issued back-to-back without awaiting, so the second enters at depth > 0
      // even though it is not nested inside the first. The flag records exactly the
      // invoke that OPENS a top-level chain and treats every later entrant while the
      // chain is live as nested (reproduced by re-invoking the recorded top-level).
      const topLevel = !rec.topInFlight;
      // Hold a reference to the command we record for the top-level invoke so the
      // post-invoke commit-back (below) can pin resolved identity into it.
      let cmd: SkillCommand | undefined;
      if (topLevel) {
        rec.topInFlight = true;
        const tick = base.tick;
        if (tick > rec.maxTick) rec.maxTick = tick;
        cmd = {
          kind: "skill",
          seq: rec.seq++,
          tick,
          tool: name,
          input: input === undefined ? undefined : cloneInput(input),
          actorId: base.agentId,
          sessionId: base.sessionId,
          perms: [...base.permissions].sort(),
        };
        rec.commands.push(cmd);
      }
      // Under the single-threaded server loop every top-level invoke is awaited to
      // completion before the next, so `topInFlight` is false on entry for each and it
      // is recorded. Any invoke arriving while a chain is live -- a fire-and-forget
      // nested sibling (character_model's `void invoke(...)` pair) or a re-entrant child
      // -- is folded into that chain and not separately recorded, reproduced by
      // re-invoking the recorded top-level. Truly-CONCURRENT top-level invocations do
      // not occur under this driver and are not detected here: distinguishing them from
      // legitimate nesting needs async-context tracking (an explicit token / AsyncLocal),
      // not the depth counter, so callers must not overlap top-level invokes.
      // depth must drop whether the invoke resolves or rejects (re-entrancy guard);
      // the flag clears only once the whole chain has drained back to depth 0.
      ++rec.depth;
      return original(name, input, base)
        .then((res) => {
          // COMMIT-BACK: copy the skill's declared commitFields from its OUTPUT into
          // the recorded command's input, so the replay log PINS authored-resolved
          // identity (e.g. asset.place's content hash). Author-supplied input wins;
          // we only fill fields the author left undefined.
          if (cmd !== undefined && res.success) {
            const def = registry.describe(name);
            const fields = def?.commitFields;
            if (fields !== undefined && fields.length > 0 && isRecord(res.result)) {
              const into = isRecord(cmd.input) ? (cmd.input as Record<string, unknown>) : (cmd.input = {} as Record<string, unknown>);
              for (const f of fields) {
                if (into[f] === undefined && f in res.result) into[f] = (res.result as Record<string, unknown>)[f];
              }
            }
          }
          return res;
        })
        .finally(() => {
          // Never throw here: a depth mismatch just means a concurrent sibling/child
          // is still in flight (legitimate for fire-and-forget nested invokes), which
          // must behave exactly as before. The flag clears only when the last frame of
          // the chain drains back to depth 0.
          if (--rec.depth === 0) rec.topInFlight = false;
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
