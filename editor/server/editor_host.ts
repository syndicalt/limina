// Editor host — a gate-enabled authoritative MCP-ws server for the co-authoring
// editor. Run it with the limina binary, then open editor/index.html:
//
//     ./target/release/limina editor/server/editor_host.ts
//
// It stands up the SAME AuthoritativeServer the stock `--mcp-ws` runtime runs
// (real WebSocket, fixed-step sim, M1 world log, AoI state sync), but with the
// Phase 7 human-in-the-loop REVIEW GATE installed: any client running the
// `builder.review` profile has its MUTATING world-edits HELD pending a reviewer's
// approval. The editor connects as the `reviewer`. This is the exact server
// configuration js/test/p7_editor_contract.ts verifies in-process.
//
// Unlike `--mcp-ws` (which uses the host's listener), this binds its OWN loopback
// port (default 8787) via op_net_listen, so it runs as a plain script.

import { ops } from "../../js/src/engine.ts";
import { spawnRenderable } from "../../js/src/ecs/world.ts";
import { AuthoritativeServer, listenerTransport } from "../../js/src/net/server.ts";
import { reviewProfileGate } from "../../js/src/skills/approval.ts";
import type { WorldContext } from "../../js/src/skills/registry.ts";
import type { NetOps } from "../../js/src/net/protocol.ts";
import { installCottageScenario } from "../../js/src/demos/coordinator_cottage.ts";

const net = ops as unknown as NetOps;
const PORT = 8787;

// A minimal Transformable for headless spawns (no render-sync runs here).
const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
function spawnTagged(world: WorldContext, x: number, y: number, z: number, tags: string[]): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  const id = world.entities.create({ eid });
  if (tags.length > 0) world.tags.set(eid, new Set(tags));
  return id;
}

const listenerId = await net.op_net_listen(PORT);
const port = net.op_net_listener_port(listenerId);

const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "editor_host",
  seed: 0xed170,
  tickMs: 16,
  bootstrap: ({ world }) => {
    // A small starting world so the editor's World panel has content to render.
    spawnTagged(world, 0, 0, 0, ["ground", "spawn"]);
    spawnTagged(world, 3, 0, 0, ["prop", "crate"]);
    spawnTagged(world, -3, 0, 2, ["prop", "barrel"]);
  },
});
// Install the human-in-the-loop review gate: builder.review clients PROPOSE,
// the reviewer (the editor) approves. Reads + approval.* are never gated.
server.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));

// "Cottage on the beach" coordinator showcase: wire the `delegate` skill + the
// `coordinator.build` trigger onto this authoritative server. installCottageScenario
// COMPOSES its delegate-worker review gate with the builder.review gate above (it
// uses addApprovalGate, not setApprovalGate), so both stay active. A client that
// connects as `reviewer.coordinator` (holds `orchestrate` + `approval.review`) can
// call coordinator.build to delegate the three workers, then list/grant/deny their
// HELD edits via the approval.* skills. The stock builder.review flow is untouched.
installCottageScenario(server.registry, { world: server.world });

server.start();

ops.op_log(
  `editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:${port}/ ` +
    `(profiles: reviewer = the editor, builder.review = a proposing agent, ` +
    `reviewer.coordinator = the cottage coordinator -> tools/call coordinator.build). Open editor/index.html.`,
);

// Keep the process alive; the accept + tick loops run in the background.
await new Promise<void>(() => {});
