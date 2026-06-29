// SharedArrayBuffer input ring buffer (Phase 8 Mode B — M3).
//
// The lock-free, single-producer / single-consumer bridge for INPUT, the mirror
// of sab-transforms.ts (which bridges TRANSFORMS the other direction):
//   • the render-MAIN thread is the PRODUCER — each animation frame it writes the
//     latest input frame (move/look/buttons + a tick stamp) with `writeInput`.
//   • the SIM-WORKER is the CONSUMER — at every fixed-step tick boundary it reads
//     the most-recently-published frame with `readLatest`.
// Both threads hold an `InputRingBuffer` over the SAME SharedArrayBuffer: the
// worker handshake posts `.buffer`, and the other side JOINs by constructing a
// second `InputRingBuffer({ buffer })`. Writes become visible with no
// structured-clone copy — the views alias the same backing memory.
//
// LOCK-FREE PROTOCOL (SPSC). A monotonically-increasing publish sequence number
// lives in an Int32 control slot, mutated only with `Atomics.store`/`load` so the
// publish of the sequence is a RELEASE that orders after the plain Float32 writes
// of the frame body, and the consumer's `Atomics.load` is the matching ACQUIRE
// that orders before its plain reads (the JS SC-DRF memory model). The producer
// writes frame N into ring slot `(N-1) % RING_FRAMES` THEN stores N as the
// sequence; the consumer loads the sequence and reads slot `(seq-1) % RING_FRAMES`.
// With RING_FRAMES >= 4 and at most one in-flight frame per tick, the producer can
// never lap the slot the consumer is mid-read on, so no tearing — and no lock.
//
// ONE-FRAME LATENCY BY DESIGN: the consumer reads, at a tick boundary, whatever
// the producer published BEFORE that boundary; a write that races the boundary is
// simply seen on the next tick. This is the intended input pipeline latency, not
// a bug — it keeps the sim authoritative and the read wait-free.
//
// PORTABILITY (Seam 4): this module names NO `Deno` global; SAB + Atomics are web
// primitives. When `SharedArrayBuffer`/`Atomics` are unavailable (a host without
// them) it transparently falls back to a plain `ArrayBuffer` with plain index
// access — identical layout + logic, only the cross-thread sharing guarantee is
// lost (a plain buffer is copied, not shared, when posted).

const BYTES_PER_I32 = Int32Array.BYTES_PER_ELEMENT; // 4
const BYTES_PER_F32 = Float32Array.BYTES_PER_ELEMENT; // 4

/** Ring capacity in frames. >= 4 so the producer can never lap the consumer's
 *  in-flight slot at one-frame-per-tick cadence. */
export const RING_FRAMES = 4;

/** Floats per published frame: move[3] + look[2] + buttons[2] + tick = 8. */
export const FRAME_FLOATS = 8;

// Control region (Int32, Atomics-addressed). Slot 0 is the publish sequence; the
// rest are reserved (cache-line-ish padding / future flags) and kept zero.
const CONTROL_INTS = 4;
const SEQ_INDEX = 0;

const CONTROL_BYTES = CONTROL_INTS * BYTES_PER_I32;
const DATA_FLOATS = RING_FRAMES * FRAME_FLOATS;
const DATA_BYTES = DATA_FLOATS * BYTES_PER_F32;

/** Total backing-buffer size for the input ring (control + frame data). */
export const INPUT_RING_BYTES = CONTROL_BYTES + DATA_BYTES;

/** True when this host exposes BOTH `SharedArrayBuffer` and `Atomics` (the
 *  cross-thread, lock-free guarantee). False -> plain-buffer fallback. */
export function inputRingSharedAvailable(): boolean {
  return typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined";
}

/** One published input frame. `move` is a 3-axis movement vector (e.g.
 *  [strafe, vertical, forward]) in [-1,1]; `look` is a 2-axis look delta/heading;
 *  `buttons` are 0/1 action states (e.g. [jump, run]); `tick` is the producer's
 *  stamp at publish time (for staleness/latency observability). */
export interface InputFrame {
  move: [number, number, number];
  look: [number, number];
  buttons: [number, number];
  tick: number;
}

/**
 * Lock-free SPSC input ring over a SharedArrayBuffer. Expose `.buffer` to hand
 * across the worker handshake; the receiver JOINs with
 * `new InputRingBuffer({ buffer })`. The producer calls `writeInput`; the
 * consumer calls `readLatest`.
 */
export class InputRingBuffer {
  /** The backing buffer — a `SharedArrayBuffer` when available, else a plain
   *  `ArrayBuffer`. Post THIS across the handshake; the receiver JOINs by passing
   *  it to `new InputRingBuffer({ buffer })`. */
  readonly buffer: SharedArrayBuffer | ArrayBuffer;

  /** True if `.buffer` is a real `SharedArrayBuffer` with `Atomics` (cross-thread,
   *  lock-free); false for the single-thread plain-buffer fallback. */
  readonly shared: boolean;

  /** Int32 control view (slot 0 = publish sequence; Atomics-addressed when shared). */
  private readonly control: Int32Array;
  /** Float32 frame-data view: RING_FRAMES slots of FRAME_FLOATS each. */
  private readonly data: Float32Array;

  constructor(opts: { buffer?: SharedArrayBuffer | ArrayBuffer } = {}) {
    if (opts.buffer !== undefined) {
      // JOIN path: validate the donor buffer matches the expected layout.
      const buf = opts.buffer;
      if (buf.byteLength !== INPUT_RING_BYTES) {
        throw new RangeError(
          `InputRingBuffer: buffer size ${buf.byteLength} bytes does not match the ` +
            `expected ring layout (${INPUT_RING_BYTES} bytes = ${CONTROL_INTS} control ` +
            `int32 + ${RING_FRAMES} frames x ${FRAME_FLOATS} float32).`,
        );
      }
      this.buffer = buf;
      this.shared = inputRingSharedAvailable() && buf instanceof SharedArrayBuffer;
    } else {
      // ALLOCATE path.
      if (inputRingSharedAvailable()) {
        this.buffer = new SharedArrayBuffer(INPUT_RING_BYTES);
        this.shared = true;
      } else {
        this.buffer = new ArrayBuffer(INPUT_RING_BYTES);
        this.shared = false;
      }
    }
    this.control = new Int32Array(this.buffer, 0, CONTROL_INTS);
    this.data = new Float32Array(this.buffer, CONTROL_BYTES, DATA_FLOATS);
  }

  /** Atomically load the current publish sequence (0 == nothing published yet). */
  private loadSeq(): number {
    return this.shared ? Atomics.load(this.control, SEQ_INDEX) : this.control[SEQ_INDEX];
  }

  /** Atomically publish a new sequence (RELEASE: orders after the frame writes). */
  private storeSeq(seq: number): void {
    if (this.shared) Atomics.store(this.control, SEQ_INDEX, seq);
    else this.control[SEQ_INDEX] = seq;
  }

  /** PRODUCER: publish the latest input frame. Single-producer — reads the current
   *  sequence, writes frame N+1 into its ring slot, then publishes N+1 as the
   *  sequence (so a consumer only ever observes a fully-written slot). Returns the
   *  published sequence number. */
  writeInput(frame: InputFrame): number {
    const next = this.loadSeq() + 1;
    const base = ((next - 1) % RING_FRAMES) * FRAME_FLOATS;
    const d = this.data;
    d[base + 0] = frame.move[0];
    d[base + 1] = frame.move[1];
    d[base + 2] = frame.move[2];
    d[base + 3] = frame.look[0];
    d[base + 4] = frame.look[1];
    d[base + 5] = frame.buttons[0];
    d[base + 6] = frame.buttons[1];
    d[base + 7] = frame.tick;
    // Publish AFTER the body is fully written (release).
    this.storeSeq(next);
    return next;
  }

  /** CONSUMER: read the most-recently-published frame, or `null` if none has been
   *  published yet. Wait-free (one Atomics.load + a fixed-size copy). The frame is
   *  read from slot `(seq-1) % RING_FRAMES`; with one frame per tick the producer
   *  cannot be mid-overwriting it. Pass `out` to read allocation-free. */
  readLatest(out?: InputFrame): InputFrame | null {
    const seq = this.loadSeq();
    if (seq <= 0) return null;
    const base = ((seq - 1) % RING_FRAMES) * FRAME_FLOATS;
    const d = this.data;
    if (out !== undefined) {
      out.move[0] = d[base + 0];
      out.move[1] = d[base + 1];
      out.move[2] = d[base + 2];
      out.look[0] = d[base + 3];
      out.look[1] = d[base + 4];
      out.buttons[0] = d[base + 5];
      out.buttons[1] = d[base + 6];
      out.tick = d[base + 7];
      return out;
    }
    return {
      move: [d[base + 0], d[base + 1], d[base + 2]],
      look: [d[base + 3], d[base + 4]],
      buttons: [d[base + 5], d[base + 6]],
      tick: d[base + 7],
    };
  }

  /** The latest published sequence number (observability / tests). 0 == none. */
  get sequence(): number {
    return this.loadSeq();
  }
}
