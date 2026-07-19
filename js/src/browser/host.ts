// Phase 8 BROWSER HOST — the browser-specific capability surfaces the export
// player binds to, plus the requestAnimationFrame driver that mirrors the native
// windowed frame loop (crates/limina-runtime/src/windowed.rs:146-177).
//
// This module is intentionally THREE-free and side-effect-free at import: it
// touches NO browser global at module top-level (so it imports cleanly under the
// native host / a headless test, and the Phase-6 portability guard stays green).
// Every browser global (indexedDB, requestAnimationFrame, window events, the
// canvas WebGPU context) is reached only inside a method that the browser entry
// calls at runtime.
//
// Three surfaces (the engine's RenderOps / TraceOps Pick<EngineOps> seams):
//   - RenderOps  — canvas WebGPU context + surface resize/present + input axes.
//   - TraceOps   — durable world-log I/O over IndexedDB. IndexedDB is async but
//                  the op surface is synchronous (matching native): a synchronous
//                  in-memory mirror serves reads/writes and a write-behind queue
//                  persists to IndexedDB. `hydrate()` loads prior traces before
//                  playback. The mirror logic is testable against any AsyncKv.
//   - the rAF accumulator loop driver (fixed-dt step + interpolated frame).

import type { RenderOps, TraceOps } from "../engine.ts";
import { sha256 } from "../world/sha256.mjs";

// ---- minimal ambient browser surface (erased at build; no DOM lib needed) ---
// Declared locally so this module compiles without `"lib": ["dom"]` and never
// implies a browser global exists until a method actually reads one.

interface GpuCanvasContext { /* opaque GPUCanvasContext */ }
interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "webgpu"): GpuCanvasContext | null;
}
interface KeyEventLike { key: string; preventDefault(): void; }
interface EventTargetLike {
  addEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
  removeEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
}

interface IdbRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
}
interface IdbObjectStore {
  put(value: unknown, key: string): IdbRequest<unknown>;
  get(key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
  getAll(): IdbRequest<unknown[]>;
  getAllKeys(): IdbRequest<string[]>;
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  abort(): void;
  error: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}
interface IdbDatabase {
  transaction(store: string, mode: "readonly" | "readwrite"): IdbTransaction;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
}
interface IdbFactory { open(name: string, version?: number): IdbOpenRequest; }

// ---- RenderOps: canvas WebGPU context + surface + input --------------------

/** Keyboard-driven input axes for the camera (WASD + QE), matching the native
 *  `op_input_axes` contract: out[0]=yaw (A/D), out[1]=height (Q/E), out[2]=zoom
 *  (W/S). Listeners are attached only when `attach()` is called — never at
 *  import. */
export class BrowserInput {
  private readonly pressed = new Set<string>();
  private readonly onDown = (ev: KeyEventLike): void => {
    const k = ev.key.toLowerCase();
    if ("wasdqe".includes(k)) { this.pressed.add(k); ev.preventDefault(); }
  };
  private readonly onUp = (ev: KeyEventLike): void => { this.pressed.delete(ev.key.toLowerCase()); };

  attach(target: EventTargetLike): void {
    target.addEventListener("keydown", this.onDown);
    target.addEventListener("keyup", this.onUp);
  }
  detach(target: EventTargetLike): void {
    target.removeEventListener("keydown", this.onDown);
    target.removeEventListener("keyup", this.onUp);
  }
  /** Write the current axes into `out` (Float32Array length >= 3). */
  readAxes(out: Float32Array): void {
    const p = this.pressed;
    out[0] = (p.has("d") ? 1 : 0) - (p.has("a") ? 1 : 0);
    out[1] = (p.has("e") ? 1 : 0) - (p.has("q") ? 1 : 0);
    out[2] = (p.has("w") ? 1 : 0) - (p.has("s") ? 1 : 0);
  }
}

/** Build the browser `RenderOps` bound to a real canvas. `op_create_window_context`
 *  returns the canvas WebGPU context; `op_surface_resize` reconfigures the canvas
 *  backing-store size; `op_surface_present` is a no-op (the browser compositor
 *  auto-presents the canvas); the loop-callback setters store callbacks (the
 *  browser entry drives them via the rAF loop, so they are not auto-invoked
 *  here); `op_input_axes` reads the keyboard. */
export function createBrowserRenderOps(canvas: CanvasLike, input?: BrowserInput): RenderOps {
  return {
    op_create_window_context: (): unknown => {
      const ctx = canvas.getContext("webgpu");
      if (ctx === null) throw new Error("host: canvas.getContext('webgpu') returned null (no WebGPU)");
      return ctx;
    },
    op_surface_present: (): void => { /* canvas auto-presents */ },
    op_surface_resize: (w: number, h: number): void => {
      if (w >= 1) canvas.width = w;
      if (h >= 1) canvas.height = h;
    },
    op_set_frame_callback: (): void => { /* the rAF driver owns the frame fn */ },
    op_set_fixed_step_callback: (): void => { /* the rAF driver owns the step fn */ },
    op_set_resize_callback: (): void => { /* the browser entry wires resize */ },
    op_input_axes: (out: Float32Array): void => { out.fill(0); input?.readAxes(out); },
    op_input_look: (out: Float32Array): void => { out.fill(0); },
    op_input_buttons: (out: Float32Array): void => { out.fill(0); },
  };
}

// ---- TraceOps: durable world-log over IndexedDB ----------------------------

/** Async key->string store the durable trace persists through. Abstracted so the
 *  synchronous-mirror logic is unit-testable against a fake (no IndexedDB). */
export interface AsyncKvStore {
  /** Load every (key, value) pair (used by `hydrate()` before playback). */
  loadAll(): Promise<Array<[string, string]>>;
  /** Original public contract: replace one value. DurableTraceStore retains a
   * monolithic compatibility path for third-party stores exposing only this API. */
  put(key: string, value: string): Promise<void>;
  /** Optional atomic extension used by IndexedDB's segmented trace path. `null`
   * means the expected key must be absent. False reports a competing writer. */
  commit?(
    expectedKey: string,
    expectedValue: string | null,
    writes: readonly (readonly [string, string])[],
  ): Promise<boolean>;
  /** Optional bounded garbage-collection extension. */
  remove?(keys: readonly string[]): Promise<void>;
}

const TRACE_SEGMENT_PREFIX = "\u0000limina:browser-trace:v2:";
const TRACE_INTERNAL_PREFIX = "\u0000limina:browser-trace:";
const TRACE_META_SCHEMA = "limina.browser-trace-meta/v2";
const TRACE_SEGMENT_SCHEMA = "limina.browser-trace-segment/v2";
const MAX_TRACE_NAME_CODE_UNITS = 512;
const MAX_ENCODED_TRACE_NAME_CODE_UNITS = 3_072;
const MAX_TRACE_CODE_UNITS = 512 * 1024 * 1024;
const MAX_SEGMENT_CODE_UNITS = 16 * 1024 * 1024;
const MAX_SEGMENTS = 1_000_000;
const MAX_GENERATION = 99_999_999;
const GENERATION_KEY_WIDTH = 8;
const SEQUENCE_KEY_WIDTH = 7;
const MAX_METADATA_CODE_UNITS = 4_096;
const MAX_SEGMENT_RECORD_CODE_UNITS = MAX_SEGMENT_CODE_UNITS * 6 + 4_096;
const CLEANUP_BATCH_SIZE = 256;
const EMPTY_HASH = sha256("");

interface TraceMetadata {
  readonly schema: typeof TRACE_META_SCHEMA;
  readonly name: string;
  readonly generation: number;
  readonly base: "none" | "legacy";
  readonly baseLength: number;
  readonly baseHash: string;
  readonly segmentCount: number;
  readonly totalLength: number;
  readonly headHash: string;
}

interface TraceSegment {
  readonly schema: typeof TRACE_SEGMENT_SCHEMA;
  readonly name: string;
  readonly generation: number;
  readonly sequence: number;
  readonly contentLength: number;
  readonly contentHash: string;
  readonly previousHash: string;
  readonly hash: string;
  readonly content: string;
}

interface TracePersistenceState {
  metadata: TraceMetadata | null;
  metadataRaw: string | null;
  legacy: { readonly length: number; readonly hash: string } | null;
}

function traceName(name: string): string {
  if (name.length > MAX_TRACE_NAME_CODE_UNITS) throw new Error(`browser trace name exceeds ${MAX_TRACE_NAME_CODE_UNITS} code units`);
  if (name.includes("\u0000")) throw new Error("browser trace name must not contain NUL");
  return name;
}

function encodedTraceName(name: string): string {
  const encoded = encodeURIComponent(traceName(name));
  if (encoded.length > MAX_ENCODED_TRACE_NAME_CODE_UNITS) {
    throw new Error(`browser trace encoded name exceeds ${MAX_ENCODED_TRACE_NAME_CODE_UNITS} code units`);
  }
  return encoded;
}

function traceMetaKey(name: string): string {
  return `${TRACE_SEGMENT_PREFIX}meta:${encodedTraceName(name)}`;
}

function traceSegmentKey(name: string, generation: number, sequence: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new Error(`browser trace ${name} generation is outside 1..${MAX_GENERATION}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= MAX_SEGMENTS) {
    throw new Error(`browser trace ${name} sequence is outside 0..${MAX_SEGMENTS - 1}`);
  }
  return `${TRACE_SEGMENT_PREFIX}segment:${encodedTraceName(name)}:${generation.toString(10).padStart(GENERATION_KEY_WIDTH, "0")}:${sequence.toString(10).padStart(SEQUENCE_KEY_WIDTH, "0")}`;
}

function internalTraceKey(key: string): boolean {
  return key.startsWith(TRACE_INTERNAL_PREFIX);
}

function safeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`browser trace metadata ${label} is invalid`);
  return value as number;
}

function checkedLength(value: unknown, label: string, maximum: number): number {
  const count = safeCount(value, label);
  if (count > maximum) throw new Error(`browser trace metadata ${label} exceeds ${maximum}`);
  return count;
}

function checkedTotal(left: number, right: number, name: string): number {
  if (right > MAX_SEGMENT_CODE_UNITS) throw new Error(`browser trace ${name} append exceeds ${MAX_SEGMENT_CODE_UNITS} code units`);
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > MAX_TRACE_CODE_UNITS) {
    throw new Error(`browser trace ${name} total length exceeds ${MAX_TRACE_CODE_UNITS} code units`);
  }
  return total;
}

function checkedTraceLength(length: number, name: string): number {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TRACE_CODE_UNITS) {
    throw new Error(`browser trace ${name} total length exceeds ${MAX_TRACE_CODE_UNITS} code units`);
  }
  return length;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`browser trace ${label} is not a sha256 digest`);
  }
  return value;
}

function parseTraceMetadata(raw: string, key: string): TraceMetadata {
  if (raw.length > MAX_METADATA_CODE_UNITS) throw new Error(`browser trace metadata ${key} exceeds ${MAX_METADATA_CODE_UNITS} code units`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`browser trace metadata ${key} is not valid JSON`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`browser trace metadata ${key} is invalid`);
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().join(",");
  if (fields !== "base,baseHash,baseLength,generation,headHash,name,schema,segmentCount,totalLength") {
    throw new Error(`browser trace metadata ${key} has unknown or missing fields`);
  }
  if (record.schema !== TRACE_META_SCHEMA || typeof record.name !== "string" ||
      (record.base !== "none" && record.base !== "legacy")) {
    throw new Error(`browser trace metadata ${key} has invalid identity fields`);
  }
  const metadata: TraceMetadata = {
    schema: TRACE_META_SCHEMA,
    name: traceName(record.name),
    generation: checkedLength(record.generation, "generation", MAX_GENERATION),
    base: record.base,
    baseLength: checkedLength(record.baseLength, "baseLength", MAX_TRACE_CODE_UNITS),
    baseHash: hashValue(record.baseHash, "metadata baseHash"),
    segmentCount: checkedLength(record.segmentCount, "segmentCount", MAX_SEGMENTS),
    totalLength: checkedLength(record.totalLength, "totalLength", MAX_TRACE_CODE_UNITS),
    headHash: hashValue(record.headHash, "metadata headHash"),
  };
  if (metadata.generation < 1 || traceMetaKey(metadata.name) !== key ||
      (metadata.base === "none" && (metadata.baseLength !== 0 || metadata.baseHash !== EMPTY_HASH)) ||
      metadata.totalLength < metadata.baseLength ||
      (metadata.segmentCount === 0 && metadata.headHash !== metadata.baseHash)) {
    throw new Error(`browser trace metadata ${key} is inconsistent`);
  }
  return metadata;
}

function segmentHash(segment: Omit<TraceSegment, "hash">): string {
  return sha256(JSON.stringify([
    segment.schema, segment.name, segment.generation, segment.sequence,
    segment.contentLength, segment.contentHash, segment.previousHash, segment.content,
  ]));
}

function serializeTraceSegment(
  name: string,
  generation: number,
  sequence: number,
  content: string,
  previousHash: string,
): { readonly raw: string; readonly hash: string } {
  checkedTotal(0, content.length, name);
  const core: Omit<TraceSegment, "hash"> = {
    schema: TRACE_SEGMENT_SCHEMA,
    name,
    generation,
    sequence,
    contentLength: content.length,
    contentHash: sha256(content),
    previousHash,
    content,
  };
  const hash = segmentHash(core);
  return { raw: JSON.stringify({ ...core, hash }), hash };
}

function parseTraceSegment(raw: string, metadata: TraceMetadata, sequence: number, previousHash: string): TraceSegment {
  if (raw.length > MAX_SEGMENT_RECORD_CODE_UNITS) {
    throw new Error(`browser trace ${metadata.name} segment ${sequence} record exceeds its hard cap`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`browser trace ${metadata.name} segment ${sequence} is not valid JSON`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`browser trace ${metadata.name} segment ${sequence} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().join(",");
  if (fields !== "content,contentHash,contentLength,generation,hash,name,previousHash,schema,sequence") {
    throw new Error(`browser trace ${metadata.name} segment ${sequence} has unknown or missing fields`);
  }
  if (record.schema !== TRACE_SEGMENT_SCHEMA || record.name !== metadata.name ||
      record.generation !== metadata.generation || record.sequence !== sequence ||
      typeof record.content !== "string") {
    throw new Error(`browser trace ${metadata.name} segment ${sequence} identity is inconsistent`);
  }
  const segment: TraceSegment = {
    schema: TRACE_SEGMENT_SCHEMA,
    name: metadata.name,
    generation: metadata.generation,
    sequence,
    contentLength: checkedLength(record.contentLength, "segment contentLength", MAX_SEGMENT_CODE_UNITS),
    contentHash: hashValue(record.contentHash, `segment ${sequence} contentHash`),
    previousHash: hashValue(record.previousHash, `segment ${sequence} previousHash`),
    hash: hashValue(record.hash, `segment ${sequence} hash`),
    content: record.content,
  };
  if (segment.contentLength !== segment.content.length || segment.contentHash !== sha256(segment.content) ||
      segment.previousHash !== previousHash || segment.hash !== segmentHash(segment)) {
    throw new Error(`browser trace ${metadata.name} segment ${sequence} content integrity failed`);
  }
  return segment;
}

function serializeTraceMetadata(metadata: TraceMetadata): string {
  return JSON.stringify(metadata);
}

/** Durable TraceOps with a synchronous in-memory mirror + write-behind to an
 *  AsyncKvStore. The native op surface is synchronous; IndexedDB is async — so
 *  reads/writes hit the mirror immediately and persistence is queued. Call
 *  `hydrate()` once after construction to load any prior traces. `whenIdle()`
 *  awaits all in-flight writes (for shutdown / tests). INVARIANT (engine.ts
 *  TraceOps): a trace is seed + command stream + hashes — never runtime bytes. */
export class DurableTraceStore implements TraceOps {
  private readonly mem = new Map<string, string>();
  private readonly persistence = new Map<string, TracePersistenceState>();
  private readonly traceTails = new Map<string, Promise<void>>();
  private readonly poisonedTraces = new Map<string, unknown>();
  private readonly inflight = new Set<Promise<void>>();
  private persistFailures = 0;
  private lastPersistError: unknown = undefined;
  private hydration: Promise<void> | null = null;
  private mutated = false;
  constructor(private readonly kv: AsyncKvStore) {}

  /** Write-behind persistence health (observability). The in-memory mirror is
   *  always authoritative, so a nonzero `failures` means the durable IndexedDB
   *  copy has silently fallen behind (durability loss) — surfaced here for
   *  diagnostics rather than swallowed. `lastError` is the most recent failure. */
  get persistStatus(): {
    readonly failures: number;
    readonly lastError: unknown;
    readonly poisonedTraces: readonly { readonly name: string; readonly cause: unknown }[];
  } {
    return {
      failures: this.persistFailures,
      lastError: this.lastPersistError,
      poisonedTraces: [...this.poisonedTraces].map(([name, cause]) => ({ name, cause })),
    };
  }

  /** Load prior traces from the backing store into the mirror. Concurrent and
   * repeated calls share the same completed hydration rather than re-reading or
   * replacing the synchronous mirror. A rejected load may be retried. */
  async hydrate(): Promise<void> {
    if (this.hydration !== null) return await this.hydration;
    if (this.mutated) throw new Error("DurableTraceStore.hydrate must run before trace mutation");
    const work = this.hydrateOnce();
    this.hydration = work;
    try { await work; } catch (error) { if (this.hydration === work) this.hydration = null; throw error; }
  }

  private async hydrateOnce(): Promise<void> {
    const loaded = await this.kv.loadAll();
    const entries = new Map<string, string>();
    for (const [key, value] of loaded) {
      if (entries.has(key)) throw new Error(`browser trace backing store returned duplicate key ${JSON.stringify(key)}`);
      entries.set(key, value);
    }
    const nextMem = new Map<string, string>();
    const nextPersistence = new Map<string, TracePersistenceState>();
    const claimedLegacy = new Set<string>();
    const activeInternalKeys = new Set<string>();

    // Metadata is the sole publication pointer. Segments without metadata are
    // orphaned crash remnants and are deliberately ignored; metadata that points
    // at a missing/corrupt segment fails hydration rather than truncating replay.
    for (const [key, raw] of entries) {
      if (!key.startsWith(`${TRACE_SEGMENT_PREFIX}meta:`)) continue;
      const metadata = parseTraceMetadata(raw, key);
      activeInternalKeys.add(key);
      const parts: string[] = [];
      let reconstructedLength = 0;
      let previousHash = metadata.baseHash;
      let legacy: TracePersistenceState["legacy"] = null;
      if (metadata.base === "legacy") {
        const content = entries.get(metadata.name);
        if (content === undefined || content.length !== metadata.baseLength || sha256(content) !== metadata.baseHash) {
          throw new Error(`browser trace ${metadata.name} legacy base content integrity failed`);
        }
        claimedLegacy.add(metadata.name);
        parts.push(content);
        reconstructedLength = content.length;
        legacy = { length: content.length, hash: metadata.baseHash };
      }
      for (let sequence = 0; sequence < metadata.segmentCount; sequence++) {
        const segmentRaw = entries.get(traceSegmentKey(metadata.name, metadata.generation, sequence));
        if (segmentRaw === undefined) throw new Error(`browser trace ${metadata.name} segment ${sequence} is missing`);
        activeInternalKeys.add(traceSegmentKey(metadata.name, metadata.generation, sequence));
        const segment = parseTraceSegment(segmentRaw, metadata, sequence, previousHash);
        reconstructedLength = checkedTotal(reconstructedLength, segment.content.length, metadata.name);
        parts.push(segment.content);
        previousHash = segment.hash;
      }
      if (reconstructedLength !== metadata.totalLength || previousHash !== metadata.headHash) {
        throw new Error(`browser trace ${metadata.name} metadata integrity does not match its segment chain`);
      }
      nextMem.set(metadata.name, parts.join(""));
      nextPersistence.set(metadata.name, { metadata, metadataRaw: raw, legacy });
    }

    // A pre-v2 monolithic value remains readable. Its first append publishes
    // metadata that hash-binds this immutable legacy base and writes only the new
    // segment, avoiding a one-time full-value migration rewrite.
    for (const [key, value] of entries) {
      if (internalTraceKey(key) || claimedLegacy.has(key) || nextMem.has(key)) continue;
      const name = traceName(key);
      if (value.length > MAX_TRACE_CODE_UNITS) throw new Error(`browser trace ${name} legacy base exceeds its hard cap`);
      nextMem.set(name, value);
      nextPersistence.set(name, { metadata: null, metadataRaw: null, legacy: { length: value.length, hash: sha256(value) } });
    }

    this.mem.clear();
    this.persistence.clear();
    for (const [key, value] of nextMem) this.mem.set(key, value);
    for (const [key, value] of nextPersistence) this.persistence.set(key, value);

    // Complete cleanup interrupted by a prior crash. Only the metadata pointer
    // and its exact generation are live; every other reserved key is unreachable.
    // Reclaim only THIS schema's unreachable keys. Unknown/older reserved
    // versions stay ignored but preserved; cleanup must never become an
    // implicit destructive migration of a format it cannot authenticate.
    const orphaned = [...entries.keys()].filter((key) => key.startsWith(TRACE_SEGMENT_PREFIX) && !activeInternalKeys.has(key));
    if (orphaned.length > 0 && this.kv.remove !== undefined) {
      try {
        for (let offset = 0; offset < orphaned.length; offset += CLEANUP_BATCH_SIZE) {
          await this.kv.remove(orphaned.slice(offset, offset + CLEANUP_BATCH_SIZE));
        }
      } catch (error) { this.recordFailure(error); }
    }
  }

  op_write_trace(name: string, content: string): void {
    name = traceName(name);
    checkedTraceLength(content.length, name);
    this.mutated = true;
    if (this.kv.commit === undefined) {
      this.mem.set(name, content);
      this.enqueueLegacyPut(name, content);
      return;
    }
    const state = this.state(name);
    const generation = (state.metadata?.generation ?? 0) + 1;
    if (generation > MAX_GENERATION) throw new Error(`browser trace ${name} exhausted its generation space`);
    const previous = state.metadata;
    const segments: Array<{ readonly raw: string; readonly hash: string }> = [];
    let headHash = EMPTY_HASH;
    for (let offset = 0; offset < content.length; offset += MAX_SEGMENT_CODE_UNITS) {
      const segment = serializeTraceSegment(
        name,
        generation,
        segments.length,
        content.slice(offset, offset + MAX_SEGMENT_CODE_UNITS),
        headHash,
      );
      segments.push(segment);
      headHash = segment.hash;
    }
    const metadata: TraceMetadata = {
      schema: TRACE_META_SCHEMA,
      name,
      generation,
      base: "none",
      baseLength: 0,
      baseHash: EMPTY_HASH,
      segmentCount: segments.length,
      totalLength: content.length,
      headHash,
    };
    const metadataRaw = serializeTraceMetadata(metadata);
    const writes: Array<readonly [string, string]> = [];
    for (let sequence = 0; sequence < segments.length; sequence++) {
      writes.push([traceSegmentKey(name, generation, sequence), segments[sequence].raw]);
    }
    writes.push([traceMetaKey(name), metadataRaw]);
    this.mem.set(name, content);
    if (!this.poisonedTraces.has(name)) {
      this.enqueueCommit(name, state.metadataRaw, writes, previous, state.legacy !== null);
      this.persistence.set(name, { metadata, metadataRaw, legacy: null });
    }
  }
  op_append_trace(name: string, content: string): void {
    name = traceName(name);
    this.mutated = true;
    if (content.length === 0) return;
    const previous = this.mem.get(name) ?? "";
    const totalLength = checkedTotal(previous.length, content.length, name);
    const next = previous + content;
    if (this.kv.commit === undefined) {
      this.mem.set(name, next);
      this.enqueueLegacyPut(name, next);
      return;
    }
    const state = this.state(name);
    const previousMetadata = state.metadata;
    const generation = previousMetadata?.generation ?? 1;
    const base = previousMetadata?.base ?? (state.legacy === null ? "none" : "legacy");
    const baseLength = previousMetadata?.baseLength ?? state.legacy?.length ?? 0;
    const baseHash = previousMetadata?.baseHash ?? state.legacy?.hash ?? EMPTY_HASH;
    const sequence = previousMetadata?.segmentCount ?? 0;
    if (sequence >= MAX_SEGMENTS) throw new Error(`browser trace ${name} exhausted its segment space`);
    const previousHash = previousMetadata?.headHash ?? baseHash;
    const segment = serializeTraceSegment(name, generation, sequence, content, previousHash);
    const metadata: TraceMetadata = {
      schema: TRACE_META_SCHEMA,
      name,
      generation,
      base,
      baseLength,
      baseHash,
      segmentCount: sequence + 1,
      totalLength,
      headHash: segment.hash,
    };
    const metadataRaw = serializeTraceMetadata(metadata);
    this.mem.set(name, next);
    if (!this.poisonedTraces.has(name)) {
      this.enqueueCommit(name, state.metadataRaw, [
        [traceSegmentKey(name, generation, sequence), segment.raw],
        [traceMetaKey(name), metadataRaw],
      ]);
      this.persistence.set(name, { metadata, metadataRaw, legacy: base === "legacy" ? { length: baseLength, hash: baseHash } : null });
    }
  }
  op_read_trace(name: string): string {
    return this.mem.get(traceName(name)) ?? "";
  }

  /** Resolve once every queued write has flushed (shutdown / test barrier). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private state(name: string): TracePersistenceState {
    const existing = this.persistence.get(name);
    if (existing !== undefined) return existing;
    const created = { metadata: null, metadataRaw: null, legacy: null };
    this.persistence.set(name, created);
    return created;
  }

  private enqueueCommit(
    name: string,
    expectedMetadata: string | null,
    writes: readonly (readonly [string, string])[],
    staleMetadata?: TraceMetadata | null,
    staleLegacy = false,
  ): void {
    const prior = this.traceTails.get(name) ?? Promise.resolve();
    const p = prior.then(async () => {
      if (this.poisonedTraces.has(name)) return;
      const commit = this.kv.commit;
      if (commit === undefined) throw new Error(`browser trace ${name} atomic persistence extension disappeared`);
      const committed = await commit.call(this.kv, traceMetaKey(name), expectedMetadata, writes);
      if (!committed) throw new Error(`browser trace ${name} concurrent writer changed metadata`);
      try { await this.cleanupStale(name, staleMetadata, staleLegacy); }
      catch (error) { this.recordFailure(error); }
    }).catch((err: unknown) => {
      // A failed segment/metadata transaction leaves the last metadata pointer
      // intact. Poison this trace so later queued appends cannot publish metadata
      // across the missing durable segment and manufacture a corrupt sequence.
      this.poison(name, err);
    });
    this.traceTails.set(name, p);
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
      if (this.traceTails.get(name) === p) this.traceTails.delete(name);
    });
  }

  private enqueueLegacyPut(name: string, value: string): void {
    if (this.poisonedTraces.has(name)) return;
    const prior = this.traceTails.get(name) ?? Promise.resolve();
    const p = prior.then(async () => {
      if (!this.poisonedTraces.has(name)) await this.kv.put(name, value);
    }).catch((error: unknown) => this.poison(name, error));
    this.track(name, p);
  }

  private track(name: string, promise: Promise<void>): void {
    this.traceTails.set(name, promise);
    this.inflight.add(promise);
    void promise.finally(() => {
      this.inflight.delete(promise);
      if (this.traceTails.get(name) === promise) this.traceTails.delete(name);
    });
  }

  private poison(name: string, cause: unknown): void {
    if (this.poisonedTraces.has(name)) return;
    this.poisonedTraces.set(name, cause);
    this.recordFailure(cause);
  }

  private recordFailure(cause: unknown): void {
    this.persistFailures++;
    this.lastPersistError = cause;
  }

  private async cleanupStale(name: string, metadata: TraceMetadata | null | undefined, legacy: boolean): Promise<void> {
    const remove = this.kv.remove;
    if (remove === undefined) return;
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const deleting = batch;
      batch = [];
      await remove.call(this.kv, deleting);
    };
    if (metadata !== undefined && metadata !== null) {
      for (let sequence = 0; sequence < metadata.segmentCount; sequence++) {
        batch.push(traceSegmentKey(name, metadata.generation, sequence));
        if (batch.length === CLEANUP_BATCH_SIZE) await flush();
      }
    }
    if (legacy) batch.push(name);
    await flush();
  }
}

/** AsyncKvStore backed by IndexedDB (one object store of name->content). Reached
 *  only inside async methods, so importing this module touches no browser global. */
export class IndexedDbKvStore implements AsyncKvStore {
  private db: IdbDatabase | undefined;
  constructor(
    private readonly dbName = "limina-trace",
    private readonly storeName = "traces",
    private readonly factory: IdbFactory = (globalThis as unknown as { indexedDB: IdbFactory }).indexedDB,
  ) {}

  private async open(): Promise<IdbDatabase> {
    if (this.db !== undefined) return this.db;
    this.db = await new Promise<IdbDatabase>((resolve, reject) => {
      const req = this.factory.open(this.dbName, 1);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => reject(req.error ?? new Error("IndexedDB open failed"));
    });
    return this.db;
  }

  async loadAll(): Promise<Array<[string, string]>> {
    const db = await this.open();
    return await new Promise<Array<[string, string]>>((resolve, reject) => {
      const store = db.transaction(this.storeName, "readonly").objectStore(this.storeName);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      let keys: string[] | undefined;
      let vals: unknown[] | undefined;
      const tryFinish = (): void => {
        if (keys === undefined || vals === undefined) return;
        const out: Array<[string, string]> = [];
        for (let i = 0; i < keys.length; i++) out.push([keys[i], String(vals[i])]);
        resolve(out);
      };
      keysReq.onsuccess = (): void => { keys = keysReq.result; tryFinish(); };
      valsReq.onsuccess = (): void => { vals = valsReq.result; tryFinish(); };
      keysReq.onerror = (): void => reject(keysReq.error ?? new Error("IndexedDB getAllKeys failed"));
      valsReq.onerror = (): void => reject(valsReq.error ?? new Error("IndexedDB getAll failed"));
    });
  }

  async put(key: string, value: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(value, key);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB put failed"));
      tx.onabort = (): void => reject(tx.error ?? new Error("IndexedDB put aborted"));
    });
  }

  async commit(
    expectedKey: string,
    expectedValue: string | null,
    writes: readonly (readonly [string, string])[],
  ): Promise<boolean> {
    const db = await this.open();
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const expected = store.get(expectedKey);
      let comparisonFailed = false;
      expected.onsuccess = (): void => {
        const actual = expected.result === undefined ? null : String(expected.result);
        if (actual !== expectedValue) {
          comparisonFailed = true;
          tx.abort();
          return;
        }
        for (const [key, value] of writes) store.put(value, key);
      };
      expected.onerror = (): void => reject(expected.error ?? new Error("IndexedDB metadata read failed"));
      tx.oncomplete = (): void => resolve(true);
      tx.onabort = (): void => {
        if (comparisonFailed) resolve(false);
        else reject(tx.error ?? new Error("IndexedDB trace commit aborted"));
      };
      tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB trace commit failed"));
    });
  }


  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length > CLEANUP_BATCH_SIZE) throw new Error(`IndexedDB cleanup batch exceeds ${CLEANUP_BATCH_SIZE} keys`);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      for (const key of keys) store.delete(key);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB cleanup failed"));
      tx.onabort = (): void => reject(tx.error ?? new Error("IndexedDB cleanup aborted"));
    });
  }
}

// ---- rAF accumulator loop (mirrors windowed.rs:146-177) --------------------

/** The native windowed loop's constants (crates/limina-runtime/src/windowed.rs:28-29). */
export const FIXED_DT = 1 / 60;
export const MAX_STEPS_PER_FRAME = 5;

export interface AccumulatorLoopOptions {
  /** Advance logic one fixed step (the export player's `stepTick`). May be async. */
  step: (dt: number) => void | Promise<void>;
  /** Render once with the leftover interpolation factor `alpha` in [0,1). */
  frame: (alpha: number) => void;
  /** Schedule the next tick (defaults to requestAnimationFrame). Injectable for tests. */
  raf?: (cb: () => void) => void;
  /** Monotonic clock in ms (defaults to performance.now / Date.now). Injectable for tests. */
  now?: () => number;
  fixedDt?: number;
  maxStepsPerFrame?: number;
  /** Clamp on a single frame's dt (native uses 0.25s) to avoid a spiral of death. */
  maxFrameDt?: number;
}

export interface AccumulatorLoopHandle {
  stop(): void;
  /** Total fixed steps advanced so far (observability / tests). */
  readonly steps: number;
  /** Total frames rendered so far. */
  readonly frames: number;
}

/** Drive a fixed-timestep accumulator loop, identical in shape to the native
 *  windowed loop: each tick consumes wall-clock dt, runs up to MAX_STEPS_PER_FRAME
 *  fixed `step(FIXED_DT)` calls while the accumulator allows, then renders one
 *  `frame(alpha)`. `step` may be async (the export player awaits its keyframe
 *  replay); a tick never overlaps the next. Returns a handle to stop it. The
 *  `raf`/`now` injection makes the loop fully testable without a browser. */
export function startAccumulatorLoop(opts: AccumulatorLoopOptions): AccumulatorLoopHandle {
  const fixedDt = opts.fixedDt ?? FIXED_DT;
  const maxSteps = opts.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME;
  const maxFrameDt = opts.maxFrameDt ?? 0.25;
  const raf = opts.raf ?? ((cb: () => void): void => {
    (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame(cb);
  });
  const now = opts.now ?? ((): number => {
    const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
    return perf !== undefined ? perf.now() : Date.now();
  });

  const handle = { steps: 0, frames: 0 } as { steps: number; frames: number; stop(): void };
  let running = true;
  let last = now();
  let accumulator = 0;

  const tick = async (): Promise<void> => {
    if (!running) return;
    const t = now();
    let dt = (t - last) / 1000;
    if (dt > maxFrameDt) dt = maxFrameDt;
    last = t;
    accumulator += dt;
    let sub = 0;
    while (accumulator >= fixedDt && sub < maxSteps) {
      await opts.step(fixedDt);
      accumulator -= fixedDt;
      handle.steps++;
      sub++;
    }
    const alpha = accumulator / fixedDt;
    opts.frame(alpha);
    handle.frames++;
    if (running) raf(() => { void tick(); });
  };

  handle.stop = (): void => { running = false; };
  raf(() => { void tick(); });
  return handle;
}
