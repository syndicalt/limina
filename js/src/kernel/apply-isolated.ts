// Isolated authoring-batch application — the Layer-2 (live-viewport) graceful boundary.
//
// `applyAuthorCommands` (kernel/authoring.ts) applies a batch STOPPING at the first failure. The two
// LIVE apply loops (sim-worker `loadWorld` + browser-entry `runLive`) must instead ISOLATE each
// command: one bad / out-of-band command (unknown asset id, content-hash mismatch, capacity, an
// unknown skill name) must NEVER abort the batch or wedge the viewport. This module is the shared,
// headless-testable applier both loops call.
//
// It REUSES the exact per-command contract the kernel + skill layers already have — every command
// still goes through `applyAuthorCommand` → `registry.invoke`, which already wraps every handler in
// try/catch (registry.ts `applyHandler`) and returns a clean `{ success:false, error }`. So there is
// NO parallel error model here; only the abort POLICY differs (continue-and-collect vs stop-at-first).
//
// This file is deliberately dependency-light (type-only imports of the registry/protocol + the pure
// `applyAuthorCommand` function) so it imports cheaply into a headless gate with no browser/three/wasm
// surface — that is what lets the success criteria drive the REAL per-command apply.

import { applyAuthorCommand, type ApplyOptions, type AuthorCommand } from "./authoring.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

/** A per-command failure carried OUT of an isolated batch (never thrown). */
export interface AuthorCommandFailure {
  /** Index into the `cmds` array that was applied (stable while the log is append-only). */
  index: number;
  /** A short, stable human label for the command (skill tool / physics op). */
  command: string;
  /** The failure message: a skill error, a validation error, or a thrown Error's message. */
  message: string;
}

/** A short, stable label for an AuthorCommand — used for failure reporting + quarantine surfacing. */
export function describeAuthorCommand(cmd: AuthorCommand): string {
  return cmd.kind === "physics" ? `physics.${String(cmd.op)}` : `skill:${cmd.tool}`;
}

/** The result of an isolated batch: the per-command MCPResponse (1:1 with the input, in order) plus
 *  the subset that failed (with their original indices). NEVER throws. */
export interface IsolatedBatchResult {
  results: MCPResponse[];
  failures: AuthorCommandFailure[];
}

/** Apply a batch, ISOLATING each command: a failing command is recorded and the batch CONTINUES
 *  (unlike `applyAuthorCommands`, which stops at the first failure). A command that THROWS — an
 *  unknown physics-op programming error from `applyAuthorCommand`, or a handler bug that somehow
 *  escapes registry's own try/catch — is converted to a structured failure too, so this function
 *  NEVER throws. Each command's effect is applied against `world` exactly as `applyAuthorCommand`
 *  would; only the abort policy differs, keeping the isolation contract identical to Layer 1. */
export async function applyAuthorCommandsIsolated(
  registry: SkillRegistry,
  world: WorldContext,
  cmds: readonly AuthorCommand[],
  opts: ApplyOptions,
): Promise<IsolatedBatchResult> {
  const results: MCPResponse[] = [];
  const failures: AuthorCommandFailure[] = [];
  for (let index = 0; index < cmds.length; index++) {
    const cmd = cmds[index];
    let res: MCPResponse;
    try {
      res = await applyAuthorCommand(registry, world, cmd, opts);
    } catch (err) {
      // applyAuthorCommand throws ONLY on a genuinely malformed command (an unknown physics op) or a
      // handler bug escaping registry's own catch. Contain it here so ONE bad command cannot abort the
      // batch or wedge the viewport — the whole point of the Layer-2 boundary.
      res = { success: false, error: { code: "handler_error", message: err instanceof Error ? err.message : String(err) } };
    }
    results.push(res);
    if (!res.success) {
      // Carry the error's structured data (bounded) — replay-divergence reports
      // are uninvestigable from the one-line message alone.
      const data = (res.error as { data?: unknown } | undefined)?.data;
      const detail = data === undefined ? "" : ` :: ${JSON.stringify(data).slice(0, 6144)}`;
      failures.push({ index, command: describeAuthorCommand(cmd), message: (res.error?.message ?? "unknown error") + detail });
    }
  }
  return { results, failures };
}

// ───────────────────────────────────────────────────────────────────────────────
// Viewport reboot quarantine — skip a command that failed authoring on a prior pass.
// ───────────────────────────────────────────────────────────────────────────────

/** Partition an author-command list into the commands to REPLAY and a map back to their original
 *  indices, skipping any command whose original index is QUARANTINED. The editor viewport re-authors
 *  the whole accumulated command history on every reboot; without this, ONE historically-bad command
 *  (e.g. an out-of-band asset the agent generated once) would fail authoring on EVERY future reboot
 *  and wedge the viewport forever. Quarantining a failed command's index keeps it out of the replayed
 *  set on the next pass while preserving order + index stability (the command log is append-only, so a
 *  command sits at the same index across reboots and across a scrub PREFIX of the same log). */
export function partitionQuarantined<T>(
  cmds: readonly T[],
  quarantined: ReadonlySet<number>,
): { kept: T[]; keptIndex: number[] } {
  const kept: T[] = [];
  const keptIndex: number[] = [];
  for (let i = 0; i < cmds.length; i++) {
    if (quarantined.has(i)) continue;
    kept.push(cmds[i]);
    keptIndex.push(i);
  }
  return { kept, keptIndex };
}

// ───────────────────────────────────────────────────────────────────────────────
// Worker handshake — settle (never hang) on `ready` OR `error`.
// ───────────────────────────────────────────────────────────────────────────────

/** The outcome of the worker startup handshake: the `ready` payload, or a failure message. */
export type WorkerHandshakeResult<R> = { ok: true; ready: R } | { ok: false; error: string };

export interface WorkerHandshake<R> {
  /** Settles exactly once — on the first `ready`/`error` message (`offer`) or a hard `fail`. */
  readonly promise: Promise<WorkerHandshakeResult<R>>;
  /** Feed a worker message. Returns true if this message SETTLED the handshake (ready or error). */
  offer(data: unknown): boolean;
  /** Hard-fail the handshake (worker.onerror / spawn failure) so `await promise` still settles. */
  fail(message: string): void;
}

/** Build a worker-startup handshake whose promise ALWAYS settles. The original bug: the main-thread
 *  listener resolved `ready` only on `{type:"ready"}`, so when the worker posted `{type:"error"}` the
 *  promise never resolved and `runLive` hung on `await ready`. Here BOTH a `ready` and an `error`
 *  message settle the promise (error → `{ ok:false }`), and `fail()` covers a hard worker error, so
 *  the caller can never hang. Idempotent: only the first settle wins. */
export function createWorkerHandshake<R = unknown>(initPhase = "init"): WorkerHandshake<R> {
  let settle!: (r: WorkerHandshakeResult<R>) => void;
  let settled = false;
  const promise = new Promise<WorkerHandshakeResult<R>>((resolve) => { settle = resolve; });
  const finish = (r: WorkerHandshakeResult<R>): void => {
    if (settled) return;
    settled = true;
    settle(r);
  };
  return {
    promise,
    offer(data: unknown): boolean {
      const msg = data as { type?: string; phase?: string; message?: string } | null | undefined;
      if (msg?.type === "ready") { finish({ ok: true, ready: data as R }); return true; }
      if (msg?.type === "error") {
        finish({ ok: false, error: `sim worker ${msg.phase ?? initPhase}: ${msg.message ?? "unknown"}` });
        return true;
      }
      return false;
    },
    fail(message: string): void { finish({ ok: false, error: message }); },
  };
}
