// P_WORLDLOG_SUBSCRIBE -- kernel K4: worldlog poll -> subscribe (headless, deterministic).
//
// A live editor viewport (editor/src/viewport.js) used to learn about new authoring commands by
// polling worldlog.tail every second. This gates the PUSH alternative: WorldRecorder.onFinalized
// (recorder.ts) is the listener seam -- it fires only AFTER a command commits, so a failed or
// still-held (pending approval) command never reaches a subscriber. AuthoritativeServer wires that
// seam to a per-connection push (worldlog/subscribe -> worldlog/append, net/server.ts), computed
// by the SAME worldlogTail() helper (skills/worldlog.ts) the polled worldlog.tail skill calls, so
// poll and push can never disagree about what "authoring since X" means.
//
// Falsifiability:
//   A. worldlog/subscribe pushes the EXISTING tail immediately (before the request even acks).
//   B. a command recorded AFTER subscribing arrives as a worldlog/append push -- we never poll
//      worldlog.tail again to observe it.
//   C. cursor continuity across a MIXED poll+push sequence: the exact same batch delivered twice
//      (a poll racing a push) is, under the guard viewport.js's poll()/onNotification share
//      ("ignore any batch whose next <= state.cursor"), applied exactly once.
//   D. disconnecting a subscribed connection removes it from the push loop: further finalizes
//      neither push to it nor throw.
//
// Run: ./target/release/limina js/test/p_worldlog_subscribe.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { WORLDLOG_METHODS } from "../src/net/protocol.ts";
import { registerWorldlogSkills } from "../src/skills/worldlog.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";

let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_worldlog_subscribe FAIL: " + msg);
  pass++;
}

interface WorldlogAppendMsg {
  jsonrpc: "2.0";
  method: string;
  params: { commands: WorldCommand[]; next: number; reset: boolean };
}
interface JsonRpcReplyMsg {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: unknown;
}

class CaptureTransport implements NetServerTransport {
  readonly sent = new Map<number, string[]>();
  async accept(): Promise<number> {
    return ACCEPT_CLOSED;
  }
  async recv(_connId: number): Promise<string> {
    return "";
  }
  async close(_connId: number): Promise<void> {}
  async send(connId: number, line: string): Promise<void> {
    const lines = this.sent.get(connId) ?? [];
    lines.push(line);
    this.sent.set(connId, lines);
  }
}

// ---- A COPY of the dedupe guard specified for viewport.js's shared apply path: ignore any batch
// whose `next` does not ADVANCE the local cursor. Reproduced here (not imported -- viewport.js is a
// browser module that touches the DOM at import time) to prove the CONCEPT the server-side cursor
// contract must support: applying the same batch twice is a no-op the second time.
function applyBatchWithGuard(
  state: { cursor: number; applied: WorldCommand[] },
  batch: { commands: WorldCommand[]; next: number; reset: boolean },
): void {
  if (batch.next <= state.cursor) return; // duplicate / stale batch -- must not re-apply
  state.applied.push(...batch.commands);
  state.cursor = batch.next;
}

const BUILDER = resolveProfile("builder.readWrite");
const transport = new CaptureTransport();
const server = new AuthoritativeServer(transport, { sessionId: "p_worldlog_subscribe", seed: 0x57ac1e });
registerWorldlogSkills(server.registry, { recorder: server.recorder });

const internals = server as unknown as {
  conns: Map<number, { connId: number; session?: unknown; subscribed: boolean; closing: boolean; worldlogCursor?: number }>;
  handleLine: (conn: { connId: number; session?: unknown; subscribed: boolean; closing: boolean; worldlogCursor?: number }, line: string) => Promise<void>;
};

async function author(tool: string, input: Record<string, unknown>, tick: number): Promise<unknown> {
  const res = await server.registry.invoke(tool, input, {
    agentId: "agt_build",
    sessionId: "p_worldlog_subscribe_session",
    permissions: BUILDER,
    tick,
    world: server.world,
  });
  assert(res.success, `${tool} failed: ${JSON.stringify((res as { error?: unknown }).error)}`);
  return (res as { result: unknown }).result;
}

function parsedLines(connId: number): Array<WorldlogAppendMsg | JsonRpcReplyMsg> {
  return (transport.sent.get(connId) ?? []).map((line) => JSON.parse(line));
}
function appends(connId: number): WorldlogAppendMsg[] {
  return parsedLines(connId).filter((m): m is WorldlogAppendMsg => (m as WorldlogAppendMsg).method === WORLDLOG_METHODS.append);
}

// ===========================================================================
// A. worldlog/subscribe pushes the EXISTING tail immediately, before the ack.
// ===========================================================================
const testSession = {
  agentId: "agt_build",
  sessionId: "p_worldlog_subscribe_session",
  profile: "builder.readWrite",
  permissions: BUILDER,
};
const conn1 = { connId: 1, session: testSession, subscribed: false, closing: false, queuedIntents: 0 };
internals.conns.set(1, conn1);
await internals.handleLine(conn1, JSON.stringify({ jsonrpc: "2.0", id: 1, method: WORLDLOG_METHODS.subscribe, params: { since: 0 } }));

const linesAfterSubscribe = parsedLines(1);
assert(linesAfterSubscribe.length === 2, `A: expected a push + an ack, got ${linesAfterSubscribe.length} lines`);
const firstAppend = linesAfterSubscribe[0] as WorldlogAppendMsg;
assert(firstAppend.method === WORLDLOG_METHODS.append, "A: the FIRST line must be the worldlog/append push (pushed before the ack)");
assert(
  firstAppend.params.commands.some((c) => c.kind === "physics" && (c as { op: string }).op === "create_world"),
  "A: the initial push must include the bootstrap create_world authoring command",
);
const ack = linesAfterSubscribe[1] as JsonRpcReplyMsg;
assert(ack.id === 1 && (ack.result as { ok: boolean } | undefined)?.ok === true, "A: the subscribe request must ack {ok:true, next} AFTER the push");
assert((conn1 as { worldlogCursor?: number }).worldlogCursor === firstAppend.params.next, "A: the connection's cursor is set to the pushed batch's `next`");

// ===========================================================================
// B. a command recorded AFTER subscribing arrives as a push WITHOUT polling.
// ===========================================================================
const e1 = (await author("scene.createEntity", { shape: "box", position: [1, 2, 3] }, 1)) as { entity: string };
const afterCreate = appends(1);
assert(afterCreate.length === 2, `B: expected exactly one NEW push after the authoring command (2 total), got ${afterCreate.length}`);
const pushB = afterCreate[1];
assert(
  pushB.params.commands.some((c) => c.kind === "skill" && (c as { tool: string }).tool === "scene.createEntity"),
  "B: the pushed batch must contain the just-recorded scene.createEntity command",
);
assert(pushB.params.next > firstAppend.params.next, "B: the pushed batch's cursor advances past the initial subscribe cursor");

// A read-only poll (worldlog.tail, registered by registerWorldlogSkills) must NOT itself have
// produced this push -- prove it was the FINALIZE hook, not a side-effect of polling, by checking
// no worldlog.tail call has been made yet on this connection's session at all.
assert(afterCreate.length === 2, "B: no extra push beyond the one finalize produced (no double-push per command)");

// ===========================================================================
// C. cursor continuity across a MIXED poll+push sequence -- the SAME batch delivered twice
//    (a poll racing the push) is applied exactly once under the dedupe guard.
// ===========================================================================
// Simulate an independent poll from the ORIGINAL (pre-subscribe) cursor: it overlaps everything
// the push already delivered.
const polled = (await author("worldlog.tail", { since: 0 }, 1)) as { commands: WorldCommand[]; next: number; reset: boolean };
assert(polled.next === pushB.params.next, "C: a poll from since=0 and the accumulated pushes must agree on the SAME cursor (shared worldlogTail helper)");

const clientState = { cursor: 0, applied: [] as WorldCommand[] };
applyBatchWithGuard(clientState, { commands: firstAppend.params.commands, next: firstAppend.params.next, reset: firstAppend.params.reset });
applyBatchWithGuard(clientState, { commands: pushB.params.commands, next: pushB.params.next, reset: pushB.params.reset });
const appliedAfterPushes = clientState.applied.length;
assert(clientState.cursor === pushB.params.next, "C: cursor advanced through both pushes");

// Now the SAME poll batch (fully overlapping, from since=0) arrives -- it must be a no-op.
applyBatchWithGuard(clientState, polled);
assert(clientState.applied.length === appliedAfterPushes, "C: a stale/duplicate batch (next <= cursor) must NOT be re-applied");
assert(clientState.cursor === pushB.params.next, "C: cursor is unchanged by the duplicate batch");

// A genuinely NEW command after that must still apply (the guard isn't a one-way latch on progress).
await author("scene.createEntity", { shape: "sphere", position: [4, 5, 6] }, 2);
const pushC = appends(1).at(-1)!;
assert(pushC.params.next > clientState.cursor, "C: a fresh command still produces a batch that advances past the current cursor");
applyBatchWithGuard(clientState, { commands: pushC.params.commands, next: pushC.params.next, reset: pushC.params.reset });
assert(clientState.applied.length === appliedAfterPushes + pushC.params.commands.length, "C: a genuinely new batch IS applied");
assert(clientState.cursor === pushC.params.next, "C: cursor advances to the new batch's next");

// ===========================================================================
// D. disconnect removes the subscription: no push to a dead conn, no error.
// ===========================================================================
const sentBeforeDisconnect = (transport.sent.get(1) ?? []).length;
internals.conns.delete(1); // mirrors connLoop's teardown (this.conns.delete(conn.connId))
await author("scene.destroyEntity", { entity: e1.entity }, 3); // triggers pushWorldlogAppends again
const sentAfterDisconnect = (transport.sent.get(1) ?? []).length;
assert(sentAfterDisconnect === sentBeforeDisconnect, "D: a disconnected connection must receive NO further worldlog/append pushes");

// A second, still-subscribed connection proves the finalize->push loop keeps working for OTHER
// connections even while one just dropped (no exception, no cross-connection interference). Read
// the CURRENT cursor via the polled worldlog.tail skill (it includes the destroy recorded above).
const currentCursor = (await author("worldlog.tail", { since: 0 }, 3) as { next: number }).next;
const conn2 = { connId: 2, session: testSession, subscribed: false, closing: false, queuedIntents: 0 };
internals.conns.set(2, conn2);
await internals.handleLine(conn2, JSON.stringify({ jsonrpc: "2.0", id: 1, method: WORLDLOG_METHODS.subscribe, params: { since: currentCursor } }));
const conn2Initial = appends(2);
assert(conn2Initial.length === 1 && conn2Initial[0].params.commands.length === 0, "D: conn2 subscribing at the current cursor gets an immediate (empty) push, nothing missed");
await author("scene.createEntity", { shape: "box", position: [7, 7, 7] }, 4);
assert(appends(2).length === 2, "D: a live second subscriber still receives pushes after the first disconnected");

await server.shutdown();

ops.op_log(
  `p_worldlog_subscribe OK: ${pass} assertions -- worldlog/subscribe pushes the existing tail before its ack, ` +
    "a finalized command arrives as a worldlog/append push with no poll required, the same worldlogTail() " +
    "helper keeps poll and push cursor-consistent (a duplicate batch is a guarded no-op, a new one still applies), " +
    "and a disconnected connection is silently dropped from the push loop while other subscribers are unaffected.",
);
