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
//
// LIVE VIEWPORT (Phase 8 Mode B): the editor's <canvas id="editor-viewport"> runs
// `runLive` (editor/src/viewport.js → editor/vendor/limina-runtime.js), which spins
// up a sim-worker + a SharedArrayBuffer transform bridge. SAB requires CROSS-ORIGIN
// ISOLATION, so the editor's static files must be served with
//     Cross-Origin-Opener-Policy:   same-origin
//     Cross-Origin-Embedder-Policy: require-corp
// Serve them with the on-ramp static server (it already sends both headers):
//     node tools/scaffold/scripts/serve.mjs editor 5173   →  http://localhost:5173/
// Opening editor/index.html over file:// works for the MCP panels but NOT the live
// viewport (file origins are never cross-origin isolated → runLive shows a poster).
// Build the viewport bundles first:  (cd js && npm run bundle:editor).

import { ops } from "../../js/src/engine.ts";
import { spawnRenderable } from "../../js/src/ecs/world.ts";
import { AuthoritativeServer } from "../../js/src/net/server.ts";
import { reviewProfileGate } from "../../js/src/skills/approval.ts";
import type { WorldContext } from "../../js/src/skills/registry.ts";
import type { NetOps } from "../../js/src/net/protocol.ts";
import { installCottageScenario } from "../../js/src/demos/coordinator_cottage.ts";
import { registerWorldlogSkills } from "../../js/src/skills/worldlog.ts";
import { resolveProfile } from "../../js/src/skills/permissions.ts";

const net = ops as unknown as NetOps;
const PORT = 8787;
const EDITOR_AUTH_TOKEN = ops.op_sha256(`editor:${Date.now()}:${Math.random()}`).slice(0, 32);
const EDITOR_ALLOWED_PROFILES = new Set(["reviewer", "system.readonly", "reviewer.coordinator", "builder.review", "builder.readWrite"]);
const EDITOR_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

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
const editorTransport = {
  accept: () => net.op_net_accept_allowed_origins(listenerId, JSON.stringify(EDITOR_ALLOWED_ORIGINS)),
  recv: (id: number) => net.op_net_recv(id),
  send: (id: number, line: string) => net.op_net_send(id, line),
  close: (id: number) => net.op_net_close(id),
};

const server = new AuthoritativeServer(editorTransport, {
  sessionId: "editor_host",
  seed: 0xed170,
  tickMs: 16,
  trace: { name: "editor_host_trace.jsonl", maxInMemory: 8192 },
  // compactFlushed:false — the live viewport re-authors the FULL recorded stream via worldlog.tail,
  // which reads in-memory recorder.commands; compaction would drop flushed authoring commands out of
  // memory and the viewport would render an empty/partial world. A dev-editor session keeps the whole
  // stream resident (bounded by session length, not a concern here).
  worldLog: { name: "editor_host_worldlog.jsonl", compactFlushed: false },
  initializeAuthToken: EDITOR_AUTH_TOKEN,
  allowedProfiles: EDITOR_ALLOWED_PROFILES,
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

// Expose the recorded AUTHORING command stream so the live viewport (editor/src/viewport.js) can
// re-author it and render the world as it is built. Read-only; filters to mutating commands.
registerWorldlogSkills(server.registry, { recorder: server.recorder });

server.start();

// Author a small starting scene THROUGH the recorded registry (not the un-recorded bootstrap spawns
// above), so worldlog.tail carries real geometry the moment the viewport connects — and any further
// authoring (an approved edit, a builder client, a coordinator worker) appends to the same stream.
const seedBase = {
  agentId: "editor_host", sessionId: "editor_host",
  permissions: resolveProfile("builder.readWrite"), tick: 0, world: server.world,
};
for (const box of [
  { position: [0, 1, 0], color: 0x4ade80 },
  { position: [3, 1, 0], color: 0x60a5fa },
  { position: [-3, 1, 2], color: 0xf472b6 },
  { position: [0, 1, -4], color: 0xfacc15 },
]) {
  const res = await server.registry.invoke("scene.createEntity", { shape: "box", size: 1, position: box.position, color: box.color }, seedBase);
  if (!res.success) ops.op_log(`editor_host: starting-scene authoring failed: ${JSON.stringify(res.error)}`);
}

ops.op_log(
  `editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:${port}/ ` +
    `(allowed browser origins: ${EDITOR_ALLOWED_ORIGINS.join(", ")}; native clients without Origin still require token). ` +
    `(profiles: reviewer = the editor, builder.review = a proposing agent, ` +
    `reviewer.coordinator = the cottage coordinator -> tools/call coordinator.build). ` +
    `Paste token ${EDITOR_AUTH_TOKEN} into editor/index.html.`,
);

// Keep the process alive; the accept + tick loops run in the background.
await new Promise<void>(() => {});
