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
import { skillEffect, type InvokeBase, type SkillRegistry } from "../skills/registry.ts";
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
import { IdleStepFilter } from "./step-filter.ts";

// Approval controls resolve parked intents; they are not world mutations. A grant
// re-enters the registry with the original skill, which is the only command replay
// needs. Recording both makes replay depend on a transient approval queue and puts
// the control command before the mutation it applies.
const NON_REPLAYABLE_CONTROL_SKILLS = new Set(["approval.grant", "approval.deny"]);

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

export interface WorldRecorderOptions {
  /** Idle-step cut (kernel K-compaction): when true, a depth-0 `step` op is APPLIED as always but
   *  RECORDED only if it could have changed replay-relevant state (any tracked dynamic body's
   *  transform changed bit-wise, or within a short grace window after activity -- see
   *  step-filter.ts for the full correctness argument). Long-lived servers enable this so an idle
   *  session stops appending one step record per tick to the durable log (measured: 99.98% of a
   *  real editor session's log was idle steps, and boot rehydrate replays the whole history).
   *  Default false: scenario/test recorders keep the historical record-every-step behavior. */
  filterIdleSteps?: boolean;
}

export class WorldRecorder {
  readonly commands: WorldCommand[] = [];
  /** Current simulation tick; the scenario updates it each loop iteration. */
  tick = 0;
  /** Depth-0 steps applied but NOT recorded by the idle-step filter (see filterIdleSteps). */
  droppedIdleSteps = 0;
  private readonly stepFilter?: IdleStepFilter;
  private seq = 0;
  private depth = 0;
  /** Chain-id minted per TOP-LEVEL invocation; a nested re-invoke inherits its
   *  parent's id via `ExecutionContext.chainId`. Classification is by this id, NOT
   *  by a global depth/flag counter: a flag cannot tell an INDEPENDENT concurrent
   *  top-level chain (a second agent acting while the first awaits) from a genuine
   *  child (a skill handler re-invoking), so under concurrency it silently dropped
   *  the second agent's command. The id travels in the data, so it is immune to
   *  single-thread interleaving. */
  private chainSeq = 0;
  private readonly finalizedSeqs = new Set<number>();
  private finalizedPrefix = 0;
  private compactedPrefix = 0;
  private maxTick = 0;
  private seeded = false;
  /** K4 (worldlog poll -> subscribe) listener seam: see onFinalized(). */
  private readonly finalizedListeners: Array<(finalizedCount: number) => void> = [];

  constructor(readonly sessionId: string, opts: WorldRecorderOptions = {}) {
    if (opts.filterIdleSteps === true) this.stepFilter = new IdleStepFilter();
  }

  /** Record + install the deterministic PRNG seed. Call once, before any
   *  command that could consume randomness. */
  seed(seed: number, opts: { forceInstall?: boolean } = {}): () => number {
    if (this.seeded) throw new Error("WorldRecorder: seed already recorded");
    this.seeded = true;
    const seq = this.seq++;
    this.commands.push({ kind: "seed", seq, seed: seed >>> 0 });
    this.markFinalized(seq);
    return installSeededRandom(seed, opts.forceInstall === true);
  }

  /** Wrap an EngineOps so mutating physics ops issued at depth 0 are recorded.
   *  Reads and host services pass straight through. */
  wrapOps(ops: EngineOps): EngineOps {
    const rec = this;
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(ops, {
      get(target, prop, receiver) {
        if (methods.has(prop)) return methods.get(prop);
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        // `value` is a verified EngineOps method; give it a callable signature.
        const method = value as (...a: number[]) => unknown;
        const opName = typeof prop === "string" ? RECORDED_PHYSICS_METHODS[prop] : undefined;
        if (opName === undefined) {
          const bound = method.bind(target);
          methods.set(prop, bound);
          return bound;
        }
        const wrapped = (...args: number[]): unknown => {
          const filter = rec.stepFilter;
          if (filter !== undefined && opName === "step") {
            // IDLE-STEP CUT (kernel K-compaction): a step is pure sim output, so unlike every
            // other op it is applied FIRST and recorded only if the post-step world says the tick
            // could matter to replay (a tracked dynamic body moved bit-wise, or we are inside the
            // post-activity grace window). A dropped step leaves replay bit-identical -- see the
            // correctness argument in step-filter.ts. Live behavior is untouched either way: the
            // native step always runs; only its LOG RECORD is conditional.
            const result = method.apply(target, args);
            if (rec.depth === 0) {
              const tick = rec.tick;
              if (tick > rec.maxTick) rec.maxTick = tick;
              if (filter.shouldRecordStep(target)) {
                const seq = rec.seq++;
                rec.commands.push({ kind: "physics", seq, tick, op: "step", args: [] });
                rec.markFinalized(seq);
              } else {
                rec.droppedIdleSteps++;
              }
            } else {
              // A nested (in-skill) step is reproduced by its skill command, not recorded here --
              // but it advanced the sim behind the filter's cache, so signal activity.
              filter.observe("step", args, result);
            }
            return result;
          }
          if (rec.depth === 0) {
            const tick = rec.tick;
            if (tick > rec.maxTick) rec.maxTick = tick;
            // Ops with a trailing out-buffer (e.g. move_character) carry no input in
            // that buffer; record only the leading scalar inputs so the logged args
            // stay `number[]` (replay re-supplies a fresh scratch buffer).
            const args2 =
              PHYSICS_OP_OUT_BUFFER[opName] === undefined ? args.slice() : args.slice(0, args.length - 1);
            const seq = rec.seq++;
            rec.commands.push({ kind: "physics", seq, tick, op: opName, args: args2 });
            rec.markFinalized(seq);
          }
          const result = method.apply(target, args);
          // The filter tracks dynamic bodies across EVERY wrapped op at ANY depth (skills call
          // this same proxy), so its body set stays complete even for ops the log doesn't record.
          filter?.observe(opName, args, result);
          return result;
        };
        methods.set(prop, wrapped);
        return wrapped;
      },
    });
  }

  /** Patch a registry instance's invoke() to record each top-level invocation.
   *  Nested invokes (a skill handler re-invoking with the inherited `ctx.chainId`)
   *  are NOT recorded -- re-invoking the outer skill reproduces them.
   *
   *  Classification is by CHAIN ID, not a depth/flag counter. A top-level caller
   *  (an agent action loop, an MCP callTool, scenario code) passes NO `chainId`;
   *  we mint one and record the command. A skill handler that re-invokes passes
   *  `ctx.chainId`, so that nested call is folded into the already-recorded parent.
   *  Because the id is carried in the data rather than in ambient async state, this
   *  stays correct when independent top-level chains INTERLEAVE on this single
   *  thread (a coordinated agent team): each agent's chain has its own id, so each
   *  records exactly one command and none is silently dropped. (The embedded
   *  deno_core host does not wire AsyncLocalStorage, so ambient context is not an
   *  option.) `depth` is retained solely for the ops proxy (a physics op is recorded
   *  only when issued outside any skill chain). */
  attach(registry: SkillRegistry): void {
    const rec = this;
    const original = registry.invoke.bind(registry);
    registry.invoke = function patched(name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
      const isHead = base.chainId === undefined;
      const chainId = base.chainId ?? `chain_${rec.chainSeq++}`;
      // Hold a reference to the command we record for the top-level invoke so the
      // post-invoke commit-back (below) can pin resolved identity into it.
      let cmd: SkillCommand | undefined;
      if (isHead) {
        // Pure READ-ONLY skills are OBSERVATIONS, not authoring -- don't record them.
        // The live editor polls worldlog.tail / inspector.snapshot / trace.tail every
        // tick; recording each bloated the world log ~25x (2500+ reads vs ~100 real
        // mutations in a dev session) and, with compactFlushed off, grew editor_host
        // memory unbounded -- the long-running-host degradation. SkillDefinition.effect
        // is the single authority shared with AuthoritativeServer. Missing metadata is
        // conservatively a write, so an annotation error cannot evade recording.
        const def = registry.describe(name);
        const readOnly = def !== undefined && skillEffect(def) === "read";
        if (!readOnly && !NON_REPLAYABLE_CONTROL_SKILLS.has(name)) {
          const tick = base.tick;
          if (tick > rec.maxTick) rec.maxTick = tick;
          const seq = rec.seq++;
          cmd = {
            kind: "skill",
            seq,
            tick,
            tool: name,
            input: input === undefined ? undefined : cloneInput(input),
            actorId: base.agentId,
            sessionId: base.sessionId,
            perms: [...base.permissions].sort(),
          };
          rec.commands.push(cmd);
        }
      }
      // `depth` governs the OPS proxy (a physics op is recorded iff issued OUTSIDE
      // any skill chain); increment it around the whole chain, decrement on settle.
      ++rec.depth;
      const childBase: InvokeBase = { ...base, chainId };
      return original(name, input, childBase)
        .then((res) => {
          if (cmd !== undefined && !res.success) {
            rec.discardCommand(cmd.seq);
            cmd = undefined;
            return res;
          }
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
        }, (err) => {
          if (cmd !== undefined) {
            rec.discardCommand(cmd.seq);
            cmd = undefined;
          }
          throw err;
        })
        .finally(() => {
          // Never throw here: a depth mismatch just means a concurrent sibling/child
          // is still in flight, which must behave exactly as before. Each HEAD removes
          // only its OWN chain id; a nested call (not a head) leaves the set untouched.
          --rec.depth;
          if (isHead) {
            if (cmd !== undefined) rec.markFinalized(cmd.seq);
          }
        });
    };
  }

  private markFinalized(seq: number): void {
    this.finalizedSeqs.add(seq);
    this.advanceFinalizedPrefix();
  }

  /** Advance only across the contiguous settled prefix. Notify once for every
   * newly exposed command so subscribers cannot lose completion boundaries when
   * several later commands finished while an earlier command was pending. */
  private advanceFinalizedPrefix(): void {
    while (this.finalizedPrefix < this.commands.length) {
      const cmd = this.commands[this.finalizedPrefix];
      if (cmd === undefined || !this.finalizedSeqs.has(cmd.seq)) break;
      this.finalizedSeqs.delete(cmd.seq);
      this.finalizedPrefix += 1;
      const finalizedCount = this.compactedPrefix + this.finalizedPrefix;
      for (const listener of [...this.finalizedListeners]) listener(finalizedCount);
    }
  }

  /** K4 (worldlog poll -> subscribe): register a listener invoked once for each
   *  command newly admitted to the contiguous finalized prefix. Out-of-order
   *  completions wait behind the gap; closing a failed gap emits one boundary for
   *  each already-settled successor. Multiple listeners may register; call the
   *  returned function to unsubscribe. */
  onFinalized(listener: (finalizedCount: number) => void): () => void {
    this.finalizedListeners.push(listener);
    return () => {
      const idx = this.finalizedListeners.indexOf(listener);
      if (idx !== -1) this.finalizedListeners.splice(idx, 1);
    };
  }

  private discardCommand(seq: number): void {
    const idx = this.commands.findIndex((cmd) => cmd.seq === seq);
    if (idx >= this.finalizedPrefix && idx !== -1) {
      this.finalizedSeqs.delete(seq);
      this.commands.splice(idx, 1);
      const renumbered = new Set<number>();
      for (let i = idx; i < this.commands.length; i++) {
        const before = this.commands[i].seq;
        this.commands[i].seq = before - 1;
        if (this.finalizedSeqs.has(before)) {
          this.finalizedSeqs.delete(before);
          renumbered.add(before - 1);
        }
      }
      for (const n of renumbered) this.finalizedSeqs.add(n);
      this.seq -= 1;
      // A failed earlier command may have been the only gap ahead of commands
      // that already settled. Removing it exposes each of those commands now.
      this.advanceFinalizedPrefix();
      return;
    }
    this.finalizedSeqs.delete(seq);
  }

  /** Contiguous command prefix whose async handlers and commit-back have settled. */
  flushableCount(): number {
    return this.compactedPrefix + this.finalizedPrefix;
  }

  /** Total commands recorded in this session, including commands compacted out of
   *  the hot in-memory buffer after durable persistence. */
  get commandCount(): number {
    return this.compactedPrefix + this.commands.length;
  }

  /** Return a command by absolute log index (seq-order position), or undefined
   *  when it has already been compacted from memory. */
  commandAt(index: number): WorldCommand | undefined {
    if (!Number.isSafeInteger(index) || index < this.compactedPrefix) return undefined;
    return this.commands[index - this.compactedPrefix];
  }

  /** Drop a durable-flushed finalized prefix from hot memory. The durable sink must
   *  already have persisted every removed command; after compaction, toJsonl() is no
   *  longer available because full history lives in the durable segment. */
  compactFinalizedPrefix(upTo: number): number {
    const limit = Math.min(upTo, this.flushableCount());
    if (limit <= this.compactedPrefix) return 0;
    const drop = limit - this.compactedPrefix;
    this.commands.splice(0, drop);
    this.compactedPrefix += drop;
    this.finalizedPrefix -= drop;
    if (this.finalizedPrefix < 0) this.finalizedPrefix = 0;
    return drop;
  }

  get compactedCommandCount(): number {
    return this.compactedPrefix;
  }

  meta(): WorldLogMeta {
    return {
      kind: "meta",
      logVersion: LOG_VERSION,
      sessionId: this.sessionId,
      createdAt: `tick:${this.maxTick}`,
      commands: this.commandCount,
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
    if (this.compactedPrefix > 0) {
      throw new Error("WorldRecorder.toJsonl: command prefix was compacted; read the durable world log segment for full history");
    }
    return serializeWorldLog(this.meta(), this.commands);
  }
}
