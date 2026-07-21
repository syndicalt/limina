// limina world-log DURABLE SINK (Phase 4 M3) -- streams the authoritative world
// command log to disk INCREMENTALLY as commands are recorded, so a fresh engine
// can reconstruct the session from the persisted log alone (persist -> reload ->
// replay -> bit-identical). Mirrors the P2 durable trace sink convention
// (op_write_trace to create, op_append_trace per segment).
//
// Format: each recorded command is appended as one JSONL line as it occurs; on
// close() a `meta` trailer line (accurate command/tick counts) is appended. A
// persisted segment therefore parses identically to a one-shot WorldRecorder
// .toJsonl() log (parseWorldLog scans for the meta line and sorts by seq), AND a
// crash before close() still leaves every recorded command on disk and replayable
// (the meta trailer is a convenience, not load-bearing for recovery).

import { ops as engineOps } from "../engine.ts";
import type { TraceOps } from "../engine.ts";
import { serializeWorldCommand } from "./log.ts";
import type { WorldRecorder } from "./recorder.ts";

// SEAM 3 (durable-log I/O): the durable sink depends on EXACTLY the trace ops --
// op_write_trace (create/truncate the segment), op_append_trace (one fsync'd
// append per segment), op_read_trace (recovery read). We narrow the runtime
// EngineOps to `TraceOps` so this file is type-checked against -- and documents
// -- the precise host surface a non-Deno backend (e.g. a browser IndexedDB/OPFS
// world-log store) must implement. The runtime value is unchanged; only the
// static TYPE the sink can reach through is narrowed.
const ops: TraceOps = engineOps;

export class DurableWorldLog {
  private flushed = 0;
  private opened = false;
  private resumed = false;
  /** Frozen-profile-mapping state for THIS segment (see serializeWorldCommand):
   *  the first flushed line pinning each profile keeps its full perms array so
   *  replay resolves later name-only lines from the log, not the live profile.
   *  resume() starts empty on purpose — the first pinned line after a resume
   *  re-freezes the mapping, which is redundant but harmless (parse is
   *  latest-mapping-wins in seq order) and covers a live-profile edit between
   *  sessions. */
  private readonly pinnedProfiles = new Set<string>();

  constructor(
    readonly recorder: WorldRecorder,
    readonly name: string,
    private readonly opts: { compactFlushed?: boolean } = {},
  ) {}

  /** Truncate/create the on-disk segment. Call once before streaming. */
  open(): void {
    ops.op_write_trace(this.name, "");
    this.flushed = 0;
    this.opened = true;
    this.resumed = false;
    this.pinnedProfiles.clear();
  }

  /** Resume streaming after an existing on-disk segment. Unlike open(), this
   *  never truncates or writes the segment; it only advances the durable cursor
   *  so flush() appends commands recorded after the recovered prefix. */
  resume(persistedCount: number): void {
    if (!Number.isSafeInteger(persistedCount) || persistedCount < 0) {
      throw new Error(`DurableWorldLog: invalid resume count ${persistedCount}`);
    }
    this.flushed = persistedCount;
    this.opened = true;
    this.resumed = true;
  }

  /** Append every command recorded since the last flush as JSONL lines, in one
   *  fsync'd append. Returns how many commands were flushed this call. */
  flush(): number {
    if (!this.opened) throw new Error("DurableWorldLog: open() before flush()");
    const limit = this.recorder.flushableCount();
    if (limit <= this.flushed) return 0;
    let chunk = "";
    for (let i = this.flushed; i < limit; i++) {
      const cmd = this.recorder.commandAt(i);
      if (cmd === undefined) {
        throw new Error(`DurableWorldLog: command ${i} was compacted before it was flushed`);
      }
      chunk += serializeWorldCommand(cmd, this.pinnedProfiles) + "\n";
    }
    ops.op_append_trace(this.name, chunk);
    const n = limit - this.flushed;
    this.flushed = limit;
    if (this.opts.compactFlushed === true) this.recorder.compactFinalizedPrefix(this.flushed);
    return n;
  }

  /** Rewrite the on-disk segment from the recorder's FULL in-memory history (kernel
   *  K-compaction). Used exactly once at boot, after a rehydrate of a legacy log dropped idle
   *  step records from re-recording: the recorder then holds a shorter, freshly-renumbered
   *  (contiguous-seq) command stream that no longer matches the segment, and APPENDING to the
   *  old segment would corrupt seq contiguity -- so the segment is replaced wholesale. The whole
   *  compacted history is written in ONE op_write_trace host call (no truncate-then-append
   *  window); a crash mid-write leaves a clean-lined prefix plus, at worst, one
   *  unterminated final fragment that the boot parser can discard. Requires the full history in memory (no prior
   *  hot-memory compaction) and a fully-settled recorder. Returns the command count written. */
  rewriteFromRecorder(): number {
    if (!this.opened) throw new Error("DurableWorldLog: open()/resume() before rewriteFromRecorder()");
    if (this.recorder.compactedCommandCount > 0) {
      throw new Error("DurableWorldLog: cannot rewrite after hot-memory compaction (full history is no longer in memory)");
    }
    const limit = this.recorder.flushableCount();
    if (limit !== this.recorder.commandCount) {
      throw new Error("DurableWorldLog: cannot rewrite while recorder commands are still pending");
    }
    // The segment is rebuilt from scratch, so the freeze state restarts with it.
    this.pinnedProfiles.clear();
    const rewritePins = this.pinnedProfiles;
    let chunk = "";
    for (let i = 0; i < limit; i++) {
      const cmd = this.recorder.commandAt(i);
      if (cmd === undefined) {
        throw new Error(`DurableWorldLog: command ${i} missing during rewrite`);
      }
      chunk += serializeWorldCommand(cmd, rewritePins) + "\n";
    }
    ops.op_write_trace(this.name, chunk);
    this.flushed = limit;
    // The segment is now a fresh recording, not a resumed one: close() must append a new meta
    // trailer describing the compacted stream.
    this.resumed = false;
    if (this.opts.compactFlushed === true) this.recorder.compactFinalizedPrefix(this.flushed);
    return limit;
  }

  /** Final flush + append the meta trailer. After this the persisted segment is
   *  a complete, replayable world log. */
  close(): { name: string; commands: number; segments: number } {
    const tail = this.flush();
    if (this.recorder.flushableCount() !== this.recorder.commandCount) {
      throw new Error("DurableWorldLog: cannot close while recorder commands are still pending");
    }
    if (!this.resumed || tail > 0) {
      ops.op_append_trace(this.name, JSON.stringify(this.recorder.meta()) + "\n");
    }
    return { name: this.name, commands: this.recorder.commandCount, segments: tail };
  }

  /** Commands recorded but not yet flushed to disk. */
  get pending(): number {
    return this.recorder.commandCount - this.flushed;
  }

  /** Commands already persisted to disk. */
  get persisted(): number {
    return this.flushed;
  }
}
