// limina observability — EventLoom-shaped events written to limina's OWN
// per-session thread file. Same envelope field names as Zaxy's on-disk format
// (id/type/actorId/threadId/parentEventId/causedBy/timestamp/payload/integrity)
// so a persistence layer reads it with no schema change; limina does NOT append
// to Zaxy's chain (that's a Phase 2 bridge via Zaxy's API).
//
// Hot path stays hash-free: emit assigns a structured id with a cheap FNV
// discriminator; the cryptographic sha256 integrity chain is computed lazily in
// export() (off the frame loop).

import { ops } from "../engine.ts";

export interface EngineEvent {
  id: string; // evt_<actor>_<seq:012d>_<fnv16>
  type: string;
  actorId: string;
  threadId: string;
  parentEventId: string | null;
  causedBy: string[];
  timestamp: string;
  payload: unknown;
  integrity?: { hash: string; previousHash: string | null };
}

export type EmitInput = Omit<EngineEvent, "id" | "timestamp" | "integrity">;

export interface InspectorSnapshot {
  threadId: string;
  eventCount: number;
  actors: string[];
  recent: EngineEvent[];
}

export type PartialFinalLinePolicy = "error" | "ignore";

export interface TraceReplayOptions {
  onPartialFinalLine?: PartialFinalLinePolicy;
}

export interface AppendOnEmitTraceOptions extends TraceReplayOptions {
  recoverPartialFinalLine?: boolean;
}

export interface TraceReplayResult {
  threadId: string | null;
  events: EngineEvent[];
  byId: Map<string, EngineEvent>;
  parentsById: Map<string, EngineEvent[]>;
  childrenById: Map<string, EngineEvent[]>;
  partialFinalLine?: string;
}

export type TraceIntegrityReason =
  | "invalid_json"
  | "partial_final_line"
  | "missing_integrity"
  | "previous_hash_mismatch"
  | "hash_mismatch";

export class TraceIntegrityError extends Error {
  constructor(
    public readonly reason: TraceIntegrityReason,
    public readonly lineNumber: number,
    message: string,
  ) {
    super(message);
    this.name = "TraceIntegrityError";
  }
}

export interface TraceTailOptions {
  afterSeq?: number;
  limit?: number;
  actorId?: string;
  type?: string;
}

export interface TraceTailResult {
  events: EngineEvent[];
  nextAfterSeq: number | null;
}

export interface TraceExplanation {
  event: EngineEvent;
  parents: EngineEvent[];
  children: EngineEvent[];
}

export interface Tracer {
  emit(e: EmitInput): string;
  trace(actorId: string, sinceTick?: number): EngineEvent[];
  exportJsonl(): string;
  inspect(): InspectorSnapshot;
}

/** 64-bit FNV-1a -> 16 hex. Cheap, non-crypto id discriminator (NOT the chain). */
function fnv1a16(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic JSON (sorted keys) so the integrity hash is stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  // value is a non-null, non-array object here; read it as a string-keyed record.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
    .join(",") + "}";
}

function canonicalEvent(ev: EngineEvent): string {
  // NB: `timestamp` is intentionally EXCLUDED so the sha256 integrity chain is
  // reproducible across runs of the same command stream (wall-clock must not
  // leak into the hash). The human-readable `timestamp` still rides on the
  // emitted/exported event object for display; it is just not hashed.
  return stableStringify({
    id: ev.id, type: ev.type, actorId: ev.actorId, threadId: ev.threadId,
    parentEventId: ev.parentEventId, causedBy: ev.causedBy,
    payload: ev.payload,
  });
}

function hashEvent(ev: EngineEvent, previousHash: string | null): string {
  return "sha256:" + ops.op_sha256(canonicalEvent(ev) + (previousHash ?? ""));
}

function withoutIntegrity(ev: EngineEvent): EngineEvent {
  return {
    id: ev.id,
    type: ev.type,
    actorId: ev.actorId,
    threadId: ev.threadId,
    parentEventId: ev.parentEventId,
    causedBy: [...ev.causedBy],
    timestamp: ev.timestamp,
    payload: ev.payload,
  };
}

function eventSeq(id: string): number | null {
  const match = /^evt_.+_(\d{12})_[0-9a-f]{16}$/.exec(id);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

function completeJsonlLines(jsonl: string, policy: PartialFinalLinePolicy): { lines: string[]; partialFinalLine?: string } {
  if (jsonl.length === 0) return { lines: [] };
  const raw = jsonl.split("\n");
  const final = raw[raw.length - 1] ?? "";
  if (final === "") return { lines: raw.slice(0, -1) };
  try {
    JSON.parse(final);
    return { lines: raw };
  } catch {
    // Fall through to the deterministic torn-final-line policy below.
  }
  if (policy === "ignore") return { lines: raw.slice(0, -1), partialFinalLine: final };
  throw new TraceIntegrityError("partial_final_line", raw.length, "trace has an incomplete final JSONL line");
}

export class LiminaTracer implements Tracer {
  private seq = 0;
  private readonly events: EngineEvent[] = [];
  private readonly durableEvents: EngineEvent[] = [];
  private appendTraceName: string | undefined;
  private lastIntegrityHash: string | null = null;
  private replayCache: TraceReplayResult | undefined;
  constructor(
    private readonly threadId: string,
    private readonly maxInMemory = 8192,
    private readonly retainDurableInMemory = true,
  ) {}

  private enableAppend(name: string): LiminaTracer {
    this.appendTraceName = name;
    this.lastIntegrityHash = lastIntegrityHash(this.durableEvents);
    return this;
  }

  emit(e: EmitInput): string {
    const seq = this.seq;
    const timestamp = new Date().toISOString();
    const body = stableStringify({ seq, type: e.type, actorId: e.actorId, payload: e.payload });
    const id = `evt_${e.actorId}_${String(seq).padStart(12, "0")}_${fnv1a16(body)}`;
    const event = { id, timestamp, ...e };
    if (this.appendTraceName !== undefined) {
      const hash = hashEvent(event, this.lastIntegrityHash);
      const withIntegrity: EngineEvent = { ...event, integrity: { hash, previousHash: this.lastIntegrityHash } };
      ops.op_append_trace(this.appendTraceName, JSON.stringify(withIntegrity) + "\n");
      this.lastIntegrityHash = hash;
    }
    this.seq++;
    this.events.push(event);
    if (this.appendTraceName === undefined && this.retainDurableInMemory) this.durableEvents.push(event);
    this.replayCache = undefined;
    // Bounded tail: keep the most recent maxInMemory (full history -> export/flush).
    if (this.events.length > this.maxInMemory) this.events.shift();
    return id;
  }
  trace(actorId: string, sinceTick?: number): EngineEvent[] {
    return this.events.filter((ev) => {
      if (ev.actorId !== actorId) return false;
      if (sinceTick === undefined) return true;
      const p = ev.payload;
      if (p !== null && typeof p === "object" && "tick" in p) {
        const tick = p.tick; // unknown after `in` narrowing
        return typeof tick === "number" ? tick >= sinceTick : true;
      }
      return true;
    });
  }

  /** Serialize to EventLoom-shaped JSONL, computing the sha256 integrity chain
   *  here (genesis previousHash=null; previousHash(N)=hash(N-1)). */
  exportJsonl(): string {
    if (this.appendTraceName !== undefined) return ops.op_read_trace(this.appendTraceName);
    if (!this.retainDurableInMemory) return serializeEvents(this.events);
    return serializeEvents(this.durableEvents);
  }

  durableEventCount(): number {
    if (this.appendTraceName !== undefined) return this.replay().events.length;
    if (!this.retainDurableInMemory) return this.events.length;
    return this.durableEvents.length;
  }

  flush(name: string): { name: string; events: number; bytes: number } {
    const content = this.exportJsonl();
    ops.op_write_trace(name, content);
    return { name, events: this.durableEventCount(), bytes: content.length };
  }

  tail(opts: TraceTailOptions = {}): TraceTailResult {
    const afterSeq = opts.afterSeq ?? -1;
    const limit = Math.max(0, Math.min(opts.limit ?? 100, 1000));
    const source = this.appendTraceName !== undefined
      ? this.replay().events
      : this.retainDurableInMemory ? this.durableEvents : this.events;
    const events = source.filter((ev) => {
      const seq = eventSeq(ev.id);
      if (seq === null || seq <= afterSeq) return false;
      if (opts.actorId !== undefined && ev.actorId !== opts.actorId) return false;
      if (opts.type !== undefined && ev.type !== opts.type) return false;
      return true;
    }).slice(0, limit);
    const last = events.length > 0 ? eventSeq(events[events.length - 1].id) : null;
    return { events, nextAfterSeq: last };
  }

  explainEvent(eventId: string): TraceExplanation | undefined {
    const replay = this.replay();
    const event = replay.byId.get(eventId);
    if (event === undefined) return undefined;
    return {
      event,
      parents: replay.parentsById.get(eventId) ?? [],
      children: replay.childrenById.get(eventId) ?? [],
    };
  }

  /** The full durable history with a resolved causal index (byId / parentsById /
   *  childrenById) — the M8 audit surface walks this to answer "why was X
   *  allowed/denied" from the real recorded events. */
  replay(): TraceReplayResult {
    if (this.appendTraceName !== undefined) return LiminaTracer.replayTrace(this.appendTraceName);
    if (this.replayCache === undefined) {
      this.replayCache = buildReplay(this.retainDurableInMemory ? this.durableEvents : this.events);
    }
    return this.replayCache;
  }

  inspect(): InspectorSnapshot {
    const actors = [...new Set(this.events.map((e) => e.actorId))];
    return {
      threadId: this.threadId,
      eventCount: this.events.length,
      actors,
      recent: this.events.slice(-20),
    };
  }

  static replayTrace(name: string, opts: TraceReplayOptions = {}): TraceReplayResult {
    return LiminaTracer.replayJsonl(ops.op_read_trace(name), opts);
  }

  static fromTrace(name: string, maxInMemory = 8192, opts: TraceReplayOptions = {}): LiminaTracer {
    return LiminaTracer.fromJsonl(ops.op_read_trace(name), maxInMemory, opts);
  }

  static appendOnEmit(threadId: string, name: string, maxInMemory = 8192, opts: AppendOnEmitTraceOptions = {}): LiminaTracer {
    const recoverPartialFinalLine = opts.recoverPartialFinalLine ?? true;
    let jsonl = "";
    try {
      jsonl = ops.op_read_trace(name);
    } catch {
      ops.op_write_trace(name, "");
    }
    const replayOpts: TraceReplayOptions = {
      ...opts,
      onPartialFinalLine: recoverPartialFinalLine ? "ignore" : opts.onPartialFinalLine,
    };
    let replay: TraceReplayResult;
    try {
      replay = LiminaTracer.replayJsonl(jsonl, replayOpts);
    } catch (err) {
      if (!recoverPartialFinalLine || !(err instanceof TraceIntegrityError)) throw err;
      const lines = jsonl.split("\n");
      const prefixLineCount = Math.max(0, err.lineNumber - 1);
      const prefix = prefixLineCount === 0 ? "" : lines.slice(0, prefixLineCount).join("\n") + "\n";
      replay = LiminaTracer.replayJsonl(prefix, { ...opts, onPartialFinalLine: "error" });
      ops.op_write_trace(name, serializeEvents(replay.events.map(withoutIntegrity)));
    }
    const tracer = LiminaTracer.fromReplay(replay, maxInMemory, false);
    tracer.appendTraceName = name;
    if (tracer.threadId !== threadId && replay.events.length === 0) {
      return new LiminaTracer(threadId, maxInMemory).enableAppend(name);
    }
    tracer.lastIntegrityHash = integrityTail(replay.events);
    if (recoverPartialFinalLine && replay.partialFinalLine !== undefined) ops.op_write_trace(name, serializeEvents(replay.events.map(withoutIntegrity)));
    return tracer;
  }

  static ephemeral(threadId: string, maxInMemory = 8192): LiminaTracer {
    return new LiminaTracer(threadId, maxInMemory, false);
  }

  static fromJsonl(jsonl: string, maxInMemory = 8192, opts: TraceReplayOptions = {}): LiminaTracer {
    const replay = LiminaTracer.replayJsonl(jsonl, opts);
    return LiminaTracer.fromReplay(replay, maxInMemory, true);
  }

  private static fromReplay(replay: TraceReplayResult, maxInMemory: number, keepDurable: boolean): LiminaTracer {
    const tracer = new LiminaTracer(replay.threadId ?? "trace_replay", maxInMemory);
    let maxSeq = -1;
    for (const ev of replay.events) {
      const clean = withoutIntegrity(ev);
      if (keepDurable) tracer.durableEvents.push(clean);
      tracer.events.push(clean);
      const seq = eventSeq(ev.id);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
    while (tracer.events.length > maxInMemory) tracer.events.shift();
    tracer.seq = maxSeq + 1;
    tracer.lastIntegrityHash = keepDurable ? lastIntegrityHash(tracer.durableEvents) : integrityTail(replay.events);
    return tracer;
  }

  static replayJsonl(jsonl: string, opts: TraceReplayOptions = {}): TraceReplayResult {
    const policy = opts.onPartialFinalLine ?? "error";
    const { lines, partialFinalLine } = completeJsonlLines(jsonl, policy);
    const events: EngineEvent[] = [];
    let previousHash: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TraceIntegrityError("invalid_json", lineNumber, `invalid trace JSON at line ${lineNumber}: ${message}`);
      }
      const ev = parsed as EngineEvent;
      if (ev.integrity === undefined || typeof ev.integrity.hash !== "string") {
        throw new TraceIntegrityError("missing_integrity", lineNumber, `trace line ${lineNumber} is missing integrity`);
      }
      if (ev.integrity.previousHash !== previousHash) {
        throw new TraceIntegrityError("previous_hash_mismatch", lineNumber, `trace line ${lineNumber} previousHash mismatch`);
      }
      const expected = hashEvent(ev, previousHash);
      if (ev.integrity.hash !== expected) {
        throw new TraceIntegrityError("hash_mismatch", lineNumber, `trace line ${lineNumber} hash mismatch`);
      }
      events.push(ev);
      previousHash = ev.integrity.hash;
    }
    return { ...buildReplay(events), partialFinalLine };
  }
}

function lastIntegrityHash(events: EngineEvent[]): string | null {
  let previousHash: string | null = null;
  for (const ev of events) {
    previousHash = hashEvent(ev, previousHash);
  }
  return previousHash;
}

function integrityTail(events: EngineEvent[]): string | null {
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  return last.integrity?.hash ?? lastIntegrityHash(events.map(withoutIntegrity));
}

function serializeEvents(events: EngineEvent[]): string {
  let previousHash: string | null = null;
  const lines: string[] = [];
  for (const ev of events) {
    const clean = withoutIntegrity(ev);
    const hash = hashEvent(clean, previousHash);
    const withIntegrity: EngineEvent = { ...clean, integrity: { hash, previousHash } };
    lines.push(JSON.stringify(withIntegrity));
    previousHash = hash;
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

function buildReplay(events: EngineEvent[]): TraceReplayResult {
  const byId = new Map<string, EngineEvent>();
  const parentsById = new Map<string, EngineEvent[]>();
  const childrenById = new Map<string, EngineEvent[]>();
  let threadId: string | null = null;
  for (const ev of events) {
    byId.set(ev.id, ev);
    if (threadId === null) threadId = ev.threadId;
  }
  for (const ev of events) {
    const parents: EngineEvent[] = [];
    const parentIds = ev.parentEventId === null ? ev.causedBy : [ev.parentEventId, ...ev.causedBy];
    for (const parentId of new Set(parentIds)) {
      const parent = byId.get(parentId);
      if (parent === undefined) continue;
      parents.push(parent);
      const children = childrenById.get(parentId) ?? [];
      children.push(ev);
      childrenById.set(parentId, children);
    }
    parentsById.set(ev.id, parents);
  }
  return { threadId, events, byId, parentsById, childrenById };
}
