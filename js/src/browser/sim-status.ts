/** Version 2 of the sim-worker status bridge. The original four slots retain
 * their v1 indices; slot 4 additively reports fixed steps dropped by bounded
 * catch-up, so legacy readers that join only the first 16 bytes remain valid. */
export const SIM_STATUS_LAYOUT_VERSION = 2;
export const SIM_STATUS_INTS = 5;
export const SIM_STATUS_BYTES = SIM_STATUS_INTS * Int32Array.BYTES_PER_ELEMENT;

export const SIM_STATUS_TICK_INDEX = 0;
export const SIM_STATUS_FLAGS_INDEX = 1;
export const SIM_STATUS_PLAYER_EID_INDEX = 2;
export const SIM_STATUS_GENERATION_INDEX = 3;
export const SIM_STATUS_DROPPED_STEPS_INDEX = 4;

export const SIM_STATUS_FLAG_IN_WATER = 1 << 0;
export const SIM_STATUS_FLAG_SWIMMING = 1 << 1;
export const SIM_STATUS_FLAG_SUBMERGED = 1 << 2;
export const SIM_STATUS_KNOWN_FLAGS = SIM_STATUS_FLAG_IN_WATER
  | SIM_STATUS_FLAG_SWIMMING
  | SIM_STATUS_FLAG_SUBMERGED;

export interface SimStatusWrite {
  tick: number;
  flags: number;
  playerEid: number;
  droppedSteps: number;
}

export interface SimStatusSnapshot extends SimStatusWrite {
  generation: number;
  inWater: boolean;
  swimming: boolean;
  submerged: boolean;
}

export type MutableSimStatusSnapshot = SimStatusSnapshot;

function sharedView(view: Int32Array): boolean {
  return typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined" && view.buffer instanceof SharedArrayBuffer;
}

function load(view: Int32Array, index: number, shared: boolean): number {
  return shared ? Atomics.load(view, index) : view[index];
}

function store(view: Int32Array, index: number, value: number, shared: boolean): void {
  if (shared) Atomics.store(view, index, value);
  else view[index] = value;
}

export function createSimStatusView(buffer: SharedArrayBuffer | ArrayBuffer): Int32Array {
  if (buffer.byteLength < SIM_STATUS_BYTES) {
    throw new RangeError(`sim status buffer must be at least ${SIM_STATUS_BYTES} bytes`);
  }
  return new Int32Array(buffer, 0, SIM_STATUS_INTS);
}

/** Initialize an unpublished buffer before it crosses the worker handshake. */
export function initializeSimStatus(view: Int32Array): void {
  if (view.length < SIM_STATUS_INTS) throw new RangeError("sim status view must contain five int32 slots");
  view[SIM_STATUS_TICK_INDEX] = 0;
  view[SIM_STATUS_FLAGS_INDEX] = 0;
  view[SIM_STATUS_PLAYER_EID_INDEX] = -1;
  view[SIM_STATUS_GENERATION_INDEX] = 0;
  view[SIM_STATUS_DROPPED_STEPS_INDEX] = 0;
}

/** Single-writer seqlock publish: odd generation marks an in-progress write;
 * the following even generation makes tick, flags, and eid visible as one state. */
export function writeSimStatus(view: Int32Array, state: SimStatusWrite): void {
  if (view.length < SIM_STATUS_INTS) throw new RangeError("sim status view must contain five int32 slots");
  const shared = sharedView(view);
  const current = load(view, SIM_STATUS_GENERATION_INDEX, shared);
  const oddGeneration = (current + (current & 1 ? 2 : 1)) | 0;
  store(view, SIM_STATUS_GENERATION_INDEX, oddGeneration, shared);
  store(view, SIM_STATUS_TICK_INDEX, state.tick, shared);
  store(view, SIM_STATUS_FLAGS_INDEX, state.flags & SIM_STATUS_KNOWN_FLAGS, shared);
  store(view, SIM_STATUS_PLAYER_EID_INDEX, state.playerEid, shared);
  store(view, SIM_STATUS_DROPPED_STEPS_INDEX, state.droppedSteps, shared);
  store(view, SIM_STATUS_GENERATION_INDEX, (oddGeneration + 1) | 0, shared);
}

/** Allocation-free bounded seqlock read for render-loop callers. */
export function readSimStatusInto(
  view: Int32Array,
  target: MutableSimStatusSnapshot,
  maxAttempts = 8,
): boolean {
  if (view.length < SIM_STATUS_INTS) throw new RangeError("sim status view must contain five int32 slots");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("sim status maxAttempts must be a positive safe integer");
  const shared = sharedView(view);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = load(view, SIM_STATUS_GENERATION_INDEX, shared);
    if ((before & 1) !== 0) continue;
    const tick = load(view, SIM_STATUS_TICK_INDEX, shared);
    const flags = load(view, SIM_STATUS_FLAGS_INDEX, shared) & SIM_STATUS_KNOWN_FLAGS;
    const playerEid = load(view, SIM_STATUS_PLAYER_EID_INDEX, shared);
    const droppedSteps = load(view, SIM_STATUS_DROPPED_STEPS_INDEX, shared);
    const after = load(view, SIM_STATUS_GENERATION_INDEX, shared);
    if (before !== after || (after & 1) !== 0) continue;
    target.tick = tick;
    target.flags = flags;
    target.playerEid = playerEid;
    target.droppedSteps = droppedSteps;
    target.generation = after;
    target.inWater = (flags & SIM_STATUS_FLAG_IN_WATER) !== 0;
    target.swimming = (flags & SIM_STATUS_FLAG_SWIMMING) !== 0;
    target.submerged = (flags & SIM_STATUS_FLAG_SUBMERGED) !== 0;
    return true;
  }
  return false;
}

/** Immutable convenience read. Returns null instead of spinning when a writer remains
 * odd or changes generation through every attempt. Unknown future flag bits are ignored. */
export function readSimStatus(view: Int32Array, maxAttempts = 8): Readonly<SimStatusSnapshot> | null {
  const target: MutableSimStatusSnapshot = {
    tick: 0,
    flags: 0,
    playerEid: -1,
    droppedSteps: 0,
    generation: 0,
    inWater: false,
    swimming: false,
    submerged: false,
  };
  return readSimStatusInto(view, target, maxAttempts) ? Object.freeze(target) : null;
}
