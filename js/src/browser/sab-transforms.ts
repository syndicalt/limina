// SharedArrayBuffer-backed ECS transform storage (Phase 8, Mode B — M2).
//
// The zero-copy bridge between the sim-worker (authoritative fixed-step ECS +
// physics — the WRITER) and the render-main thread (the READER). Both threads
// hold a `SharedTransformStorage` over the SAME SharedArrayBuffer: the worker
// allocates one and posts `.buffer` across the handshake; the main thread JOINs
// it by constructing a second `SharedTransformStorage({ buffer })`. Writes on
// the worker side become visible on the render side with no structured-clone
// copy — the Float32Array views alias the same backing memory.
//
// DROP-IN: implements the exact `TransformStorage` interface from
// js/src/ecs/facade.ts (monotonic `version` + writePosition/writeRotation/
// writeScale), so it substitutes for `createTransformStorage()` anywhere the
// engine consumes transforms (renderSyncSystem reads .Position/.Rotation/.Scale;
// the skills + spatial index call the write methods and read `.version`).
//
// PORTABILITY (Seam 4): this module touches NO `Deno` global — it is
// browser-reachable and SAB is a web platform primitive. When `SharedArrayBuffer`
// is unavailable (binary/host without it) it transparently falls back to a plain
// `ArrayBuffer`; the layout/join logic is identical, only the cross-thread
// sharing guarantee is lost (a plain ArrayBuffer is copied, not shared, when
// posted).
//
// ---------------------------------------------------------------------------
// BYTE LAYOUT — one contiguous buffer, channel-major (SoA), so a SINGLE buffer
// transfers the entire transform set. With N = MAX_ENTITIES and 4 bytes/float:
//
//   block      channels  float offset (elems)   byte offset            bytes
//   ---------  --------  ---------------------   --------------------   --------
//   Position.x   1       0*N                     0                      4*N
//   Position.y   1       1*N                     4*N                    4*N
//   Position.z   1       2*N                     8*N                    4*N
//   Rotation.x   1       3*N                     12*N                   4*N
//   Rotation.y   1       4*N                     16*N                   4*N
//   Rotation.z   1       5*N                     20*N                   4*N
//   Rotation.w   1       6*N                     24*N                   4*N
//   Scale.x      1       7*N                     28*N                   4*N
//   Scale.y      1       8*N                     32*N                   4*N
//   Scale.z      1       9*N                     36*N                   4*N
//   ---------------------------------------------------------------------------
//   TOTAL       10                               TRANSFORM_BUFFER_BYTES = 40*N
//
// Each channel is a tightly-packed Float32Array(buffer, byteOffset, N) — no
// interleaving, no padding, contiguous and cache-friendly per-channel, matching
// the heap-backed SoA in world.ts exactly so reads/writes are bit-identical.
// ---------------------------------------------------------------------------

import { MAX_ENTITIES } from "../ecs/world.ts";
import type { TransformStorage } from "../ecs/facade.ts";

const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT; // 4

/** Channel count: Position(3) + Rotation(4) + Scale(3). */
export const TRANSFORM_CHANNELS = 10;

/** Per-channel size in bytes (one Float32 per entity, MAX_ENTITIES entities). */
export const CHANNEL_BYTES = MAX_ENTITIES * BYTES_PER_FLOAT;

/** Total backing-buffer size for the full Position+Rotation+Scale SoA. */
export const TRANSFORM_BUFFER_BYTES = TRANSFORM_CHANNELS * CHANNEL_BYTES;

// Fixed channel byte offsets within the single buffer (see layout table above).
const OFF_POS_X = 0 * CHANNEL_BYTES;
const OFF_POS_Y = 1 * CHANNEL_BYTES;
const OFF_POS_Z = 2 * CHANNEL_BYTES;
const OFF_ROT_X = 3 * CHANNEL_BYTES;
const OFF_ROT_Y = 4 * CHANNEL_BYTES;
const OFF_ROT_Z = 5 * CHANNEL_BYTES;
const OFF_ROT_W = 6 * CHANNEL_BYTES;
const OFF_SCL_X = 7 * CHANNEL_BYTES;
const OFF_SCL_Y = 8 * CHANNEL_BYTES;
const OFF_SCL_Z = 9 * CHANNEL_BYTES;

/** True when this host exposes the `SharedArrayBuffer` constructor. */
export function sharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer === "function";
}

/** SoA view triplet matching the shape of world.ts `Position`/`Scale`. */
export interface Vec3Soa {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}
/** SoA view quad matching the shape of world.ts `Rotation`. */
export interface Vec4Soa extends Vec3Soa {
  w: Float32Array;
}

/**
 * SharedArrayBuffer-backed transform storage. Implements `TransformStorage`
 * (drop-in for `createTransformStorage`) and additionally exposes the backing
 * `.buffer` (to hand across the worker↔main handshake) and the `.Position`,
 * `.Rotation`, `.Scale` SoA views (so a renderSyncSystem-style reader can pull
 * transforms zero-copy, exactly as it reads the globals in world.ts).
 */
export class SharedTransformStorage implements TransformStorage {
  /** The backing buffer — a `SharedArrayBuffer` when available, else a plain
   *  `ArrayBuffer`. Post THIS across the worker handshake; the receiver JOINs by
   *  passing it to `new SharedTransformStorage({ buffer })`. */
  readonly buffer: SharedArrayBuffer | ArrayBuffer;

  /** True if `.buffer` is a real `SharedArrayBuffer` (cross-thread zero-copy);
   *  false if a fallback `ArrayBuffer` (single-thread / no SAB host). */
  readonly shared: boolean;

  /** Position SoA views over the shared buffer (alias world.ts `Position`). */
  readonly Position: Vec3Soa;
  /** Rotation SoA views over the shared buffer (alias world.ts `Rotation`). */
  readonly Rotation: Vec4Soa;
  /** Scale SoA views over the shared buffer (alias world.ts `Scale`). */
  readonly Scale: Vec3Soa;

  private storageVersion = 0;

  constructor(opts: { buffer?: SharedArrayBuffer | ArrayBuffer } = {}) {
    if (opts.buffer !== undefined) {
      // JOIN path: the render-main thread receiving the worker's SAB. Validate
      // the donor buffer matches the expected layout before aliasing it.
      const buf = opts.buffer;
      if (buf.byteLength !== TRANSFORM_BUFFER_BYTES) {
        throw new RangeError(
          `SharedTransformStorage: buffer size ${buf.byteLength} bytes does not ` +
            `match the expected transform layout (${TRANSFORM_BUFFER_BYTES} bytes ` +
            `= ${TRANSFORM_CHANNELS} channels x ${MAX_ENTITIES} entities x ` +
            `${BYTES_PER_FLOAT} bytes).`,
        );
      }
      this.buffer = buf;
      this.shared = typeof SharedArrayBuffer === "function" &&
        buf instanceof SharedArrayBuffer;
    } else {
      // ALLOCATE path: the sim-worker creating the authoritative buffer.
      if (sharedArrayBufferAvailable()) {
        this.buffer = new SharedArrayBuffer(TRANSFORM_BUFFER_BYTES);
        this.shared = true;
      } else {
        this.buffer = new ArrayBuffer(TRANSFORM_BUFFER_BYTES);
        this.shared = false;
      }
    }

    const b = this.buffer;
    // One Float32Array per channel at its fixed byte offset; tightly packed.
    this.Position = {
      x: new Float32Array(b, OFF_POS_X, MAX_ENTITIES),
      y: new Float32Array(b, OFF_POS_Y, MAX_ENTITIES),
      z: new Float32Array(b, OFF_POS_Z, MAX_ENTITIES),
    };
    this.Rotation = {
      x: new Float32Array(b, OFF_ROT_X, MAX_ENTITIES),
      y: new Float32Array(b, OFF_ROT_Y, MAX_ENTITIES),
      z: new Float32Array(b, OFF_ROT_Z, MAX_ENTITIES),
      w: new Float32Array(b, OFF_ROT_W, MAX_ENTITIES),
    };
    this.Scale = {
      x: new Float32Array(b, OFF_SCL_X, MAX_ENTITIES),
      y: new Float32Array(b, OFF_SCL_Y, MAX_ENTITIES),
      z: new Float32Array(b, OFF_SCL_Z, MAX_ENTITIES),
    };
  }

  get version(): number {
    return this.storageVersion;
  }

  // --- TransformStorage write surface (matches facade.ts EXACTLY) ----------

  writePosition(eid: number, x: number, y: number, z: number): void {
    this.Position.x[eid] = x;
    this.Position.y[eid] = y;
    this.Position.z[eid] = z;
    this.storageVersion++;
  }

  writeRotation(eid: number, x: number, y: number, z: number, w: number): void {
    this.Rotation.x[eid] = x;
    this.Rotation.y[eid] = y;
    this.Rotation.z[eid] = z;
    this.Rotation.w[eid] = w;
    this.storageVersion++;
  }

  writeScale(eid: number, x: number, y: number, z: number): void {
    this.Scale.x[eid] = x;
    this.Scale.y[eid] = y;
    this.Scale.z[eid] = z;
    this.storageVersion++;
  }

  // --- Per-eid read surface (the render-thread side of the zero-copy bridge).
  // The base TransformStorage interface has no read methods (renderSyncSystem
  // reads the global SoA arrays directly); these are the SAB-storage equivalent,
  // writing into a caller-provided out array to stay allocation-free per frame.

  /** Read position into `out` (length >= 3): [x, y, z]. Returns `out`. */
  readPosition(eid: number, out: Float32Array | number[]): Float32Array | number[] {
    out[0] = this.Position.x[eid];
    out[1] = this.Position.y[eid];
    out[2] = this.Position.z[eid];
    return out;
  }

  /** Read rotation quaternion into `out` (length >= 4): [x, y, z, w]. */
  readRotation(eid: number, out: Float32Array | number[]): Float32Array | number[] {
    out[0] = this.Rotation.x[eid];
    out[1] = this.Rotation.y[eid];
    out[2] = this.Rotation.z[eid];
    out[3] = this.Rotation.w[eid];
    return out;
  }

  /** Read scale into `out` (length >= 3): [x, y, z]. Returns `out`. */
  readScale(eid: number, out: Float32Array | number[]): Float32Array | number[] {
    out[0] = this.Scale.x[eid];
    out[1] = this.Scale.y[eid];
    out[2] = this.Scale.z[eid];
    return out;
  }
}

/**
 * Convenience matching `createTransformStorage(world)` from facade.ts: returns a
 * fresh SAB-backed storage (allocate path). `world` is accepted for call-site
 * symmetry and is not retained (the SoA lives in the buffer, not the bitECS world).
 */
export function createSharedTransformStorage(
  _world?: unknown,
): SharedTransformStorage {
  return new SharedTransformStorage();
}
