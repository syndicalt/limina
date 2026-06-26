// Phase 7 — CO-AUTHORING EDITOR engine contract (headless, REAL sockets,
// falsifiable). This is the functional proof behind the `editor/` web app: it
// drives the EXACT sequence the editor performs over the authoritative MCP-ws
// server and asserts the real engine behaviour the UI is built against.
//
// Topology (mirrors p4_authoritative_sync — a self-bound localhost WS listener +
// the real AuthoritativeServer the `--mcp-ws` runtime runs + real NetClients that
// have ZERO access to server memory):
//   - client A = the AGENT (profile `builder.review`): an external MCP client that
//     PROPOSES a mutating world edit. The review gate HOLDS it (no world change).
//   - client B = the EDITOR / human reviewer (profile `reviewer`): performs the
//     editor's read+approve loop entirely over the wire.
//
// The editor sequence under test (the same MCP method/response shapes the
// `editor/` client module uses):
//   inspector.snapshot  -> render the World panel (entities + skills + trace)
//   trace.tail          -> find the `skill.approval.pending` (the Approval queue)
//   approval.list       -> read the held action (proposed input + proposing agent)
//   approval.grant      -> apply it
//   inspector.snapshot  -> the world ACTUALLY changed (entity created)
//   trace.explainEvent  -> the causal chain pending -> granted -> executed
//
// Falsifiability (load-bearing negative controls):
//   - while held, a fresh inspector.snapshot shows the world UNCHANGED (if the
//     gate didn't really hold, the entity would already be there and we fail);
//   - the DENY path drops a second proposal: the world stays unchanged and a
//     `skill.approval.denied` event is recorded.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient, type JsonRpcMsg } from "../src/net/client.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import type { NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p7_editor_contract FAIL: " + message);
}

// A minimal Transformable: spawnRenderable only stores the object (render-sync,
// which we never run, would drive it), so empty setters suffice.
const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

// ---------------------------------------------------------------------------
// The editor's MCP call shape. The authoritative server wraps every tools/call
// result in an MCPResponse ({success, result, metadata}); a held/denied action
// comes back as a JSON-RPC ERROR whose `message` is the approvalId and whose
// `data` carries that MCPResponse (error.code === "pending_approval"). This is
// EXACTLY what `editor/src/mcp-client.js#callTool` unwraps.
// ---------------------------------------------------------------------------
interface ToolOutcome {
  success: boolean;
  result?: any;
  jsonRpcCode?: number;
  message?: string;
  mcpCode?: string;
}
async function callTool(client: NetClient, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const msg: JsonRpcMsg = await client.call(name, args);
  if (msg.error !== undefined) {
    const data = msg.error.data as { error?: { code?: string } } | undefined;
    return { success: false, jsonRpcCode: msg.error.code, message: msg.error.message, mcpCode: data?.error?.code };
  }
  const mcp = msg.result as { success: boolean; result?: unknown; error?: { code: string; message: string } };
  if (mcp.success) return { success: true, result: mcp.result };
  return { success: false, mcpCode: mcp.error?.code, message: mcp.error?.message };
}

// ===========================================================================
// PHASE 0 — stand up the authoritative server with the review gate + an agent
//           and the editor as two real WS clients.
// ===========================================================================
const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;

let baselineEntity = "";
const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p7_editor",
  seed: 0xed170,
  tickMs: 8,
  bootstrap: ({ world }) => {
    baselineEntity = spawnMarker(world, 0, 0, 0); // a world that isn't empty
  },
});
// Hold the MUTATING world-edits of any client running the `builder.review`
// profile (the exact gate the editor's contract assumes). Reads + approval.*
// are never gated.
server.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
server.start();

const agent = await NetClient.connect(net, url);  // client A — proposes edits
const editor = await NetClient.connect(net, url); // client B — the human editor
await agent.initialize("agt_builder", "ses_agent", "builder.review");
await editor.initialize("human_editor", "ses_editor", "reviewer");

// ===========================================================================
// PHASE 1 — the editor renders the World panel from inspector.snapshot.
// ===========================================================================
const snap0 = await callTool(editor, "inspector.snapshot", {});
assert(snap0.success, "inspector.snapshot failed for the editor (reviewer): " + JSON.stringify(snap0));
const world0 = snap0.result as {
  entities: { entity: string; transform: { position: number[] } }[];
  skills: { name: string }[];
  permissions: { caller: string[] };
  trace: { actors: string[] };
};
const entitiesBefore = world0.entities.length;
assert(entitiesBefore >= 1 && world0.entities.some((e) => e.entity === baselineEntity),
  "snapshot did not include the baseline world entity");
const skillNames = new Set(world0.skills.map((s) => s.name));
for (const need of ["inspector.snapshot", "trace.tail", "trace.explainEvent", "approval.list", "approval.grant", "approval.deny", "scene.createEntity"]) {
  assert(skillNames.has(need), `snapshot.skills is missing the editor-required skill '${need}'`);
}
assert(world0.permissions.caller.includes("approval.review"),
  "the editor session is not carrying the approval.review capability");

// ===========================================================================
// PHASE 2 — the AGENT proposes a mutating edit; the gate HOLDS it.
// ===========================================================================
const POS: [number, number, number] = [7, 8, 9]; // distinctive => unambiguous proof
const proposal = await callTool(agent, "scene.createEntity", { position: POS, shape: "box" });
assert(!proposal.success, "the mutating proposal was NOT held (gate inert): " + JSON.stringify(proposal));
assert(proposal.jsonRpcCode === -32003, `held action mapped to ${proposal.jsonRpcCode}, expected -32003 (pending_approval)`);
assert(proposal.mcpCode === "pending_approval", `held action MCP code was '${proposal.mcpCode}', expected 'pending_approval'`);
const approvalId = proposal.message!;
assert(approvalId.length > 0, "no approvalId returned on the held action");

// FALSIFIABILITY: while held, the world is UNCHANGED (a fresh snapshot proves the
// gate actually withheld the write — this is the load-bearing negative control).
const snapHeld = await callTool(editor, "inspector.snapshot", {});
assert(snapHeld.success, "inspector.snapshot (held phase) failed");
const worldHeld = snapHeld.result as { entities: { transform: { position: number[] } }[]; trace: { actors: string[] } };
assert(worldHeld.entities.length === entitiesBefore, "the held action changed the world BEFORE approval (gate not holding)");
assert(!worldHeld.entities.some((e) => e.transform.position[0] === 7 && e.transform.position[1] === 8 && e.transform.position[2] === 9),
  "the proposed entity already exists while the action is only pending");
// The proposing agent is visible to the editor via the snapshot's trace actors.
assert(worldHeld.trace.actors.includes("agt_builder"), "the proposing agent is not visible in the snapshot trace metadata");

// ===========================================================================
// PHASE 3 — the editor's Approval queue: trace.tail finds the pending event,
//           approval.list reads the held action's proposed input + proposer.
// ===========================================================================
const tail = await callTool(editor, "trace.tail", { type: "skill.approval.pending", limit: 50 });
assert(tail.success, "trace.tail failed");
const tailEvents = (tail.result as { events: { id: string; type: string; payload: any }[] }).events;
const pendingEv = tailEvents.find((e) => e.id === approvalId);
assert(pendingEv !== undefined, "trace.tail did not surface the skill.approval.pending event the editor polls for");
assert(pendingEv!.payload.skill === "scene.createEntity", "pending event skill mismatch");
assert(pendingEv!.payload.agentId === "agt_builder", "pending event is not attributed to the proposing agent");
assert(pendingEv!.payload.profile === "builder.review", "pending event lost the proposer's profile");

const list = await callTool(editor, "approval.list", {});
assert(list.success, "approval.list failed for the reviewer");
const pendingList = (list.result as { pending: { approvalId: string; skill: string; agentId: string; profile: string | null; input: any }[] }).pending;
const held = pendingList.find((p) => p.approvalId === approvalId);
assert(held !== undefined, "approval.list did not return the held action");
assert(held!.skill === "scene.createEntity" && held!.agentId === "agt_builder" && held!.profile === "builder.review",
  "approval.list metadata does not match the held action");
assert(Array.isArray(held!.input.position) && held!.input.position[0] === 7 && held!.input.position[2] === 9,
  "approval.list did not surface the proposed input (position) the editor renders for the human");

// ===========================================================================
// PHASE 4 — the editor APPROVES; the world ACTUALLY changes.
// ===========================================================================
const grant = await callTool(editor, "approval.grant", { approvalId });
assert(grant.success, "approval.grant failed: " + JSON.stringify(grant));
const grantOut = grant.result as { resolved: boolean; applied: boolean; error: string | null };
assert(grantOut.resolved && grantOut.applied && grantOut.error === null,
  "grant did not report the held action as applied: " + JSON.stringify(grantOut));

const snapAfter = await callTool(editor, "inspector.snapshot", {});
assert(snapAfter.success, "post-grant inspector.snapshot failed");
const worldAfter = snapAfter.result as { entities: { entity: string; transform: { position: number[] } }[] };
assert(worldAfter.entities.length === entitiesBefore + 1, `world entity count ${worldAfter.entities.length} != ${entitiesBefore + 1} after grant`);
const created = worldAfter.entities.find((e) => e.transform.position[0] === 7 && e.transform.position[1] === 8 && e.transform.position[2] === 9);
assert(created !== undefined, "the granted entity is NOT present in the world at the proposed position");

// ===========================================================================
// PHASE 5 — the reasoning view: trace.explainEvent shows pending -> granted ->
//           executed, the causal chain the editor renders for the human.
// ===========================================================================
const explain = await callTool(editor, "trace.explainEvent", { eventId: approvalId });
assert(explain.success, "trace.explainEvent failed");
const children = (explain.result as { children: { id: string; type: string; causedBy: string[]; payload: any }[] }).children;
const grantedEv = children.find((e) => e.type === "skill.approval.granted");
assert(grantedEv !== undefined && grantedEv.causedBy.includes(approvalId), "skill.approval.granted is not linked (causedBy) to the pending event");
const executedEv = children.find((e) => e.type === "skill.executed" && e.payload?.skill === "scene.createEntity");
assert(executedEv !== undefined, "no skill.executed for the granted action");
assert(executedEv!.causedBy.includes(approvalId) && executedEv!.causedBy.includes(grantedEv!.id),
  "skill.executed is not causally linked to BOTH the pending and the granted event");

// ===========================================================================
// PHASE 6 — the editor's REJECT path: a second proposal is denied and dropped.
// ===========================================================================
const proposal2 = await callTool(agent, "scene.createEntity", { position: [1, 2, 3], shape: "sphere" });
assert(!proposal2.success && proposal2.mcpCode === "pending_approval", "second mutating proposal was not held");
const approvalId2 = proposal2.message!;
const beforeDeny = (await callTool(editor, "inspector.snapshot", {})).result.entities.length as number;
const deny = await callTool(editor, "approval.deny", { approvalId: approvalId2, reason: "not now" });
assert(deny.success && (deny.result as { resolved: boolean }).resolved, "approval.deny did not resolve");
const afterDeny = (await callTool(editor, "inspector.snapshot", {})).result.entities.length as number;
assert(afterDeny === beforeDeny, "a DENIED action still changed the world");
const denyTail = await callTool(editor, "trace.tail", { type: "skill.approval.denied", limit: 50 });
assert((denyTail.result as { events: { payload: any }[] }).events.some((e) => e.payload.approvalId === approvalId2),
  "no skill.approval.denied event recorded for the rejected action");

// ---- teardown -------------------------------------------------------------
await agent.close();
await editor.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log(
  "p7_editor_contract OK: editor's MCP loop over REAL sockets — inspector.snapshot rendered the world+skills+caller-caps; " +
    "agent's scene.createEntity HELD (pending_approval/-32003, world unchanged while pending); trace.tail surfaced skill.approval.pending; " +
    "approval.list exposed the proposed input+proposer; approval.grant APPLIED it (entities " + entitiesBefore + "->" + worldAfter.entities.length +
    " with the entity present at [7,8,9]); trace.explainEvent showed pending->granted->executed linked; " +
    "reject path denied a second proposal (world unchanged, skill.approval.denied recorded).",
);
