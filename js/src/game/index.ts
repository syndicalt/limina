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

// The pipeline artifacts + stages (M2–M4): the GDS spine, the functional gate, the planner, and
// the coordinator. Engine-importable so the gate + coordinator run headless via the limina binary.
export {
  GameDesignSpecSchema, validateGDS, gdsJsonSchema,
  type GameDesignSpec, type DoDAssertion, type Entity, type Mechanic, type ContentItem,
} from "./gds.ts";
export {
  runDoD, runGate, assertGatePasses,
  type GameUnderTest, type SimInput, type DoDResult, type GateReport, type RunOptions,
} from "./gate.ts";
export {
  planFromGDS, ArchitecturePlanSchema,
  type ArchitecturePlan, type SystemMapping, type Slice,
} from "./plan.ts";
export {
  coordinate, defaultKnownSkill,
  type SliceBuilder, type Ledger, type SliceLedgerEntry,
} from "./coordinator.ts";
export { DIAGNOSTICS_KEY, publishDiagnostics, readDiagnostics, type Diagnostics } from "./diagnostics.ts";
export {
  parseGdd, interviewPlan, interviewCoverage, synthesizeGds, REQUIRED_GDS_FIELDS,
  type GddParse, type InterviewPersona, type InterviewQuestion, type InterviewAnswers,
} from "./intake.ts";
export { exportGame, canExport, type ExportOptions } from "./publish.ts";
