// limina world log (Phase 4 M1 / P4.0a) -- public surface.
//
// The AUTHORITATIVE, replay-complete world command/event model: record a running
// session's command stream (WorldRecorder), persist it as JSONL, and rebuild the
// final world state bit-identically into a fresh engine (replayWorldLog).
// M2 (snapshots+delta), M3 (durable sink), M4 (state sync) and M5 (AoI) build on
// this contract -- see log.ts for the binding command/event definition.

export {
  captureRandomState,
  captureWorldState,
  compareWorldState,
  installRandomState,
  installSeededRandom,
  LOG_VERSION,
  mulberry32,
  parseWorldLog,
  PHYSICS_OP_FN,
  RECORDED_PHYSICS_METHODS,
  serializeWorldLog,
  syncAllBodies,
} from "./log.ts";
export type {
  DivergenceReport,
  EntityState,
  EntityTableLike,
  ParsedWorldLog,
  PhysicsCommand,
  PhysicsOpName,
  SeedCommand,
  SeededRng,
  SkillCommand,
  WorldCommand,
  WorldLike,
  WorldLogMeta,
  WorldStateSnapshot,
} from "./log.ts";
export { WorldRecorder } from "./recorder.ts";
export { replayCommands, replayWorldLog } from "./replay.ts";
export type { ReplayDeps, ReplayResult } from "./replay.ts";
export { DurableWorldLog } from "./durable.ts";
export {
  base64ToBytes,
  bytesToBase64,
  captureWorldSnapshot,
  deltaCommandsAfter,
  parseSnapshot,
  recoverWorld,
  restoreSnapshot,
  serializeSnapshot,
  SNAPSHOT_VERSION,
} from "./snapshot.ts";
export type {
  CaptureSnapshotOptions,
  EntityIndexSnapshot,
  RecoveryResult,
  SnapshotEntity,
  WorldSnapshot,
} from "./snapshot.ts";
