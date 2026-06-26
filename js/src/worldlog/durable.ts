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

  constructor(readonly recorder: WorldRecorder, readonly name: string) {}

  /** Truncate/create the on-disk segment. Call once before streaming. */
  open(): void {
    ops.op_write_trace(this.name, "");
    this.flushed = 0;
    this.opened = true;
  }

  /** Append every command recorded since the last flush as JSONL lines, in one
   *  fsync'd append. Returns how many commands were flushed this call. */
  flush(): number {
    if (!this.opened) throw new Error("DurableWorldLog: open() before flush()");
    const cmds = this.recorder.commands;
    if (cmds.length <= this.flushed) return 0;
    let chunk = "";
    for (let i = this.flushed; i < cmds.length; i++) chunk += JSON.stringify(cmds[i]) + "\n";
    ops.op_append_trace(this.name, chunk);
    const n = cmds.length - this.flushed;
    this.flushed = cmds.length;
    return n;
  }

  /** Final flush + append the meta trailer. After this the persisted segment is
   *  a complete, replayable world log. */
  close(): { name: string; commands: number; segments: number } {
    const tail = this.flush();
    ops.op_append_trace(this.name, JSON.stringify(this.recorder.meta()) + "\n");
    return { name: this.name, commands: this.recorder.commands.length, segments: tail };
  }

  /** Commands recorded but not yet flushed to disk. */
  get pending(): number {
    return this.recorder.commands.length - this.flushed;
  }

  /** Commands already persisted to disk. */
  get persisted(): number {
    return this.flushed;
  }
}
