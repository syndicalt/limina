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
//   generation   -       -                       0                      4
//   Position.x   1       0*N                     4                      4*N
//   Position.y   1       1*N                     4+4*N                  4*N
//   Position.z   1       2*N                     4+8*N                  4*N
//   Rotation.x   1       3*N                     4+12*N                 4*N
//   Rotation.y   1       4*N                     4+16*N                 4*N
//   Rotation.z   1       5*N                     4+20*N                 4*N
//   Rotation.w   1       6*N                     4+24*N                 4*N
//   Scale.x      1       7*N                     4+28*N                 4*N
//   Scale.y      1       8*N                     4+32*N                 4*N
//   Scale.z      1       9*N                     4+36*N                 4*N
//   ---------------------------------------------------------------------------
//   TOTAL       10                               TRANSFORM_BUFFER_BYTES = 4+40*N
//
// Each channel is a tightly-packed Float32Array(buffer, byteOffset, N) — no
// interleaving, no padding, contiguous and cache-friendly per-channel, matching
// the heap-backed SoA in world.ts exactly so reads/writes are bit-identical.
// ---------------------------------------------------------------------------

import { MAX_ENTITIES, Position, Rotation, Scale } from "../ecs/world.ts";
import type { TransformStorage } from "../ecs/facade.ts";

const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT; // 4

/** Transform buffer ABI v2 adds a seqlock generation before the v1 float lanes. */
export const TRANSFORM_BUFFER_LAYOUT_VERSION = 2;
export const TRANSFORM_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT;

/** Channel count: Position(3) + Rotation(4) + Scale(3). */
export const TRANSFORM_CHANNELS = 10;

/** Per-channel size in bytes (one Float32 per entity, MAX_ENTITIES entities). */
export const CHANNEL_BYTES = MAX_ENTITIES * BYTES_PER_FLOAT;

/** Total backing-buffer size for the full Position+Rotation+Scale SoA. */
export const TRANSFORM_BUFFER_BYTES = TRANSFORM_HEADER_BYTES + TRANSFORM_CHANNELS * CHANNEL_BYTES;

// Fixed channel byte offsets within the single buffer (see layout table above).
const OFF_POS_X = TRANSFORM_HEADER_BYTES + 0 * CHANNEL_BYTES;
const OFF_POS_Y = TRANSFORM_HEADER_BYTES + 1 * CHANNEL_BYTES;
const OFF_POS_Z = TRANSFORM_HEADER_BYTES + 2 * CHANNEL_BYTES;
const OFF_ROT_X = TRANSFORM_HEADER_BYTES + 3 * CHANNEL_BYTES;
const OFF_ROT_Y = TRANSFORM_HEADER_BYTES + 4 * CHANNEL_BYTES;
const OFF_ROT_Z = TRANSFORM_HEADER_BYTES + 5 * CHANNEL_BYTES;
const OFF_ROT_W = TRANSFORM_HEADER_BYTES + 6 * CHANNEL_BYTES;
const OFF_SCL_X = TRANSFORM_HEADER_BYTES + 7 * CHANNEL_BYTES;
const OFF_SCL_Y = TRANSFORM_HEADER_BYTES + 8 * CHANNEL_BYTES;
const OFF_SCL_Z = TRANSFORM_HEADER_BYTES + 9 * CHANNEL_BYTES;

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
  private readonly publication: Int32Array;
  private publicationDepth = 0;

  constructor(opts: { buffer?: SharedArrayBuffer | ArrayBuffer } = {}) {
    if (opts.buffer !== undefined) {
      // JOIN path: the render-main thread receiving the worker's SAB. Validate
      // the donor buffer matches the expected layout before aliasing it.
      const buf = opts.buffer;
      if (buf.byteLength !== TRANSFORM_BUFFER_BYTES) {
        throw new RangeError(
            `SharedTransformStorage: buffer size ${buf.byteLength} bytes does not ` +
            `match the expected transform layout (${TRANSFORM_BUFFER_BYTES} bytes ` +
            `= ${TRANSFORM_HEADER_BYTES}-byte header + ${TRANSFORM_CHANNELS} channels x ${MAX_ENTITIES} entities x ` +
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
    this.publication = new Int32Array(b, 0, 1);
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

  private loadPublicationGeneration(): number {
    return this.shared ? Atomics.load(this.publication, 0) : this.publication[0];
  }

  private storePublicationGeneration(value: number): void {
    if (this.shared) Atomics.store(this.publication, 0, value);
    else this.publication[0] = value;
  }

  /** Current seqlock generation. Even values are stable; odd values mean the
   * single writer is publishing a multi-entity transform set. */
  publicationGeneration(): number {
    return this.loadPublicationGeneration();
  }

  /** Begin one atomic transform publication. Nesting is supported so a higher
   * level authoring transaction can contain the fixed-step sync helper. */
  beginPublication(): void {
    if (this.publicationDepth++ > 0) return;
    const current = this.loadPublicationGeneration();
    const odd = (current + ((current & 1) === 0 ? 1 : 2)) | 0;
    this.storePublicationGeneration(odd);
  }

  /** Publish every transform write since beginPublication as one stable set. */
  endPublication(): void {
    if (this.publicationDepth < 1) throw new Error("SharedTransformStorage.endPublication without beginPublication");
    if (--this.publicationDepth > 0) return;
    const current = this.loadPublicationGeneration();
    this.storePublicationGeneration((current + ((current & 1) === 1 ? 1 : 2)) | 0);
  }

  // --- TransformStorage write surface (matches facade.ts EXACTLY) ----------
  // Every write ALSO mirrors into the module SoA (the facade contract): the SoA
  // is the sim-truth store creation writes and every capture/skill read path
  // uses; without the mirror the sim worker's authoring writes were invisible
  // to the scene adapter's after-state capture and commit replays diverged.

  writePosition(eid: number, x: number, y: number, z: number): void {
    this.Position.x[eid] = x;
    this.Position.y[eid] = y;
    this.Position.z[eid] = z;
    Position.x[eid] = x;
    Position.y[eid] = y;
    Position.z[eid] = z;
    this.storageVersion++;
  }

  writeRotation(eid: number, x: number, y: number, z: number, w: number): void {
    this.Rotation.x[eid] = x;
    this.Rotation.y[eid] = y;
    this.Rotation.z[eid] = z;
    this.Rotation.w[eid] = w;
    Rotation.x[eid] = x;
    Rotation.y[eid] = y;
    Rotation.z[eid] = z;
    Rotation.w[eid] = w;
    this.storageVersion++;
  }

  writeScale(eid: number, x: number, y: number, z: number): void {
    this.Scale.x[eid] = x;
    this.Scale.y[eid] = y;
    this.Scale.z[eid] = z;
    Scale.x[eid] = x;
    Scale.y[eid] = y;
    Scale.z[eid] = z;
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
