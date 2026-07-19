// limina observability — EventLoom-shaped events written to limina's OWN
// durable trace file. A file is one globally ordered, sha256-chained stream;
// each event retains its logical threadId, so a shared authoritative server may
// record several client sessions without splitting or weakening the chain.
// Same envelope field names as Zaxy's on-disk format
// (id/type/actorId/threadId/parentEventId/causedBy/timestamp/payload/integrity)
// so a persistence layer reads it with no schema change; limina does NOT append
// to Zaxy's chain (that's a Phase 2 bridge via Zaxy's API).
//
// The in-memory hot path stays hash-free: emit assigns a structured id with a
// cheap FNV discriminator and export() computes the chain lazily. Append-backed
// authoritative tracing hashes at its explicit durable boundary.

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
  /** The sole logical event thread when every event belongs to one thread;
   * null for an empty or mixed-thread durable stream. */
  threadId: string | null;
  /** Logical event threads in first-appearance order. A durable trace is one
   * authenticated global sequence and may contain several client threads. */
  threadIds: readonly string[];
  events: readonly EngineEvent[];
  byId: ReadonlyMap<string, EngineEvent>;
  parentsById: ReadonlyMap<string, readonly EngineEvent[]>;
  childrenById: ReadonlyMap<string, readonly EngineEvent[]>;
  partialFinalLine?: string;
}

export type TraceIntegrityReason =
  | "invalid_json"
  | "partial_final_line"
  | "missing_integrity"
  | "previous_hash_mismatch"
  | "hash_mismatch"
  | "trace_truncated"
  | "trace_replaced"
  | "verified_prefix_modified";

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
  threadId?: string;
  type?: string;
}

export interface TraceTailResult {
  events: EngineEvent[];
  nextAfterSeq: number | null;
}

export interface TraceExplanation {
  event: EngineEvent;
  parents: readonly EngineEvent[];
  children: readonly EngineEvent[];
}

/** Deterministic work counters used by the scaling gate and operational
 * diagnostics. They measure work units, never wall time. */
export interface TraceWorkMetrics {
  deltaReads: number;
  deltaBytesRead: number;
  linesVerified: number;
  tailEntriesVisited: number;
  fullFileReads: number;
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

/** Fixed-capacity insertion-ordered ring. Unlike Array.shift(), eviction is
 * O(1) and never memmoves the retained window. */
class OrderedRing<T> {
  private readonly slots: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.slots = new Array<T | undefined>(this.capacity);
  }

  get length(): number { return this.count; }

  push(value: T): void {
    if (this.capacity === 0) return;
    if (this.count < this.capacity) {
      this.slots[(this.start + this.count) % this.capacity] = value;
      this.count++;
      return;
    }
    this.slots[this.start] = value;
    this.start = (this.start + 1) % this.capacity;
  }

  toArray(): T[] {
    const result = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.slots[(this.start + i) % this.capacity] as T;
    }
    return result;
  }
}

interface TraceDelta {
  identity: string;
  length: number;
  modifiedNs: string;
  start: number;
  end: number;
  content: string;
  cursorHash: string;
  endCursorHash: string;
}

interface MutableReplayIndex {
  threadId: string | null;
  threadIds: string[];
  threadIdSet: Set<string>;
  events: EngineEvent[];
  byId: Map<string, EngineEvent>;
  parentsById: Map<string, EngineEvent[]>;
  childrenById: Map<string, EngineEvent[]>;
  parentIdsById: Map<string, string[]>;
  linkedParentIdsByChildId: Map<string, Set<string>>;
  waitingChildrenByParentId: Map<string, EngineEvent[]>;
  seqs: Array<number | null>;
  seqsStrictlyIncreasing: boolean;
  view: TraceReplayResult;
}

interface AppendState {
  name: string;
  index: MutableReplayIndex;
  identity: string | null;
  offset: number;
  modifiedNs: string | null;
  cursorHash: string | null;
  partialFinalLine: string;
  nextLineNumber: number;
  previousHash: string | null;
  fault: TraceIntegrityError | null;
}

const ARRAY_MUTATORS = new Set<PropertyKey>([
  "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift",
]);

function readonlyArrayView<T>(source: T[]): readonly T[] {
  return new Proxy(source, {
    get(target, property) {
      if (ARRAY_MUTATORS.has(property)) {
        return () => { throw new TypeError("trace replay arrays are read-only"); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() { throw new TypeError("trace replay arrays are read-only"); },
    deleteProperty() { throw new TypeError("trace replay arrays are read-only"); },
    defineProperty() { throw new TypeError("trace replay arrays are read-only"); },
  });
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  constructor(private readonly source: Map<K, V>) {}
  get size(): number { return this.source.size; }
  get(key: K): V | undefined { return this.source.get(key); }
  has(key: K): boolean { return this.source.has(key); }
  entries(): MapIterator<[K, V]> { return this.source.entries(); }
  keys(): MapIterator<K> { return this.source.keys(); }
  values(): MapIterator<V> { return this.source.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.source.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.source[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "ReadonlyMap"; }
}

class ReadonlyArrayMapView<K, V> implements ReadonlyMap<K, readonly V[]> {
  private readonly views = new WeakMap<V[], readonly V[]>();
  constructor(private readonly source: Map<K, V[]>) {}
  get size(): number { return this.source.size; }
  private view(values: V[]): readonly V[] {
    const existing = this.views.get(values);
    if (existing !== undefined) return existing;
    const created = readonlyArrayView(values);
    this.views.set(values, created);
    return created;
  }
  get(key: K): readonly V[] | undefined {
    const values = this.source.get(key);
    return values === undefined ? undefined : this.view(values);
  }
  has(key: K): boolean { return this.source.has(key); }
  *entries(): MapIterator<[K, readonly V[]]> {
    for (const [key, values] of this.source) yield [key, this.view(values)];
  }
  keys(): MapIterator<K> { return this.source.keys(); }
  *values(): MapIterator<readonly V[]> {
    for (const values of this.source.values()) yield this.view(values);
  }
  forEach(callbackfn: (value: readonly V[], key: K, map: ReadonlyMap<K, readonly V[]>) => void, thisArg?: unknown): void {
    for (const [key, values] of this.source) callbackfn.call(thisArg, this.view(values), key, this);
  }
  [Symbol.iterator](): MapIterator<[K, readonly V[]]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "ReadonlyMap"; }
}

function freezeJsonValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJsonValue(child);
  return Object.freeze(value);
}

function newMutableReplayIndex(): MutableReplayIndex {
  const threadIds: string[] = [];
  const events: EngineEvent[] = [];
  const byId = new Map<string, EngineEvent>();
  const parentsById = new Map<string, EngineEvent[]>();
  const childrenById = new Map<string, EngineEvent[]>();
  const view: TraceReplayResult = {
    threadId: null,
    threadIds: readonlyArrayView(threadIds),
    events: readonlyArrayView(events),
    byId: new ReadonlyMapView(byId),
    parentsById: new ReadonlyArrayMapView(parentsById),
    childrenById: new ReadonlyArrayMapView(childrenById),
  };
  return {
    threadId: null,
    threadIds,
    threadIdSet: new Set(),
    events,
    byId,
    parentsById,
    childrenById,
    parentIdsById: new Map(),
    linkedParentIdsByChildId: new Map(),
    waitingChildrenByParentId: new Map(),
    seqs: [],
    seqsStrictlyIncreasing: true,
    view,
  };
}

function parseTraceDelta(raw: string): TraceDelta {
  const value = JSON.parse(raw) as Partial<TraceDelta>;
  if (
    typeof value.identity !== "string" || typeof value.length !== "number" ||
    typeof value.modifiedNs !== "string" || typeof value.start !== "number" ||
    typeof value.end !== "number" || typeof value.content !== "string" ||
    typeof value.cursorHash !== "string" || typeof value.endCursorHash !== "string"
  ) throw new Error("native trace delta returned an invalid response");
  return value as TraceDelta;
}

export class LiminaTracer implements Tracer {
  private seq = 0;
  private readonly events: OrderedRing<EngineEvent>;
  private readonly durableEvents: EngineEvent[] = [];
  private appendTraceName: string | undefined;
  private lastIntegrityHash: string | null = null;
  private replayCache: TraceReplayResult | undefined;
  /** Append mode owns a verified byte cursor, not the file or its event thread
   *  namespace. Every query catches up bounded suffixes first, so other valid
   *  appenders and logical threads are visible while any replacement,
   *  truncation, or corrupt suffix fails closed. */
  private appendState: AppendState | undefined;
  private readonly work: TraceWorkMetrics = {
    deltaReads: 0,
    deltaBytesRead: 0,
    linesVerified: 0,
    tailEntriesVisited: 0,
    fullFileReads: 0,
  };
  constructor(
    private readonly threadId: string,
    private readonly maxInMemory = 8192,
    private readonly retainDurableInMemory = true,
  ) {
    this.events = new OrderedRing<EngineEvent>(maxInMemory);
  }

  private enableAppend(name: string): LiminaTracer {
    this.appendTraceName = name;
    const index = newMutableReplayIndex();
    this.appendState = {
      name,
      index,
      identity: null,
      offset: 0,
      modifiedNs: null,
      cursorHash: null,
      partialFinalLine: "",
      nextLineNumber: 1,
      previousHash: null,
      fault: null,
    };
    return this;
  }

  emit(e: EmitInput): string {
    if (this.appendTraceName !== undefined) this.syncAppendTrace();
    const seq = this.seq;
    const timestamp = new Date().toISOString();
    const body = stableStringify({ seq, type: e.type, actorId: e.actorId, payload: e.payload });
    const id = `evt_${e.actorId}_${String(seq).padStart(12, "0")}_${fnv1a16(body)}`;
    const event = { id, timestamp, ...e };
    if (this.appendTraceName !== undefined) {
      const state = this.requireAppendState();
      if (state.partialFinalLine.length > 0) {
        throw new TraceIntegrityError(
          "partial_final_line",
          state.nextLineNumber,
          "cannot append while the durable trace has an incomplete final line",
        );
      }
      const hash = hashEvent(event, state.previousHash);
      const withIntegrity: EngineEvent = { ...event, integrity: { hash, previousHash: state.previousHash } };
      ops.op_append_trace(this.appendTraceName, JSON.stringify(withIntegrity) + "\n");
      // Verify what the durable path actually contains. Besides avoiding a
      // record-before-persist split, this catches an external append racing the
      // local writer and advances seq from every accepted durable event.
      this.syncAppendTrace();
      return id;
    }
    this.seq++;
    this.events.push(event);
    if (this.appendTraceName === undefined && this.retainDurableInMemory) this.durableEvents.push(event);
    this.replayCache = undefined;
    return id;
  }
  trace(actorId: string, sinceTick?: number): EngineEvent[] {
    if (this.appendTraceName !== undefined) this.syncAppendTrace();
    return this.events.toArray().filter((ev) => {
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
    if (this.appendTraceName !== undefined) {
      this.syncAppendTrace();
      this.work.fullFileReads++;
      return ops.op_read_trace(this.appendTraceName);
    }
    if (!this.retainDurableInMemory) return serializeEvents(this.events.toArray());
    return serializeEvents(this.durableEvents);
  }

  durableEventCount(): number {
    if (this.appendTraceName !== undefined) {
      this.syncAppendTrace();
      return this.requireAppendState().index.events.length;
    }
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
    if (this.appendTraceName !== undefined) {
      this.syncAppendTrace();
      const index = this.requireAppendState().index;
      const events: EngineEvent[] = [];
      let cursor = index.seqsStrictlyIncreasing ? upperBound(index.seqs as number[], afterSeq) : 0;
      let nextAfterSeq: number | null = null;
      for (; cursor < index.events.length && events.length < limit; cursor++) {
        this.work.tailEntriesVisited++;
        const ev = index.events[cursor];
        const seq = index.seqs[cursor];
        if (seq === null || seq <= afterSeq) continue;
        // Advance the cursor across non-matching events too. Otherwise a
        // filtered poll with no matches rescans the same suffix forever.
        nextAfterSeq = seq;
        if (opts.actorId !== undefined && ev.actorId !== opts.actorId) continue;
        if (opts.threadId !== undefined && ev.threadId !== opts.threadId) continue;
        if (opts.type !== undefined && ev.type !== opts.type) continue;
        events.push(ev);
      }
      return { events, nextAfterSeq };
    }
    const source = this.retainDurableInMemory ? this.durableEvents : this.events.toArray();
    const events = source.filter((ev) => {
      const seq = eventSeq(ev.id);
      if (seq === null || seq <= afterSeq) return false;
      if (opts.actorId !== undefined && ev.actorId !== opts.actorId) return false;
      if (opts.threadId !== undefined && ev.threadId !== opts.threadId) return false;
      if (opts.type !== undefined && ev.type !== opts.type) return false;
      return true;
    }).slice(0, limit);
    const last = events.length > 0 ? eventSeq(events[events.length - 1].id) : null;
    return { events, nextAfterSeq: last };
  }

  explainEvent(eventId: string): TraceExplanation | undefined {
    if (this.appendTraceName !== undefined) this.syncAppendTrace();
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
    if (this.appendTraceName !== undefined) {
      this.syncAppendTrace();
      const index = this.requireAppendState().index;
      index.view.threadId = index.threadId;
      index.view.partialFinalLine = this.requireAppendState().partialFinalLine || undefined;
      return index.view;
    }
    if (this.replayCache === undefined) {
      this.replayCache = buildReplay(this.retainDurableInMemory ? this.durableEvents : this.events.toArray());
    }
    return this.replayCache;
  }

  private requireAppendState(): AppendState {
    if (this.appendState === undefined) throw new Error("tracer is not append-backed");
    return this.appendState;
  }

  private static readDelta(name: string, offset: number, maxBytes: number): TraceDelta {
    const readDelta = ops.op_read_trace_delta;
    if (readDelta === undefined) {
      throw new Error("append-backed tracing requires native op_read_trace_delta support");
    }
    return parseTraceDelta(readDelta(name, offset, maxBytes));
  }

  private syncAppendTrace(): void {
    const state = this.requireAppendState();
    if (state.fault !== null) throw state.fault;
    try {
      for (;;) {
        const delta = LiminaTracer.readDelta(state.name, state.offset, 256 * 1024);
        this.work.deltaReads++;
        if (state.identity === null) {
          state.identity = delta.identity;
        } else if (delta.identity !== state.identity) {
          throw new TraceIntegrityError(
            "trace_replaced",
            state.nextLineNumber,
            "durable trace was atomically replaced while this tracer was live; reopen is required",
          );
        }
        if (delta.length < state.offset) {
          throw new TraceIntegrityError(
            "trace_truncated",
            state.nextLineNumber,
            `durable trace shrank from verified offset ${state.offset} to ${delta.length}`,
          );
        }
        if (delta.start !== state.offset) {
          throw new Error(`native trace delta started at ${delta.start}, expected ${state.offset}`);
        }
        if (state.cursorHash !== null && delta.cursorHash !== state.cursorHash) {
          throw new TraceIntegrityError(
            "verified_prefix_modified",
            Math.max(1, state.nextLineNumber - 1),
            "the verified durable trace tail was modified in place",
          );
        }
        if (
          delta.end === state.offset && delta.length === state.offset &&
          state.modifiedNs !== null && delta.modifiedNs !== state.modifiedNs
        ) {
          throw new TraceIntegrityError(
            "verified_prefix_modified",
            Math.max(1, state.nextLineNumber - 1),
            "the durable trace changed without appending bytes",
          );
        }
        if (delta.end < delta.start || delta.end > delta.length) {
          throw new Error("native trace delta returned invalid byte bounds");
        }
        const bytesRead = delta.end - delta.start;
        this.work.deltaBytesRead += bytesRead;
        state.offset = delta.end;
        state.modifiedNs = delta.modifiedNs;
        state.cursorHash = delta.endCursorHash;
        if (delta.content.length > 0) this.verifyAppendSuffix(delta.content);
        if (state.offset >= delta.length) break;
        if (bytesRead === 0) throw new Error("native trace delta made no progress");
      }
    } catch (err) {
      if (err instanceof TraceIntegrityError) state.fault = err;
      throw err;
    }
  }

  private verifyAppendSuffix(content: string): void {
    const state = this.requireAppendState();
    const joined = state.partialFinalLine + content;
    const pieces = joined.split("\n");
    state.partialFinalLine = pieces.pop() ?? "";
    for (const line of pieces) this.verifyAppendLine(line);
  }

  private verifyAppendLine(line: string): void {
    const state = this.requireAppendState();
    const lineNumber = state.nextLineNumber;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TraceIntegrityError("invalid_json", lineNumber, `invalid trace JSON at line ${lineNumber}: ${message}`);
    }
    const event = parsed as EngineEvent;
    if (event.integrity === undefined || typeof event.integrity.hash !== "string") {
      throw new TraceIntegrityError("missing_integrity", lineNumber, `trace line ${lineNumber} is missing integrity`);
    }
    if (event.integrity.previousHash !== state.previousHash) {
      throw new TraceIntegrityError("previous_hash_mismatch", lineNumber, `trace line ${lineNumber} previousHash mismatch`);
    }
    const expected = hashEvent(event, state.previousHash);
    if (event.integrity.hash !== expected) {
      throw new TraceIntegrityError("hash_mismatch", lineNumber, `trace line ${lineNumber} hash mismatch`);
    }
    const durableEvent = freezeJsonValue(event);
    this.addAppendEvent(durableEvent);
    state.previousHash = event.integrity.hash;
    this.lastIntegrityHash = event.integrity.hash;
    state.nextLineNumber++;
    this.work.linesVerified++;
  }

  private addAppendEvent(event: EngineEvent): void {
    const index = this.requireAppendState().index;
    index.events.push(event);
    index.byId.set(event.id, event);
    if (!index.threadIdSet.has(event.threadId)) {
      index.threadIdSet.add(event.threadId);
      index.threadIds.push(event.threadId);
      index.threadId = index.threadIds.length === 1 ? event.threadId : null;
    }
    index.view.threadId = index.threadId;

    const rawParentIds = event.parentEventId === null
      ? event.causedBy
      : [event.parentEventId, ...event.causedBy];
    const parentIds = [...new Set(rawParentIds)];
    index.parentIdsById.set(event.id, parentIds);
    this.refreshParents(event);
    for (const parentId of parentIds) {
      if (index.byId.has(parentId)) continue;
      const waiting = index.waitingChildrenByParentId.get(parentId) ?? [];
      waiting.push(event);
      index.waitingChildrenByParentId.set(parentId, waiting);
    }
    const waitingChildren = index.waitingChildrenByParentId.get(event.id) ?? [];
    for (const child of waitingChildren) {
      this.refreshParents(child);
    }
    index.waitingChildrenByParentId.delete(event.id);

    const seq = eventSeq(event.id);
    const priorSeq = index.seqs.length > 0 ? index.seqs[index.seqs.length - 1] : null;
    if (seq === null || (priorSeq !== null && seq <= priorSeq)) index.seqsStrictlyIncreasing = false;
    index.seqs.push(seq);
    if (seq !== null && seq >= this.seq) this.seq = seq + 1;
    this.events.push(withoutIntegrity(event));
  }

  private refreshParents(event: EngineEvent): void {
    const index = this.requireAppendState().index;
    const parentIds = index.parentIdsById.get(event.id) ?? [];
    const parents = parentIds
      .map((parentId) => index.byId.get(parentId))
      .filter((parent): parent is EngineEvent => parent !== undefined);
    index.parentsById.set(event.id, parents);
    const linked = index.linkedParentIdsByChildId.get(event.id) ?? new Set<string>();
    index.linkedParentIdsByChildId.set(event.id, linked);
    for (const parent of parents) {
      if (linked.has(parent.id)) continue;
      const children = index.childrenById.get(parent.id) ?? [];
      children.push(event);
      linked.add(parent.id);
      if (!index.childrenById.has(parent.id)) index.childrenById.set(parent.id, children);
    }
    if (parents.length === parentIds.length) {
      index.parentIdsById.delete(event.id);
      index.linkedParentIdsByChildId.delete(event.id);
    }
  }

  inspect(): InspectorSnapshot {
    if (this.appendTraceName !== undefined) this.syncAppendTrace();
    const hot = this.events.toArray();
    const actors = [...new Set(hot.map((e) => e.actorId))];
    return {
      threadId: this.threadId,
      eventCount: this.events.length,
      actors,
      recent: hot.slice(-20),
    };
  }

  workMetrics(): Readonly<TraceWorkMetrics> {
    return Object.freeze({ ...this.work });
  }

  static replayTrace(name: string, opts: TraceReplayOptions = {}): TraceReplayResult {
    return LiminaTracer.replayJsonl(ops.op_read_trace(name), opts);
  }

  static fromTrace(name: string, maxInMemory = 8192, opts: TraceReplayOptions = {}): LiminaTracer {
    return LiminaTracer.fromJsonl(ops.op_read_trace(name), maxInMemory, opts);
  }

  static appendOnEmit(threadId: string, name: string, maxInMemory = 8192, opts: AppendOnEmitTraceOptions = {}): LiminaTracer {
    const recoverPartialFinalLine = opts.recoverPartialFinalLine ?? true;
    try {
      LiminaTracer.readDelta(name, 0, 0);
    } catch {
      ops.op_write_trace(name, "");
    }
    let tracer = new LiminaTracer(threadId, maxInMemory, false).enableAppend(name);
    try {
      tracer.syncAppendTrace();
    } catch (err) {
      if (!recoverPartialFinalLine || !(err instanceof TraceIntegrityError) || !isRecoverableBootCorruption(err.reason)) throw err;
      const verified = tracer.requireAppendState().index.events.map(withoutIntegrity);
      ops.op_write_trace(name, serializeEvents(verified));
      tracer = new LiminaTracer(threadId, maxInMemory, false).enableAppend(name);
      tracer.syncAppendTrace();
    }
    const state = tracer.requireAppendState();
    if (state.partialFinalLine.length > 0) {
      if (recoverPartialFinalLine) {
        ops.op_write_trace(name, serializeEvents(state.index.events.map(withoutIntegrity)));
        tracer = new LiminaTracer(threadId, maxInMemory, false).enableAppend(name);
        tracer.syncAppendTrace();
      } else if ((opts.onPartialFinalLine ?? "error") === "error") {
        throw new TraceIntegrityError(
          "partial_final_line",
          state.nextLineNumber,
          "trace has an incomplete final JSONL line",
        );
      }
    }
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
    tracer.seq = maxSeq + 1;
    tracer.lastIntegrityHash = keepDurable ? lastIntegrityHash(tracer.durableEvents) : integrityTail([...replay.events]);
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

function upperBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isRecoverableBootCorruption(reason: TraceIntegrityReason): boolean {
  return reason === "invalid_json" || reason === "missing_integrity" ||
    reason === "previous_hash_mismatch" || reason === "hash_mismatch";
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
  const threadIds: string[] = [];
  const threadIdSet = new Set<string>();
  for (const ev of events) {
    byId.set(ev.id, ev);
    if (!threadIdSet.has(ev.threadId)) {
      threadIdSet.add(ev.threadId);
      threadIds.push(ev.threadId);
    }
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
  return {
    threadId: threadIds.length === 1 ? threadIds[0] : null,
    threadIds,
    events,
    byId,
    parentsById,
    childrenById,
  };
}
