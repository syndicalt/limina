// P4 / M4 -- authoritative server + multi-client state sync (headless, REAL
// sockets, falsifiable).
//
// Stands up the AuthoritativeServer (the real engine server `--mcp-ws` runs) on a
// REAL localhost WebSocket listener and connects >= 2 REAL client connections
// over the wire (op_net_connect -> kernel loopback WS frames; clients have ZERO
// access to server memory). The two roles act in ONE authoritative world:
//   - client A = a human-driven builder (submits ecs.updateComponent intents),
//   - client B = an external MCP agent (player profile; subscribes + submits a
//     physics.applyImpulse intent).
//
// Asserts (M4 acceptance):
//   1. a mutation submitted by A appears in B's synced state (and B's impulse
//      appears in A's synced state -- both intent streams in one world);
//   2. the cross-client round-trip p95 is <= 50 ms localhost (MEASURED over many
//      round-trips, not estimated);
//   3. AUTHORITY: a direct state-write attempt is REJECTED (no set-state verb)
//      and the state is unchanged; a permission-lacking intent is rejected at
//      SkillRegistry.invoke; attribution is bound to the session, not the payload.
//   4. FALSIFIABILITY: with broadcast disabled the cross-visibility MUST fail.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import type { SkillCommand, WorldCommand } from "../src/worldlog/log.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient } from "../src/net/client.ts";
import type { NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p4_authoritative_sync: " + message);
}

const isSkill = (c: WorldCommand): c is SkillCommand => c.kind === "skill";

// A minimal Transformable: spawnRenderable only stores the object (render-sync,
// which we never run, would drive it), so empty setters suffice.
const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

function spawnDynamicBall(world: WorldContext, x: number, y: number, z: number): string {
  const bodyId = world.ops.op_physics_add_sphere(x, y, z, 0.5, 0.5, 0.2);
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid, bodyId });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

// ===========================================================================
// PHASE 0 -- stand up the authoritative server + two real client connections.
// ===========================================================================
const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;

let markerE = "";
let ballId = "";
const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p4_sync_server",
  seed: 0xa110ca7e,
  tickMs: 8,
  bootstrap: ({ world }) => {
    markerE = spawnMarker(world, 0, 0, 0); // body-less probe: only intents move it
    ballId = spawnDynamicBall(world, 0, 3, 0); // dynamic body the agent will impulse
  },
});
server.start();

const human = await NetClient.connect(net, url); // client A
const agent = await NetClient.connect(net, url); // client B
await human.initialize("human_A", "ses_human", "builder.readWrite");
await agent.initialize("agent_B", "ses_agent", "player.limited");
await human.subscribe();
await agent.subscribe();

// Both clients must have the world's join snapshot (AoI = full interest).
assert(human.state.has(markerE), "A did not receive the probe entity in its join snapshot");
assert(agent.state.has(markerE), "B did not receive the probe entity in its join snapshot");
assert(agent.state.has(ballId), "B did not receive the ball in its join snapshot");

// ===========================================================================
// PHASE 1 -- A mutates; B observes. Measure the cross-client round-trip p95.
// ===========================================================================
const ROUNDS = 200;
const latencies: number[] = [];
for (let k = 1; k <= ROUNDS; k++) {
  const value = 1000 + k; // unique, exactly f32-representable
  const t0 = Date.now();
  const observed = agent.waitForEntityValue(markerE, (s) => s.pos[0] === value, 3000);
  const applied = human.call("ecs.updateComponent", { entity: markerE, component: "position", value: [value, 0, 0] });
  await observed; // B has the mutation A submitted -> cross-client visibility
  latencies.push(Date.now() - t0);
  const resp = await applied;
  assert(resp.error === undefined, `A's intent #${k} was rejected: ${JSON.stringify(resp.error)}`);
}
const p50 = percentile(latencies, 0.5);
const p95 = percentile(latencies, 0.95);
const maxLat = Math.max(...latencies);
assert(p95 <= 50, `cross-client p95 ${p95}ms exceeds the 50ms localhost target`);

// ===========================================================================
// PHASE 2 -- B (the agent) submits an intent; A observes (both streams live).
// ===========================================================================
const ballBefore = agent.state.get(ballId);
assert(ballBefore !== undefined, "B lost the ball state");
const ballStartX = ballBefore.pos[0];
const aSawBall = human.waitForEntityValue(ballId, (s) => s.pos[0] > ballStartX + 0.01, 3000);
const impulse = await agent.call("physics.applyImpulse", { entity: ballId, impulse: [5, 0, 0] });
assert(impulse.error === undefined, `agent impulse intent failed: ${JSON.stringify(impulse.error)}`);
await aSawBall; // A observed the effect of B's authoritative intent

// ===========================================================================
// PHASE 3 -- AUTHORITY (structural + enforced).
// ===========================================================================
// (a) DIRECT STATE WRITE: there is no set-state verb. The attempt is rejected
//     (method-not-found) and authoritative state is unchanged.
const markerBefore = agent.state.get(markerE);
assert(markerBefore !== undefined, "B lost the probe state");
const beforeX = markerBefore.pos[0];
const directWrite = await human.rawRequest("state/set", { entity: markerE, pos: [99999, 0, 0] });
assert(directWrite.error !== undefined && directWrite.error.code === -32601,
  `direct state-write was not rejected as method-not-found: ${JSON.stringify(directWrite)}`);
await ops.op_sleep_ms(60); // give several ticks; no delta should carry 99999
const markerAfter = agent.state.get(markerE);
assert(markerAfter !== undefined && markerAfter.pos[0] === beforeX,
  `direct state-write mutated authoritative state (authority breached): ${markerAfter?.pos[0]} != ${beforeX}`);

// (b) PERMISSION AT INVOKE: the agent (player.limited, no ecs.modify) cannot run
//     a builder mutation. Rejected at SkillRegistry.invoke; state unchanged.
const forbidden = await agent.call("ecs.updateComponent", { entity: markerE, component: "position", value: [88888, 0, 0] });
assert(forbidden.error !== undefined && forbidden.error.code === -32001,
  `player.limited ecs write was not forbidden: ${JSON.stringify(forbidden)}`);
await ops.op_sleep_ms(60);
assert(agent.state.get(markerE)?.pos[0] !== 88888, "a forbidden intent still mutated authoritative state");

// (c) ATTRIBUTION SESSION-BOUND: a client spoofs a privileged identity in the
//     tools/call payload; the server IGNORES it and attributes to the session.
const spoof = await human.rawRequest("tools/call", {
  name: "ecs.updateComponent",
  arguments: { entity: markerE, component: "position", value: [1234, 0, 0] },
  context: { agentId: "root_admin", sessionId: "root", profile: "builder.readWrite" },
});
assert(spoof.error === undefined, `the legitimate (spoofed-context) intent should still apply: ${JSON.stringify(spoof.error)}`);
await agent.waitForEntityValue(markerE, (s) => s.pos[0] === 1234, 3000);
const ecsCmds = server.recorder.commands.filter(isSkill).filter((c) => c.tool === "ecs.updateComponent");
const humanEcs = ecsCmds.filter((c) => c.actorId === "human_A").length;
const agentEcs = ecsCmds.filter((c) => c.actorId === "agent_B").length;
// Every human intent -- INCLUDING the one carrying a spoofed payload context --
// is attributed to the human's bound session; the agent's (forbidden) attempt is
// attributed to the agent's session; the spoofed "root_admin" never appears.
assert(humanEcs === ROUNDS + 1, `expected ${ROUNDS + 1} ecs intents attributed to the human session, got ${humanEcs}`);
assert(agentEcs === 1, `expected the agent's single (forbidden) ecs intent attributed to its session, got ${agentEcs}`);
assert(ecsCmds.every((c) => c.actorId === "human_A" || c.actorId === "agent_B"),
  `attribution used an identity outside the bound sessions: ${JSON.stringify([...new Set(ecsCmds.map((c) => c.actorId))])}`);
assert(!server.recorder.commands.some((c) => isSkill(c) && c.actorId === "root_admin"),
  "a spoofed actorId entered the authoritative world log");

const appliedIntents = server.appliedIntents;
const loggedCommands = server.loggedCommands;
assert(appliedIntents >= ROUNDS, `world log recorded ${appliedIntents} applied intents, expected >= ${ROUNDS}`);

// ===========================================================================
// PHASE 4 -- FALSIFIABILITY: with broadcast DISABLED, B must NOT observe A.
// ===========================================================================
const listenerId2 = await net.op_net_listen(0);
const port2 = net.op_net_listener_port(listenerId2);
let markerE2 = "";
const noBroadcast = new AuthoritativeServer(listenerTransport(net, listenerId2), {
  sessionId: "p4_sync_nobroadcast",
  seed: 0xb22,
  tickMs: 8,
  broadcastEnabled: false, // the lever under test
  bootstrap: ({ world }) => {
    markerE2 = spawnMarker(world, 0, 0, 0);
  },
});
noBroadcast.start();
const humanF = await NetClient.connect(net, `ws://127.0.0.1:${port2}/`);
const agentF = await NetClient.connect(net, `ws://127.0.0.1:${port2}/`);
await humanF.initialize("human_F", "ses_hf", "builder.readWrite");
await agentF.initialize("agent_F", "ses_af", "player.limited");
await agentF.subscribe();
const updateF = await humanF.rawRequest("tools/call", {
  name: "ecs.updateComponent",
  arguments: { entity: markerE2, component: "position", value: [5555, 0, 0] },
});
assert(updateF.error === undefined, "control intent should still apply server-side");
let observedWithoutBroadcast = false;
try {
  await agentF.waitForEntityValue(markerE2, (s) => s.pos[0] === 5555, 400);
  observedWithoutBroadcast = true;
} catch {
  observedWithoutBroadcast = false; // timed out -> never synced (expected)
}
assert(!observedWithoutBroadcast,
  "FALSIFIABILITY FAILED: B observed A's mutation with broadcast disabled (the sync assertion is not load-bearing)");

// ---- teardown -------------------------------------------------------------
await humanF.close();
await agentF.close();
await noBroadcast.shutdown();
net.op_net_close_listener(listenerId2);

await human.close();
await agent.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log(
  `p4_authoritative_sync OK: 2 real WS clients in ONE authoritative world; ` +
    `A->B cross-mutation visible over ${ROUNDS} round-trips at p50=${p50}ms p95=${p95}ms max=${maxLat}ms (<=50ms); ` +
    `B->A impulse visible; authority enforced [direct-write -32601 + state unchanged, player.limited ecs.modify -32001, ` +
    `attribution session-bound (spoofed actorId absent from log)]; ${appliedIntents} intents applied / ${loggedCommands} world-log commands; ` +
    `falsified: broadcast-off => B did not observe the mutation`,
);
