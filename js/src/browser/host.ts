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
  getAll(): IdbRequest<unknown[]>;
  getAllKeys(): IdbRequest<string[]>;
}
interface IdbTransaction { objectStore(name: string): IdbObjectStore; }
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
    op_input_axes: (out: Float32Array): void => { input?.readAxes(out); },
  };
}

// ---- TraceOps: durable world-log over IndexedDB ----------------------------

/** Async key->string store the durable trace persists through. Abstracted so the
 *  synchronous-mirror logic is unit-testable against a fake (no IndexedDB). */
export interface AsyncKvStore {
  /** Load every (key, value) pair (used by `hydrate()` before playback). */
  loadAll(): Promise<Array<[string, string]>>;
  /** Persist one key's full value (write-behind from the synchronous mirror). */
  put(key: string, value: string): Promise<void>;
}

/** Durable TraceOps with a synchronous in-memory mirror + write-behind to an
 *  AsyncKvStore. The native op surface is synchronous; IndexedDB is async — so
 *  reads/writes hit the mirror immediately and persistence is queued. Call
 *  `hydrate()` once after construction to load any prior traces. `whenIdle()`
 *  awaits all in-flight writes (for shutdown / tests). INVARIANT (engine.ts
 *  TraceOps): a trace is seed + command stream + hashes — never runtime bytes. */
export class DurableTraceStore implements TraceOps {
  private readonly mem = new Map<string, string>();
  private readonly inflight = new Set<Promise<void>>();
  private persistFailures = 0;
  private lastPersistError: unknown = undefined;
  constructor(private readonly kv: AsyncKvStore) {}

  /** Write-behind persistence health (observability). The in-memory mirror is
   *  always authoritative, so a nonzero `failures` means the durable IndexedDB
   *  copy has silently fallen behind (durability loss) — surfaced here for
   *  diagnostics rather than swallowed. `lastError` is the most recent failure. */
  get persistStatus(): { readonly failures: number; readonly lastError: unknown } {
    return { failures: this.persistFailures, lastError: this.lastPersistError };
  }

  /** Load prior traces from the backing store into the mirror. */
  async hydrate(): Promise<void> {
    for (const [k, v] of await this.kv.loadAll()) this.mem.set(k, v);
  }

  op_write_trace(name: string, content: string): void {
    this.mem.set(name, content);
    this.persist(name, content);
  }
  op_append_trace(name: string, content: string): void {
    const next = (this.mem.get(name) ?? "") + content;
    this.mem.set(name, next);
    this.persist(name, next);
  }
  op_read_trace(name: string): string {
    return this.mem.get(name) ?? "";
  }

  /** Resolve once every queued write has flushed (shutdown / test barrier). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private persist(name: string, value: string): void {
    const p = this.kv.put(name, value).catch((err: unknown) => {
      // Write-behind: a failed persist must NOT crash playback — the in-memory
      // mirror stays authoritative. But a silent swallow hides durability loss, so
      // record the failure (count + last error) for diagnostics via `persistStatus`.
      this.persistFailures++;
      this.lastPersistError = err;
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
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
      const req = db.transaction(this.storeName, "readwrite").objectStore(this.storeName).put(value, key);
      req.onsuccess = (): void => resolve();
      req.onerror = (): void => reject(req.error ?? new Error("IndexedDB put failed"));
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
