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

/** True iff `commands` carry a UNIQUE, CONTIGUOUS 0..n-1 seq set (order-independent:
 *  parseWorldLog sorts, but a duplicate, gap, or out-of-range seq still means a
 *  command was lost, duplicated, or renumbered). The single contiguity rule reused
 *  by both the ship-gate report (verifyWorldLog) and the replay guard
 *  (assertReplayable), so the two never drift. */
export function seqsAreContiguous(commands: readonly { seq: number }[]): boolean {
  const n = commands.length;
  const seen = new Uint8Array(n);
  for (const c of commands) {
    const seq = c.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq >= n || seen[seq] === 1) return false;
    seen[seq] = 1;
  }
  return true;
}

/** Guard the REPLAY path: before replaying a command stream into a fresh engine,
 *  assert it is well-formed -- its seqs form a unique contiguous 0..n-1 set (the
 *  SAME rule verifyWorldLog gates on, reused via seqsAreContiguous), and the
 *  deterministic seed is well-positioned: AT MOST ONE `seed` command, and when
 *  present it MUST precede every randomness-consuming (physics/skill) command so
 *  replay re-installs the PRNG BEFORE anything can draw from it. A seedless log is
 *  valid (a session that drew no randomness never seeds), so seed absence is NOT
 *  rejected. An EMPTY command stream is valid too -- it replays to an empty world.
 *  Throws a clear Error on malformed input; well-formed recorder output always
 *  passes. A pure, local structural check -- no network. */
export function assertReplayable(commands: readonly WorldCommand[]): void {
  if (commands.length === 0) return; // nothing to replay -> an empty world; not malformed
  if (!seqsAreContiguous(commands)) {
    throw new Error("world log: command seqs are not a unique contiguous 0..n-1 set (a command was duplicated, lost, or renumbered) -- refusing to replay a malformed log");
  }
  let seeds = 0;
  let seedSeq = -1;
  let firstRandomSeq = Infinity; // lowest seq of a randomness-consuming (physics/skill) command
  for (const c of commands) {
    if (c.kind === "seed") {
      seeds++;
      seedSeq = c.seq;
    } else if (c.kind === "physics" || c.kind === "skill") {
      if (c.seq < firstRandomSeq) firstRandomSeq = c.seq;
    }
  }
  if (seeds > 1) {
    throw new Error(`world log: ${seeds} seed commands present (expected at most one) -- refusing to replay an ambiguously-seeded log`);
  }
  if (seeds === 1 && seedSeq > firstRandomSeq) {
    throw new Error("world log: a randomness-consuming command precedes the seed -- the PRNG must be installed before any command that could consume randomness; refusing to replay");
  }
}

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

  // The seq SET must be exactly 0..n-1 — any duplicate, gap, or out-of-range seq means a
  // command was lost, duplicated, or renumbered (shared rule; see seqsAreContiguous).
  checks.seqsContiguous = seqsAreContiguous(commands as { seq: number }[]);

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
