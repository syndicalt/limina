// WorldHistory — "git for worlds": branch / time-travel / diff / merge over the deterministic
// world-log (the recorded WorldCommand stream).
//
// This is the data model under the Studio's signature capability. Because a world is FULLY
// determined by its command log (replayCommands reconstructs exact state from a prefix), version
// control over a world reduces to version control over its command list:
//
//   • TIME-TRAVEL  — `at(branch, n)` returns the command PREFIX of length n; replaying it
//                    reconstructs the world exactly as it was after n commands.
//   • BRANCH       — `fork(name, from, atSeq)` copies a prefix into a new branch that diverges
//                    independently (cheap: it shares the prefix's history).
//   • DIFF         — `diff(a, b)` finds the common prefix and the commands unique to each side.
//   • MERGE        — `merge(into, from)` fast-forwards when `into` is a prefix of `from`; a
//                    divergent merge appends `from`'s unique commands only when the two tails are
//                    conflict-free (no shared entity references, no duplicated command), else it
//                    is REFUSED with a structured conflict report.
//
// Branch command lists are kept seq-monotonic (commands are re-stamped on extend/fork/merge; a
// divergent merge re-stamps ticks the same way) so a branch is always a valid, replayable log. Pure data operations — no engine/world refs, no wall
// clock — so this module is deterministic and unit-testable on its own.

import type { WorldCommand } from "./log.ts";

export interface BranchDiff {
  /** Number of leading commands identical in both branches. */
  commonPrefix: number;
  /** Commands present only on branch A (after the common prefix). */
  aOnly: WorldCommand[];
  /** Commands present only on branch B (after the common prefix). */
  bOnly: WorldCommand[];
  /** True when the two branches are identical. */
  identical: boolean;
}

export type MergeKind = "already-current" | "fast-forward" | "appended" | "conflict";

/** What made a divergent merge unsafe. Reported instead of silently merging. */
export interface MergeConflict {
  /** `ent_` ids referenced by BOTH divergent tails: the same entity was edited on
   *  each side, and replaying one side's edits after the other would apply them
   *  against a world (and an id-allocation sequence) neither side authored on. */
  entities: string[];
  /** Commands structurally identical (ignoring seq) in both divergent tails: the
   *  same edit reached both branches past the detected fork point, so appending
   *  would apply it twice (duplicate entities/mutations). */
  duplicateCommands: number;
}

export interface MergeResult {
  kind: MergeKind;
  /** Commands added to `into` by the merge. */
  added: number;
  /** Present iff kind === "conflict": the merge was REFUSED and neither branch
   *  was modified. Callers surface it (or fork and reconcile manually). */
  conflict?: MergeConflict;
}

/** Re-stamp a command list so seq = 0..n-1 (keeps a branch a valid monotonic log after edits). */
function reseq(commands: WorldCommand[]): WorldCommand[] {
  return commands.map((c, i) => ({ ...c, seq: i }) as WorldCommand);
}

/** Structural identity of a command, IGNORING seq (so a shared-but-reseq'd prefix still matches). */
function commandKey(c: WorldCommand): string {
  const { seq: _seq, ...rest } = c as WorldCommand & { seq: number };
  return JSON.stringify(rest);
}

/** Length of the longest leading run where a and b are structurally equal. */
function commonPrefixLength(a: WorldCommand[], b: WorldCommand[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && commandKey(a[i]) === commandKey(b[i])) i++;
  return i;
}

const ENT_ID_RE = /^ent_\d+$/;

/** Collect every `ent_` id a command's input references (deep string scan). Only
 *  skill inputs carry entity ids; physics commands address bodies by numeric id,
 *  which this scan cannot attribute, so cross-branch physics edits to one body are
 *  NOT detected here. */
function collectEntityRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (ENT_ID_RE.test(value)) out.add(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectEntityRefs(v, out);
    return;
  }
  for (const k of Object.keys(value)) collectEntityRefs((value as Record<string, unknown>)[k], out);
}

function tailEntityRefs(tail: readonly WorldCommand[]): Set<string> {
  const refs = new Set<string>();
  for (const c of tail) if (c.kind === "skill") collectEntityRefs(c.input, refs);
  return refs;
}

/** Detect why appending `srcTail` after `dstTail` would corrupt the merged world:
 *  an entity edited on both sides (its post-fork `ent_` references would rebind to
 *  different entities once the id-allocation order changes), or the same command
 *  present in both tails (it would replay twice). Returns undefined when the tails
 *  are safely disjoint. */
function detectMergeConflict(dstTail: readonly WorldCommand[], srcTail: readonly WorldCommand[]): MergeConflict | undefined {
  const dstRefs = tailEntityRefs(dstTail);
  const srcRefs = tailEntityRefs(srcTail);
  const entities: string[] = [];
  for (const id of srcRefs) if (dstRefs.has(id)) entities.push(id);
  entities.sort();
  const dstKeys = new Set(dstTail.map(commandKey));
  let duplicateCommands = 0;
  for (const c of srcTail) if (dstKeys.has(commandKey(c))) duplicateCommands++;
  return entities.length === 0 && duplicateCommands === 0 ? undefined : { entities, duplicateCommands };
}

/** Highest tick carried by any command in `commands` (0 when none carry a tick). */
function maxTick(commands: readonly WorldCommand[]): number {
  let max = 0;
  for (const c of commands) {
    if (c.kind === "seed") continue;
    if (c.tick > max) max = c.tick;
  }
  return max;
}

export class WorldHistory {
  private readonly branches = new Map<string, WorldCommand[]>();

  constructor(mainCommands: WorldCommand[] = [], mainName = "main") {
    this.branches.set(mainName, reseq(mainCommands));
  }

  names(): string[] {
    return [...this.branches.keys()];
  }
  has(name: string): boolean {
    return this.branches.has(name);
  }
  private require(name: string): WorldCommand[] {
    const b = this.branches.get(name);
    if (b === undefined) throw new Error(`WorldHistory: no branch "${name}"`);
    return b;
  }
  /** A copy of a branch's full command list. */
  commands(name: string): WorldCommand[] {
    return this.require(name).map((c) => ({ ...c }) as WorldCommand);
  }
  /** Number of commands on a branch (its "tip"). */
  tip(name: string): number {
    return this.require(name).length;
  }

  /** Append commands to a branch, re-stamping their seq to continue monotonically. Returns the new tip. */
  extend(name: string, commands: WorldCommand[]): number {
    const b = this.require(name);
    for (const c of commands) b.push({ ...c, seq: b.length } as WorldCommand);
    return b.length;
  }

  /** Fork `from` into a new branch `newName`, sharing the prefix of length `atSeq` (default: the
   *  full tip). The new branch diverges independently. Returns false if `newName` already exists. */
  fork(newName: string, from: string, atSeq?: number): boolean {
    if (this.branches.has(newName)) return false;
    const src = this.require(from);
    const cut = atSeq === undefined ? src.length : Math.max(0, Math.min(atSeq, src.length));
    this.branches.set(newName, reseq(src.slice(0, cut)));
    return true;
  }

  /** The command PREFIX of `name` up to `count` commands — the time-travel view. Replaying it
   *  reconstructs the world exactly as it was after `count` commands. */
  at(name: string, count: number): WorldCommand[] {
    const b = this.require(name);
    const k = Math.max(0, Math.min(count, b.length));
    return b.slice(0, k).map((c) => ({ ...c }) as WorldCommand);
  }

  /** Structural diff between two branches. */
  diff(a: string, b: string): BranchDiff {
    const ca = this.require(a), cb = this.require(b);
    const common = commonPrefixLength(ca, cb);
    const aOnly = ca.slice(common).map((c) => ({ ...c }) as WorldCommand);
    const bOnly = cb.slice(common).map((c) => ({ ...c }) as WorldCommand);
    return { commonPrefix: common, aOnly, bOnly, identical: aOnly.length === 0 && bOnly.length === 0 };
  }

  /** Merge `from` into `into`. Fast-forwards when `into` is a strict prefix of `from`. A DIVERGENT
   *  merge is conflict-checked first: when both tails touch the same entity, or the same command
   *  reached both tails, the merge is REFUSED with a structured conflict report (kind "conflict",
   *  branches untouched) — appending anyway would rebind post-fork `ent_` references or replay an
   *  edit twice. A conflict-free divergent tail is appended with seq AND tick re-stamped, keeping
   *  the merged branch a monotonic, replayable log. */
  merge(into: string, from: string): MergeResult {
    const dst = this.require(into);
    const src = this.require(from);
    const common = commonPrefixLength(dst, src);
    if (dst.length === src.length && common === dst.length) return { kind: "already-current", added: 0 };
    if (common === dst.length) {
      // `into` is a prefix of `from` → fast-forward to `from`.
      const added = src.length - dst.length;
      this.branches.set(into, reseq(src.slice()));
      return { kind: "fast-forward", added };
    }
    // Divergent: refuse on conflict, else append `from`'s unique tail onto `into`.
    const tail = src.slice(common);
    const conflict = detectMergeConflict(dst.slice(common), tail);
    if (conflict !== undefined) return { kind: "conflict", added: 0, conflict };
    // Ticks shift by a constant so the first appended command lands at/after the
    // destination's last tick (mirroring the seq re-stamp): the tail's internal
    // spacing is preserved and the merged log stays tick-monotonic in seq order.
    const dstLastTick = maxTick(dst);
    let offset = 0;
    for (const c of tail) {
      if (c.kind === "seed") continue;
      offset = Math.max(0, dstLastTick - c.tick);
      break;
    }
    for (const c of tail) {
      const stamped = c.kind === "seed" ? { ...c } : { ...c, tick: c.tick + offset };
      dst.push({ ...stamped, seq: dst.length } as WorldCommand);
    }
    return { kind: "appended", added: tail.length };
  }
}
