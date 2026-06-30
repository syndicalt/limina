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
}

/** Assemble the portable export bundle from a game's recorder. The recorder must have captured the
 *  whole session (attach() before authoring) for the export to be replay-complete. */
export function exportGame(recorder: WorldRecorder, opts: ExportOptions): ExportFiles {
  return assembleExport({
    worldId: opts.worldId,
    meta: recorder.meta(),
    commands: recorder.commands,
    keyframes: [],
    keyframeInterval: opts.keyframeInterval ?? 0,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  });
}
