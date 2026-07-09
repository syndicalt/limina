// Editor host — a gate-enabled authoritative MCP-ws server for the co-authoring
// editor. Launch it through a project's `npm run editor`; that launcher validates
// limina.project.json and supplies the canonical LIMINA_PROJECT_ID:
//
//     cd <limina-project> && npm run editor
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
import { AuthoritativeServer } from "../../js/src/net/server.ts";
import { reviewProfileGate } from "../../js/src/skills/approval.ts";
import type { NetOps } from "../../js/src/net/protocol.ts";
import { installCottageScenario } from "../../js/src/demos/coordinator_cottage.ts";
import { registerWorldlogSkills } from "../../js/src/skills/worldlog.ts";
import { registerAssetCatalogSkills } from "../../js/src/skills/asset-catalog.ts";
import { acquireKernel, type LockIO } from "../../js/src/kernel/daemon-lock.ts";
import { resolveProfile } from "../../js/src/skills/permissions.ts";
import { AnthropicProvider } from "../../js/src/agents/llm.ts";
import { runChatTurn, type ChatTurnPersistRecord } from "../../js/src/agents/chat-turn.ts";
import type { ProviderMap } from "../../js/src/agents/systems.ts";

const net = ops as unknown as NetOps;
const PORT = Number(ops.op_read_env("LIMINA_EDITOR_PORT")) || 8787;
const STATIC_PORT = Number(ops.op_read_env("LIMINA_EDITOR_STATIC_PORT")) || 5173;
const PROJECT_ID = ops.op_read_env("LIMINA_PROJECT_ID");
if (PROJECT_ID.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(PROJECT_ID)) {
  throw new Error("editor_host: LIMINA_PROJECT_ID must be the canonical 1-64 character project id from limina.project.json");
}
const WORLDLOG_NAME = ops.op_read_env("LIMINA_EDITOR_WORLDLOG") || "editor_host_worldlog.jsonl";
const TRACE_NAME = ops.op_read_env("LIMINA_EDITOR_TRACE") || "editor_host_trace.jsonl";
const CHAT_NAME = ops.op_read_env("LIMINA_EDITOR_CHAT") || "editor_host_chat.jsonl";
const EDITOR_AUTH_TOKEN = ops.op_read_env("LIMINA_EDITOR_TOKEN") || ops.op_sha256(`editor:${Date.now()}:${Math.random()}`).slice(0, 32);
const EDITOR_ALLOWED_PROFILES = new Set([
  "reviewer",
  "system.readonly",
  "system.admin",
  "reviewer.coordinator",
  "builder.review",
  "builder.readWrite",
]);
const EDITOR_ALLOWED_ORIGINS = [
  `http://localhost:${STATIC_PORT}`,
  `http://127.0.0.1:${STATIC_PORT}`,
];
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ALLOWED_ANTHROPIC_MODELS = new Set([
  DEFAULT_ANTHROPIC_MODEL,
  "claude-sonnet-5",
  "claude-opus-4-8",
]);

function resolveAnthropicModel(requested: unknown): string {
  if (typeof requested === "string" && ALLOWED_ANTHROPIC_MODELS.has(requested)) {
    return requested;
  }
  const configured = ops.op_read_env("ANTHROPIC_MODEL");
  return ALLOWED_ANTHROPIC_MODELS.has(configured) ? configured : DEFAULT_ANTHROPIC_MODEL;
}

function buildProviders(model: string, apiKey: string): ProviderMap {
  return { anthropic: new AnthropicProvider(model, apiKey) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function persistChat(record: ChatTurnPersistRecord): void {
  ops.op_append_trace(CHAT_NAME, JSON.stringify(record) + "\n");
}

// KERNEL K3 -- daemon reuse. The project's kernel port IS the liveness lock: the
// first surface to bind it OWNS the kernel and records its port + capability token
// in a per-project lock file; a concurrent second surface (another `npm run editor`,
// the CLI, a board) cannot bind, so it ATTACHES to the running kernel instead of
// spawning a second authoritative server on a second workspace (the "new workspace
// every time" pain). K2 already made a serial RESTART resume the same durable log.
const KERNEL_LOCK_FILE = ops.op_read_env("LIMINA_EDITOR_KERNEL_LOCK") || "editor_host_kernel.lock.json";
const kernelLock: LockIO = {
  read: () => { try { const t = net.op_read_trace(KERNEL_LOCK_FILE); return t.length > 0 ? t : null; } catch { return null; } },
  write: (text) => net.op_write_trace(KERNEL_LOCK_FILE, text),
};
const acq = await acquireKernel({
  port: PORT,
  token: EDITOR_AUTH_TOKEN,
  worldlog: WORLDLOG_NAME,
  lock: kernelLock,
  listen: (p) => net.op_net_listen(p),
});
if (acq.role === "attached") {
  // A kernel is already live for this project. Point the surface at it and exit
  // (the module falls through with no keep-alive) -- do NOT double-spawn.
  ops.op_log(
    `editor_host: a kernel is ALREADY running for this project on ws://localhost:${acq.record.port}/ -- ` +
      `attach your surface there (token ${acq.record.token}). Not spawning a second server or workspace.`,
  );
} else {
  if (acq.reclaimedStaleLock) {
    ops.op_log("editor_host: reclaimed a stale kernel lock (a prior daemon exited without releasing the port).");
  }
const listenerId = acq.handle as number;
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
  trace: { name: TRACE_NAME, maxInMemory: 8192 },
  // compactFlushed:false — the live viewport re-authors the FULL recorded stream via worldlog.tail,
  // which reads in-memory recorder.commands; compaction would drop flushed authoring commands out of
  // memory and the viewport would render an empty/partial world. A dev-editor session keeps the whole
  // stream resident (bounded by session length, not a concern here).
  worldLog: { name: WORLDLOG_NAME, compactFlushed: false },
  authoring: { projectId: PROJECT_ID },
  initializeAuthToken: EDITOR_AUTH_TOKEN,
  allowedProfiles: EDITOR_ALLOWED_PROFILES,
  onClientMessage: async (method, params, ctx) => {
    if (method !== "chat/send") return false;
    if (ctx.session === undefined) {
      await ctx.error("chat/send requires an initialized session");
      return true;
    }
    const p = asRecord(params);
    if (p === undefined || typeof p.turnId !== "string" || typeof p.text !== "string") {
      await ctx.error("chat/send requires { turnId, text, attachments? }");
      return true;
    }

    const key = ops.op_read_env("ANTHROPIC_API_KEY");
    if (key.length === 0) {
      const message = "ANTHROPIC_API_KEY not set (add it to the project .env / environment; also allowlist api.anthropic.com via LIMINA_HTTP_POST_ALLOW)";
      await ctx.push("chat/error", { type: "chat.error", turnId: p.turnId, message });
      await ctx.reply({ ok: false, error: message });
      return true;
    }

    const model = resolveAnthropicModel(p.model);
    await ctx.reply({ ok: true, turnId: p.turnId });
    // Wire shape: JSON-RPC notification method is chat/<event>, params is the
    // full self-describing { type:"chat.<event>", turnId, ... } object.
    void runChatTurn({
      registry: server.registry,
      world: server.world,
      providers: buildProviders(model, key),
      tracer: server.registry.tracer,
      msg: { turnId: p.turnId, text: p.text, attachments: p.attachments },
      invokeTool: (name, input, base) => {
        const argumentsRecord = asRecord(input);
        if (argumentsRecord === undefined) {
          return Promise.resolve({ success: false, error: { code: "invalid_input", message: "tool input must be an object" } });
        }
        return server.invokeAuthoritatively(name, argumentsRecord, {
          agentId: base.agentId,
          sessionId: base.sessionId,
          permissions: base.permissions,
          profile: base.profile,
          causedBy: base.causedBy,
        });
      },
      push: (m) => ctx.push(`chat/${m.type.split(".")[1]}`, m),
      persist: persistChat,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      void ctx.push("chat/error", { type: "chat.error", turnId: p.turnId, message });
    });
    return true;
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
registerWorldlogSkills(server.registry, {
  recorder: server.recorder,
  visibleCount: () => server.publishedWorldlogCommands,
});

// The asset catalog: asset.catalog (browse, read-only) + catalog.publish (record a newly
// authored/QC'd entry). Same recorded-state pattern as the terrain/asset skills above — a session
// keeps its own live catalog Map, and a worldlog replay reconstructs it by re-invoking the recorded
// catalog.publish commands.
registerAssetCatalogSkills(server.registry);

server.start();
await server.ready;

// A fresh (un-rehydrated) world boots EMPTY. The old demo starter scene (ground slab, crate,
// barrel, colored boxes) predates the map-driven build pipeline — a real world now arrives via
// tools/design/build-world.mjs (or any builder client), and demo blocks only polluted it.

ops.op_log(
  `editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:${port}/ ` +
    `(allowed browser origins: ${EDITOR_ALLOWED_ORIGINS.join(", ")}; native clients without Origin still require token). ` +
    `(profiles: reviewer = the editor, builder.review = a proposing agent, ` +
    `reviewer.coordinator = the cottage coordinator -> tools/call coordinator.build). ` +
    `Paste token ${EDITOR_AUTH_TOKEN} into editor/index.html.`,
);

// Keep the process alive; the accept + tick loops run in the background.
await new Promise<void>(() => {});
} // end: we own the kernel (acq.role === "spawned")
