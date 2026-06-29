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
//   • MERGE        — `merge(into, from)` fast-forwards when `into` is a prefix of `from`, else
//                    appends `from`'s divergent commands onto `into`.
//
// Branch command lists are kept seq-monotonic (commands are re-stamped on extend/fork/merge) so a
// branch is always a valid, replayable log. Pure data operations — no engine/world refs, no wall
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

export type MergeKind = "already-current" | "fast-forward" | "appended";
export interface MergeResult {
  kind: MergeKind;
  /** Commands added to `into` by the merge. */
  added: number;
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

  /** Merge `from` into `into`. Fast-forwards when `into` is a strict prefix of `from`; otherwise
   *  appends `from`'s divergent commands (after the common prefix) onto `into`. */
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
    // Divergent: append `from`'s unique tail onto `into`.
    const tail = src.slice(common);
    this.extend(into, tail);
    return { kind: "appended", added: tail.length };
  }
}
