// verifyWorldLog — export-bundle integrity check (Track E shipping hardening).
//
// Before a world is shipped, its exported command-log bundle should be proven self-consistent so a
// player never loads a truncated, reordered, or corrupted world. This is a fast, dependency-free
// STRUCTURAL verifier over the serialized JSONL log:
//   • it parses,
//   • carries a manifest/meta header,
//   • the manifest's declared command count matches the actual commands (catches truncation),
//   • command seqs are contiguous 0..n-1 (catches a duplicated, lost, or renumbered command —
//     parseWorldLog sorts by seq, so order is irrelevant but the seq SET must be intact),
//   • every command is a known kind,
//   • the log is non-empty.
// It returns a STRUCTURED report (per-check booleans + a human reason) so a ship pipeline can gate
// on it and tell the operator exactly what's wrong. Deeper replay-equivalence (the bundle replays
// to the same keyframes) is a separate, heavier check the caller can run with replayCommands.

import { parseWorldLog, type WorldCommand } from "./log.ts";
import { querySpatialEntities } from "../spatial/index.ts";
import type { WorldContext } from "../skills/registry.ts";

export interface LogVerifyChecks {
  parsed: boolean;
  metaPresent: boolean;
  nonEmpty: boolean;
  countMatches: boolean;
  seqsContiguous: boolean;
  kindsValid: boolean;
}

export interface LogVerifyResult {
  ok: boolean;
  commandCount: number;
  checks: LogVerifyChecks;
  reason?: string;
}

const VALID_KINDS = new Set(["seed", "physics", "skill", "meta"]);

/** A stable, order-independent digest of a world's reconstructed entity state (count + each
 *  entity's id and rounded position). Replaying a bundle and digesting twice must yield the SAME
 *  string — that's the replay-equivalence the ship gate asserts before publishing a world. Rounded
 *  to 1e-4 so digest equality reflects determinism, not float-print noise. */
export function worldStateDigest(world: WorldContext): string {
  const ents = querySpatialEntities(world, { sortBy: "entity" }).entities;
  const rows = ents.map((e) => `${e.entity}:${e.position[0].toFixed(4)},${e.position[1].toFixed(4)},${e.position[2].toFixed(4)}`);
  return `${ents.length}|${rows.join(";")}`;
}

export function verifyWorldLog(jsonl: string): LogVerifyResult {
  const checks: LogVerifyChecks = {
    parsed: false, metaPresent: false, nonEmpty: false,
    countMatches: false, seqsContiguous: false, kindsValid: false,
  };

  let parsed: { meta?: { commands?: number } | undefined; commands: WorldCommand[] };
  try {
    parsed = parseWorldLog(jsonl) as typeof parsed;
    checks.parsed = true;
  } catch (e) {
    return { ok: false, commandCount: 0, checks, reason: "unparseable log: " + (e instanceof Error ? e.message : String(e)) };
  }

  const commands = parsed.commands ?? [];
  const meta = parsed.meta;
  checks.metaPresent = meta !== undefined;
  checks.nonEmpty = commands.length > 0;

  const declared = typeof meta?.commands === "number" ? meta.commands : undefined;
  checks.countMatches = declared === undefined ? true : declared === commands.length;

  // parseWorldLog returns commands SORTED by seq, so the seq SET must be exactly 0..n-1 — any
  // duplicate, gap, or out-of-range seq means a command was lost, duplicated, or renumbered.
  let contiguous = true;
  for (let i = 0; i < commands.length; i++) {
    if ((commands[i] as { seq: number }).seq !== i) { contiguous = false; break; }
  }
  checks.seqsContiguous = contiguous;

  checks.kindsValid = commands.every((c) => VALID_KINDS.has((c as { kind: string }).kind));

  const ok = checks.parsed && checks.metaPresent && checks.nonEmpty
    && checks.countMatches && checks.seqsContiguous && checks.kindsValid;

  let reason: string | undefined;
  if (!ok) {
    if (!checks.nonEmpty) reason = "empty log (no commands)";
    else if (!checks.metaPresent) reason = "missing manifest/meta header line";
    else if (!checks.countMatches) reason = `manifest declares ${declared} commands but the log has ${commands.length} (truncated or padded)`;
    else if (!checks.seqsContiguous) reason = "command seq numbers are not contiguous 0..n-1 (a command was duplicated, lost, or renumbered)";
    else if (!checks.kindsValid) reason = "log contains an unknown command kind";
  }
  return { ok, commandCount: commands.length, checks, reason };
}
