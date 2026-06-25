// limina ECS facade — JS-owned TypedArray transform storage.
//
// Phase 3 ownership decision (T2): transform components STAY JS-owned Float32Array
// SoA (Position/Rotation/Scale in world.ts) inside the single deterministic V8
// isolate. Native-owned component slabs and message-passed worker jobs remain
// DEFERRED: T3 profiling showed the locked-density frame budget is met on the main
// thread (deterministic non-render engine work ~1.5ms/frame at 12 players + 3
// builders + 28 entities; the windowed per-frame cost is render/present, not
// ECS/agent work). The earlier speculative job system (EcsMutationQueue,
// runChunkedEcsJob) and the snapshot / dirty-range double-buffering had no real
// engine consumer, so they were removed rather than left as tested-but-unwired
// dead code. The surviving surface is exactly what the engine uses today.

import { Position, Rotation, Scale } from "./world.ts";

/** Versioned write surface over the SoA transform components. The monotonic
 *  `version` lets the spatial index detect transform mutations and rebuild its
 *  grid lazily instead of every query. */
export interface TransformStorage {
  readonly version: number;
  writePosition(eid: number, x: number, y: number, z: number): void;
  writeRotation(eid: number, x: number, y: number, z: number, w: number): void;
  writeScale(eid: number, x: number, y: number, z: number): void;
}

class SoaTransformStorage implements TransformStorage {
  private storageVersion = 0;

  get version(): number {
    return this.storageVersion;
  }

  writePosition(eid: number, x: number, y: number, z: number): void {
    Position.x[eid] = x;
    Position.y[eid] = y;
    Position.z[eid] = z;
    this.storageVersion++;
  }

  writeRotation(eid: number, x: number, y: number, z: number, w: number): void {
    Rotation.x[eid] = x;
    Rotation.y[eid] = y;
    Rotation.z[eid] = z;
    Rotation.w[eid] = w;
    this.storageVersion++;
  }

  writeScale(eid: number, x: number, y: number, z: number): void {
    Scale.x[eid] = x;
    Scale.y[eid] = y;
    Scale.z[eid] = z;
    this.storageVersion++;
  }
}

/** `world` is accepted for call-site stability (the storage binds to the same
 *  bitECS world the caller owns); the SoA arrays are global, so it is not stored. */
export function createTransformStorage(_world: unknown): TransformStorage {
  return new SoaTransformStorage();
}
