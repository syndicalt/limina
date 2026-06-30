// DIRECT-PATH GAME RUNTIME (M1) — the public surface for building a game on limina's
// substrate without the agent/replay superstructure on the hot path.
//
//   createWindowedContext / createHeadlessContext  — the `createGameContext` factory family:
//       assemble engine + WorldContext + CoreSkills (the direct-path managers) + base once,
//       with opt-in world-log recording wrapped on demand.
//   GameLoop                                       — owns the load-bearing per-frame order
//       (sim step with re-entrancy guard; pose → ECS sync → skinning → present).
//
// Determinism / world-log / export remain available by passing `record` to a context — an
// opt-in layer wrapped AROUND a working game, never the mandatory authoring path.

export {
  createHeadlessContext,
  createWindowedContext,
  type GameContext,
  type RecordOptions,
  type HeadlessContextOptions,
  type WindowedContextOptions,
} from "./context.ts";

export { GameLoop, type GameLoopOptions, type FrameSynced } from "./loop.ts";
