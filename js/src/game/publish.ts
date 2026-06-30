// EXPORT PUBLISH (M6) — the Stage-5 export-everywhere path. A game that opted into recording
// (optIn "record+export" or "multiplayer") carries a replay-complete world-log; this assembles it
// into the portable export bundle (the same 5-file artifact the browser plays back). The bytes the
// log references ride the cache/export; the log itself is seed + the command stream + content hashes.
//
// IMPORTANT (the direct-path tradeoff from M1): only state that flows through skills is in the
// world-log. A pure direct-path game records physics but NOT its manager mutations, so it is not
// replay-complete. Export-everywhere therefore targets skill-routed games — `canExport` reflects the
// GDS opt-in choice that makes a game exportable.

import { assembleExport, type ExportFiles } from "../export/package.ts";
import type { WorldRecorder } from "../worldlog/recorder.ts";
import type { GameDesignSpec } from "./gds.ts";

/** Whether a GDS opted into the recording/export superstructure (vs. a pure direct-path game). */
export function canExport(gds: GameDesignSpec): boolean {
  return gds.optIn !== "direct-path";
}

export interface ExportOptions {
  /** Stable world id stamped into the export manifest. */
  worldId: string;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
  /** Keyframe cadence (0 → no keyframes; a direct command-stream replay). */
  keyframeInterval?: number;
  /** Transform keyframes (KeyframeRecorder output) — REQUIRED for Mode-A in-browser replay to show
   *  motion (the browser serves recorded transforms, not a re-simulation). Omit only for a
   *  command-stream-only export (replayed into a fresh engine, e.g. p27). */
  keyframes?: Parameters<typeof assembleExport>[0]["keyframes"];
  /** Content-addressed asset bytes placed this session (e.g. core.assets.bundle()) so the package is
   *  self-contained on replay. Omit for an asset-free world. */
  assets?: Parameters<typeof assembleExport>[0]["assets"];
}

/** Assemble the portable export bundle from a game's recorder. The recorder must have captured the
 *  whole session (attach() before authoring) for the export to be replay-complete; pass `keyframes`
 *  (transform snapshots) so the export renders with motion in the browser's Mode-A replay. */
export function exportGame(recorder: WorldRecorder, opts: ExportOptions): ExportFiles {
  return assembleExport({
    worldId: opts.worldId,
    meta: recorder.meta(),
    commands: recorder.commands,
    keyframes: opts.keyframes ?? [],
    keyframeInterval: opts.keyframeInterval ?? 0,
    assets: opts.assets,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  });
}
