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
import { derivedRuntimeDiscovery, registerDerivedRuntimeDiscoverySkill } from "../../js/src/skills/derived-runtime-discovery.ts";
import { compileAtlasMapDoc } from "../../js/src/world/design-map-compile.mjs";
import { terrainEditBaseTopologyForWorldMap } from "../../js/src/terrain/edit-topology.mjs";
import { parseTerrainEditLayer } from "../../js/src/terrain/edit-layer.mjs";
import { parseTerrainPaintLayer } from "../../js/src/terrain/paint-layer.mjs";
import { AnthropicProvider } from "../../js/src/agents/llm.ts";
import { runChatTurn, type ChatTurnPersistRecord } from "../../js/src/agents/chat-turn.ts";
import { ChatAdmissionGate } from "../../js/src/agents/chat-admission.ts";
import type { ProviderMap } from "../../js/src/agents/systems.ts";

const net = ops as unknown as NetOps;
const PORT = Number(ops.op_read_env("LIMINA_EDITOR_PORT")) || 8787;
const STATIC_PORT = Number(ops.op_read_env("LIMINA_EDITOR_STATIC_PORT")) || 5173;
const PROJECT_ID = ops.op_read_env("LIMINA_PROJECT_ID");
if (PROJECT_ID.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(PROJECT_ID)) {
  throw new Error("editor_host: LIMINA_PROJECT_ID must be the canonical 1-64 character project id from limina.project.json");
}
const DERIVED_RUNTIME_DISCOVERY = derivedRuntimeDiscovery({
  baseUrl: ops.op_read_env("LIMINA_DERIVED_RUNTIME_BASE_URL"),
  token: ops.op_read_env("LIMINA_DERIVED_RUNTIME_TOKEN"),
  projectId: PROJECT_ID,
  branchId: ops.op_read_env("LIMINA_DERIVED_RUNTIME_BRANCH_ID"),
});
const WORLDLOG_NAME = ops.op_read_env("LIMINA_EDITOR_WORLDLOG") || "editor_host_worldlog.jsonl";
const TRACE_NAME = ops.op_read_env("LIMINA_EDITOR_TRACE") || "editor_host_trace.jsonl";
const CHAT_NAME = ops.op_read_env("LIMINA_EDITOR_CHAT") || "editor_host_chat.jsonl";
// The Node launcher owns OS-random capability generation and its private 0600
// handoff. This host fails closed instead of manufacturing a weaker V8 fallback.
const EDITOR_AUTH_TOKEN = ops.op_read_env("LIMINA_EDITOR_TOKEN");
if (!/^[A-Za-z0-9_-]{32,128}$/.test(EDITOR_AUTH_TOKEN)) {
  throw new Error("editor_host: LIMINA_EDITOR_TOKEN must be supplied by the editor launcher as a 32-128 character URL-safe capability");
}
const EDITOR_ALLOWED_PROFILES = new Set([
  "reviewer",
  "system.readonly",
  "system.admin",
  "system.derived-build",
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

const chatAdmission = new ChatAdmissionGate();

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
      "use the launcher's private capability handoff to attach. Not spawning a second server or workspace.",
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

// D5.1: project asset ids are project-root-relative (`<assetRootName>/...`); the
// sandboxed asset op wants the path beneath the configured asset root.
function projectAssetRel(assetId: string): string {
  const slash = assetId.indexOf("/");
  if (slash <= 0) throw new Error(`editor_host: project asset id '${assetId}' has no asset-root prefix`);
  return assetId.slice(slash + 1);
}

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
  authoring: {
    projectId: PROJECT_ID,
    // D5.1 derived-terrain sculpting: resolve the edit-layer lattice from the
    // authoritative MapDoc through the SAME map→topology derivation the derived
    // compiler uses (edit-topology.mjs), so a stroke binds to the field it sees.
    derivedTerrainTopology: (() => {
      // Pure memo keyed by content hash: boot rehydrate replays every recorded stroke
      // through this resolver, and the map→topology derivation is a pure function of
      // the pinned MapDoc bytes. Replay itself never calls it (commands pin the
      // topology via commitFields), so the cache can never diverge from the log.
      const cache = new Map<string, unknown>();
      return (mapDocRef: { assetId: string; hash: string }) => {
        const hit = cache.get(mapDocRef.hash);
        if (hit !== undefined) return hit;
        const text = new TextDecoder().decode(ops.op_read_asset(projectAssetRel(mapDocRef.assetId)));
        if (`sha256:${ops.op_sha256(text)}` !== mapDocRef.hash) {
          throw new Error(`editor_host: MapDoc '${mapDocRef.assetId}' bytes do not match the authoritative ref hash`);
        }
        const compiled = compileAtlasMapDoc({ mapsJsonText: text }) as { worldMap: unknown };
        const topology = terrainEditBaseTopologyForWorldMap(compiled.worldMap, { gridId: `${PROJECT_ID}.surface` });
        cache.set(mapDocRef.hash, topology);
        return topology;
      };
    })(),
    readTerrainEditLayer: (ref) => {
      const text = new TextDecoder().decode(ops.op_read_asset(projectAssetRel(ref.assetId)));
      const layer = parseTerrainEditLayer(JSON.parse(text));
      if (layer.contentHash !== ref.hash) {
        throw new Error(`editor_host: terrain edit layer '${ref.assetId}' content hash does not match the authoritative ref`);
      }
      return layer;
    },
    // D5.3: fs fallback for derived paint layers (same contract as the height reader).
    readTerrainPaintLayer: (ref) => {
      const text = new TextDecoder().decode(ops.op_read_asset(projectAssetRel(ref.assetId)));
      const layer = parseTerrainPaintLayer(JSON.parse(text));
      if (layer.contentHash !== ref.hash) {
        throw new Error(`editor_host: terrain paint layer '${ref.assetId}' content hash does not match the authoritative ref`);
      }
      return layer;
    },
    // D5.4: hash-checked MapDoc bytes for the composed-height sampler (mirrors the
    // read+verify in derivedTerrainTopology above). Arming this plus the topology
    // resolver switches on derived smooth/flatten and derived vegetation.scatter.
    readMapDoc: (ref) => {
      const text = new TextDecoder().decode(ops.op_read_asset(projectAssetRel(ref.assetId)));
      if (`sha256:${ops.op_sha256(text)}` !== ref.hash) {
        throw new Error(`editor_host: MapDoc '${ref.assetId}' bytes do not match the authoritative ref hash`);
      }
      return text;
    },
  },
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

    const admission = chatAdmission.acquire(ctx.session.sessionId, p.text);
    if (!admission.ok) {
      await ctx.push("chat/error", {
        type: "chat.error",
        turnId: p.turnId,
        message: admission.message,
        code: admission.code,
        retryAfterMs: admission.retryAfterMs,
      });
      await ctx.reply({ ok: false, error: admission.message, code: admission.code, retryAfterMs: admission.retryAfterMs });
      return true;
    }

    let model: string;
    try {
      model = resolveAnthropicModel(p.model);
      await ctx.reply({ ok: true, turnId: p.turnId });
    } catch (error) {
      admission.release();
      throw error;
    }
    // Wire shape: JSON-RPC notification method is chat/<event>, params is the
    // full self-describing { type:"chat.<event>", turnId, ... } object.
    void runChatTurn({
      registry: server.registry,
      world: server.world,
      providers: buildProviders(model, key),
      tracer: server.registry.tracer,
      msg: {
        turnId: p.turnId,
        text: p.text,
        attachments: p.attachments,
        // The context pack is bounded by the packer's own caps; this is the
        // outer fence so a broken adapter can never blow up a turn.
        context: typeof p.context === "string" ? p.context.slice(0, 8192) : undefined,
      },
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
    }).finally(() => {
      admission.release();
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
  // Editor session FAST-BOOT: worldlog.snapshotBoot serves a v3 snapshot + resume
  // cursor so a long session's viewport boots by snapshot restore + bounded tail
  // instead of re-authoring the whole recorded stream (the 7k-command boot hang).
  // Ineligible sessions (state a snapshot cannot carry) answer eligible:false and
  // the viewport keeps the full-replay path.
  snapshotBoot: { participants: server.core.snapshotParticipants },
});

// The asset catalog: asset.catalog (browse, read-only) + catalog.publish (record a newly
// authored/QC'd entry). Same recorded-state pattern as the terrain/asset skills above — a session
// keeps its own live catalog Map, and a worldlog replay reconstructs it by re-invoking the recorded
// catalog.publish commands.
registerAssetCatalogSkills(server.registry);

// The browser receives the short-lived derived-runtime bearer capability only
// through this authenticated, profile-bound read. Read effects are excluded from
// the world log, and SkillRegistry traces inputs rather than handler results, so
// the token is never persisted in authoring or observability payloads.
registerDerivedRuntimeDiscoverySkill(server.registry, DERIVED_RUNTIME_DISCOVERY);

server.start();
await server.ready;

// A fresh (un-rehydrated) world boots EMPTY. The old demo starter scene (ground slab, crate,
// barrel, colored boxes) predates the map-driven build pipeline — a real world now arrives via
// tools/design/build-world.mjs (or any builder client), and demo blocks only polluted it.

ops.op_log(
  `editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:${port}/ ` +
    `(allowed browser origins: ${EDITOR_ALLOWED_ORIGINS.join(", ")}; native clients without Origin still require token). ` +
    `(profiles: reviewer = the editor, builder.review = a proposing agent, ` +
    "reviewer.coordinator = the cottage coordinator -> tools/call coordinator.build). " +
    "Capability available through the launcher's private handoff.",
);

// Keep the process alive; the accept + tick loops run in the background.
await new Promise<void>(() => {});
} // end: we own the kernel (acq.role === "spawned")
