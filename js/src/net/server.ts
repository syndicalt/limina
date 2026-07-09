// limina AUTHORITATIVE SERVER (Phase 4 M4/M5) -- the real engine version of the
// model validated by the P4.0c spike (spikes/netcode/REPORT.md):
// authoritative server + clients-as-views + state deltas (NOT lockstep).
//
// The server OWNS the fixed-step sim and the M1 world log. It fans out to MANY
// clients over the real WebSocket transport (per-connection read loop + a
// broadcast of the per-tick delta). Clients submit INTENTS (tools/call); the
// server permission-checks each at SkillRegistry.invoke, applies it at the NEXT
// tick boundary in ONE total order (so the timeline stays an M1 log), records it,
// and broadcasts the authoritative state delta (the entities that changed this
// tick) to every SUBSCRIBED client, filtered by that client's area-of-interest
// (M5). A new client gets a SNAPSHOT on subscribe (reused M2 capture) then deltas.
//
// Authority is structural: the only mutation verb is tools/call; there is no
// set-state verb; attribution is bound at initialize, never from the payload.

import { EntityTable, type EngineOps, ops as defaultOps } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { SkillRegistry, skillEffect, type WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { PolicyEngine, policyEventType, policyEventPayload } from "../policy/engine.ts";
import { WorldRecorder } from "../worldlog/recorder.ts";
import { DurableWorldLog } from "../worldlog/durable.ts";
import { createDesignArtifactStore } from "../world/design-artifacts.ts";
import { captureWorldSnapshot } from "../worldlog/snapshot.ts";
import {
  captureWorldState,
  parseWorldLog,
  PHYSICS_OP_FN,
  PHYSICS_OP_OUT_BUFFER,
  syncAllBodies,
  type EntityState,
  type WorldCommand,
} from "../worldlog/log.ts";
import { JSON_RPC_ERRORS, mcpErrorToJsonRpc, type MCPResponse } from "../mcp/protocol.ts";
import { inAoi, parseAoi, SYNC_METHODS, WORLDLOG_METHODS, type AreaOfInterest, type NetOps } from "./protocol.ts";
import { worldlogTail } from "../skills/worldlog.ts";
import { assertReplayable } from "../worldlog/verify.ts";
import { StaticAuthoringAdapterAllowlist } from "../authoring/adapter.ts";
import { SceneAuthoringAdapter } from "../authoring/adapters/scene.ts";
import { registerAuthoringSkills, type AuthoringSkillRuntime } from "../authoring/skills.ts";

/** op_net_accept returns this when its listener is closed (Rust u32::MAX). */
export const ACCEPT_CLOSED = 0xffffffff;

/** How many WebSocket handshakes may be in flight at once. Each transport.accept()
 *  awaits a full per-connection handshake, so this is the number of stalled/half-open
 *  peers the accept path tolerates before a legitimate new client has to wait. */
const ACCEPT_CONCURRENCY = 16;
const MAX_WIRE_MESSAGE_CHARS = 1_048_576;
const MAX_QUEUED_INTENTS = 4096;
const MAX_QUEUED_INTENTS_PER_CONNECTION = 256;
const MAX_INTENTS_PER_TICK = 256;

/** The socket primitives the server drives. ws_runtime supplies `accept` over the
 *  host listener; a headless test supplies it over a self-bound listener. */
export interface NetServerTransport {
  accept(): Promise<number>;
  recv(connId: number): Promise<string>;
  send(connId: number, line: string): Promise<void>;
  close(connId: number): Promise<void>;
}

export interface ServerBootstrap {
  world: WorldContext;
  recordedOps: EngineOps;
  registry: SkillRegistry;
}

export interface AuthoritativeServerOptions {
  sessionId: string;
  /** Deterministic RNG seed (installed as Math.random; recorded first). */
  seed?: number;
  /** Fixed-step period in ms. 8 ms (125 Hz) leaves ample headroom under the
   *  M4 p95 <= 50 ms localhost target (latency is tick-quantization dominated). */
  tickMs?: number;
  ops?: EngineOps;
  /** Scene/world bootstrap run once before the tick loop (create entities, etc.).
   *  Receives the RECORDED ops so bootstrap mutations land in the world log. */
  bootstrap?: (boot: ServerBootstrap) => void;
  /** Falsifiability lever: when false, the server applies + records intents but
   *  NEVER broadcasts deltas, so cross-client visibility MUST fail. Default true. */
  broadcastEnabled?: boolean;
  /** The dynamic policy engine (M7). When provided, session admission (initialize)
   *  is policy-checked and every intent crossing is governed at SkillRegistry.invoke;
   *  when omitted, the legacy static-profile admission + permission check apply. */
  policy?: PolicyEngine;
  /** Optional shared secret required on initialize as params.authToken. This is
   *  for browser-facing localhost authoring servers: without it, any webpage can
   *  attempt a cross-site WebSocket connection to ws://localhost and choose a
   *  privileged profile. */
  initializeAuthToken?: string;
  /** Optional profile allowlist for this listener. Use this to keep editor
   *  hosts from accepting broad production profiles such as builder.readWrite. */
  allowedProfiles?: ReadonlySet<string>;
  /** Append-backed audit trace for long-lived servers. When omitted, the server
   *  keeps the historical in-memory tracer semantics used by tests/one-shot runs. */
  trace?: {
    name: string;
    maxInMemory?: number;
    recoverPartialFinalLine?: boolean;
  };
  /** Optional append-backed authoritative world log for long-lived servers. */
  worldLog?: {
    name: string;
    compactFlushed?: boolean;
  };
  /** Enable the atomic WorldProject transaction surface. Authoring requires a
   * durable WorldLog because its replay envelope has no second persistence path. */
  authoring?: {
    projectId: string;
  };
  /** Record every per-tick `step` command even when the tick provably changed nothing.
   *  Default FALSE (kernel K-compaction): idle steps are still APPLIED every tick, but only
   *  steps that moved a dynamic body (plus a short post-activity grace window) are RECORDED.
   *  Without the cut a long-lived session's log is ~99.98% idle step records and boot rehydrate
   *  replays them all, so boot cost grows with session time. See worldlog/step-filter.ts for the
   *  replay-correctness argument. Set true only to reproduce the legacy record-every-step logs. */
  recordIdleSteps?: boolean;
  /** Optional host hook for application-specific JSON-RPC methods. Server core
   *  remains generic: known protocol methods are handled above; unknown methods
   *  reach this hook and fall back to method-not-found when unhandled. */
  onClientMessage?: (
    method: string,
    params: unknown,
    ctx: {
      session: ClientSession | undefined;
      connId: number;
      reply(result: unknown): Promise<void>;
      push(method: string, params: unknown): Promise<void>;
      error(message: string): Promise<void>;
    },
  ) => boolean | Promise<boolean>;
}

interface ClientSession {
  agentId: string;
  sessionId: string;
  profile: string;
  permissions: ReadonlySet<string>;
}

/** Identity and provenance for a trusted in-process caller such as the editor's
 * chat coordinator. This API does not weaken permission or policy checks. */
export interface AuthoritativeInvocationContext {
  agentId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  profile?: string;
  causedBy?: readonly string[];
}

interface ClientConn {
  connId: number;
  session?: ClientSession;
  subscribed: boolean;
  aoi?: AreaOfInterest;
  closing: boolean;
  queuedIntents: number;
  /** K4: set once this connection calls worldlog/subscribe; the cursor advances on every
   *  worldlog/append push. undefined => not subscribed to the authoring-stream push (no listener
   *  work is done for it in pushWorldlogAppends). */
  worldlogCursor?: number;
}

interface QueuedIntent {
  connId?: number;
  reqId?: string | number | null;
  name: string;
  input: Record<string, unknown>;
  session: AuthoritativeInvocationContext;
  resolve?: (response: MCPResponse) => void;
}

interface TickDispatch {
  sends: Promise<void>[];
  completions: Array<{ resolve: (response: MCPResponse) => void; response: MCPResponse }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function sameState(a: EntityState, b: EntityState): boolean {
  for (let i = 0; i < 3; i++) if (a.pos[i] !== b.pos[i] || a.scale[i] !== b.scale[i]) return false;
  for (let i = 0; i < 4; i++) if (a.rot[i] !== b.rot[i]) return false;
  const ab = a.body;
  const bb = b.body;
  if (ab === undefined && bb === undefined) return true;
  if (ab === undefined || bb === undefined) return false;
  for (let i = 0; i < 7; i++) if (ab[i] !== bb[i]) return false;
  return true;
}

export class AuthoritativeServer {
  readonly world: WorldContext;
  readonly registry: SkillRegistry;
  readonly recorder: WorldRecorder;
  private readonly durableLog?: DurableWorldLog;
  private durableLogClosed = false;
  private durableWorldlogPushPending = false;
  /** First persistence failure. Once set, no further authoritative mutation is
   * accepted or simulated; continuing would extend memory beyond the recoverable
   * durable prefix. Recovery requires a server restart from that prefix. */
  private durableLogFailure?: Error;
  /** A poisoned transaction kernel means rollback could not restore the live
   * world. The process must expose neither that world nor its dirty log suffix. */
  private authorityIntegrityFailure?: Error;
  private readonly recOps: EngineOps;
  private readonly transport: NetServerTransport;
  private readonly tickMs: number;
  private readonly sessionId: string;
  private broadcastEnabled: boolean;
  private readonly tracer: LiminaTracer;
  /** The dynamic policy engine (M7); undefined => legacy static-profile admission. */
  private readonly policy?: PolicyEngine;
  private readonly initializeAuthToken?: string;
  private readonly allowedProfiles?: ReadonlySet<string>;
  private readonly onClientMessage?: AuthoritativeServerOptions["onClientMessage"];
  readonly authoring?: AuthoringSkillRuntime;

  private readonly conns = new Map<number, ClientConn>();
  private intentQueue: QueuedIntent[] = [];
  private prev = new Map<string, EntityState>();
  private tick = 0;
  private intentSeq = 0;
  private running = false;
  private bgLoops: Promise<void>[] = [];
  private acceptLoopP?: Promise<void>;
  /** FIFO promise mutex for world reads and authoritative mutation batches.
   * Network sends are started inside the ordering boundary but awaited outside. */
  private authorityTail: Promise<void> = Promise.resolve();
  private standaloneDrainScheduled = false;

  /** Tick at which the last broadcast happened (for tests). */
  lastBroadcastTick = 0;
  /** Resolves after any durable boot rehydrate has fully replayed. */
  readonly ready: Promise<void>;
  /** True when this server found a non-empty durable world log at boot. */
  readonly rehydrated: boolean;
  /** Number of commands parsed from the durable world log at boot. */
  readonly rehydratedCommands: number;

  constructor(transport: NetServerTransport, opts: AuthoritativeServerOptions) {
    this.transport = transport;
    this.tickMs = opts.tickMs ?? 8;
    this.sessionId = opts.sessionId;
    this.broadcastEnabled = opts.broadcastEnabled ?? true;
    const baseOps = opts.ops ?? defaultOps;
    if (opts.authoring !== undefined && opts.worldLog === undefined) {
      throw new Error("AuthoritativeServer: authoring requires a durable worldLog");
    }

    const tracer = opts.trace === undefined
      ? new LiminaTracer(opts.sessionId)
      : LiminaTracer.appendOnEmit(opts.sessionId, opts.trace.name, opts.trace.maxInMemory, {
        recoverPartialFinalLine: opts.trace.recoverPartialFinalLine,
      });
    this.tracer = tracer;
    this.policy = opts.policy;
    this.initializeAuthToken = opts.initializeAuthToken;
    this.allowedProfiles = opts.allowedProfiles;
    this.onClientMessage = opts.onClientMessage;
    this.registry = new SkillRegistry(tracer, opts.policy);
    registerCoreSkills(this.registry);

    this.recorder = new WorldRecorder(opts.sessionId, { filterIdleSteps: opts.recordIdleSteps !== true });
    let persisted: WorldCommand[] | undefined;
    if (opts.worldLog !== undefined) {
      this.durableLog = new DurableWorldLog(this.recorder, opts.worldLog.name, { compactFlushed: opts.worldLog.compactFlushed });
      // A brand-new project has NO durable log file yet (the create-limina-app /
      // first-boot case): op_read_trace throws on a missing file, so a missing log
      // must read as EMPTY -> fresh open(), not a boot crash. Only a present,
      // non-empty file drives the rehydrate path.
      let existing = "";
      try {
        existing = defaultOps.op_read_trace(opts.worldLog.name);
      } catch {
        existing = "";
      }
      if (existing.length > 0) {
        persisted = parseWorldLog(existing, {
          recoverPartialFinalLine: true,
          onRecoverableError: (message) => baseOps.op_log(`AuthoritativeServer: ignoring torn final world-log fragment in ${opts.worldLog!.name}: ${message}`),
        }).commands;
        assertReplayable(persisted);
      }
      if (persisted !== undefined && persisted.length > 0) this.durableLog.resume(persisted.length);
      else this.durableLog.open();
    }
    this.rehydrated = persisted !== undefined && persisted.length > 0;
    this.rehydratedCommands = persisted?.length ?? 0;
    this.recorder.attach(this.registry);
    // K4 (worldlog poll -> subscribe): push worldlog/append to every worldlog/subscribe-d
    // connection as soon as a command FINALIZES, instead of making the live viewport poll
    // worldlog.tail on a timer. Wired unconditionally (cheap no-op with zero subscribers); a
    // connection only starts costing anything here once it calls worldlog/subscribe.
    this.recorder.onFinalized(() => {
      if (this.durableLog !== undefined) this.durableWorldlogPushPending = true;
      else this.pushWorldlogAppends();
    });
    this.recorder.seed(opts.seed ?? 0x10ca1ed, { forceInstall: this.rehydrated });
    this.recOps = this.recorder.wrapOps(baseOps);

    const ecs = createEcsWorld();
    const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
    const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
    this.world = {
      ecs,
      transforms: createTransformStorage(ecs),
      spatial: new UniformGridSpatialIndex(),
      entities: new EntityTable(),
      tags: new Map(),
      design: createDesignArtifactStore(),
      scene,
      camera,
      ops: this.recOps,
      mode: "headless",
    };

    if (opts.authoring !== undefined) {
      const sceneAdapter = new SceneAuthoringAdapter({ world: this.world });
      this.authoring = registerAuthoringSkills(this.registry, {
        projectId: opts.authoring.projectId,
        sha256: (canonical) => baseOps.op_sha256(canonical),
        adapters: new StaticAuthoringAdapterAllowlist([sceneAdapter]),
      });
    }

    // The authoritative physics world the sim steps each tick.
    this.recOps.op_physics_create_world(0);
    if (opts.bootstrap !== undefined) {
      opts.bootstrap({ world: this.world, recordedOps: this.recOps, registry: this.registry });
    }

    if (persisted !== undefined && persisted.length > 0) {
      const prefixCount = this.recorder.commandCount;
      if (prefixCount > persisted.length) {
        defaultOps.op_log(
          `AuthoritativeServer: durable world-log ${opts.worldLog!.name} recovered only ${persisted.length} commands, ` +
            `shorter than the deterministic boot prefix ${prefixCount}; continuing without re-appending the prefix`,
        );
        this.durableLog?.resume(prefixCount);
      }
      const tail = prefixCount <= persisted.length ? persisted.slice(prefixCount) : [];
      this.ready = Promise.resolve().then(async () => {
        const droppedSteps = await this.rehydrate(tail);
        // LEGACY-LOG SELF-COMPACTION: a log recorded before the idle-step cut carries per-tick
        // step records; rehydrate still APPLIED them all (faithful physics), but the filter
        // re-recorded only the ones that mattered (bit-identical decision: replayed physics is
        // deterministic, so "changed nothing" replays as "changed nothing"). When any were
        // dropped, the on-disk segment no longer matches the recorder's seq stream -- appending
        // to it would corrupt seq contiguity -- so rewrite it once from the recorder's full
        // in-memory history. One slow boot compacts the log permanently; a log recorded after
        // the cut drops nothing here and the segment is left byte-untouched.
        if (droppedSteps > 0 && this.durableLog !== undefined) {
          const kept = this.durableLog.rewriteFromRecorder();
          defaultOps.op_log(
            `AuthoritativeServer: compacted durable world log ${opts.worldLog!.name}: ` +
              `dropped ${droppedSteps} idle step records, kept ${kept} commands`,
          );
        }
        this.prev = this.snapshotMap();
      }).catch((error) => {
        this.poisonAuthority(error);
        throw error;
      });
    } else {
      this.ready = Promise.resolve();
      this.flushDurableLog();
      // Seed the change baseline so tick 1 deltas are computed against bootstrap.
      this.prev = this.snapshotMap();
    }
  }

  /** Number of intents the server has APPLIED (recorded skill commands). */
  get appliedIntents(): number {
    return this.intentSeq;
  }

  /** Total world-log commands recorded so far (seed + physics + skill). */
  get loggedCommands(): number {
    return this.recorder.commandCount;
  }

  /** Commands readers may observe. A durable server publishes only the prefix
   * acknowledged by its sink, never the merely finalized in-memory tail. */
  get publishedWorldlogCommands(): number {
    const finalized = this.recorder.flushableCount();
    return this.durableLog === undefined ? finalized : Math.min(finalized, this.durableLog.persisted);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  setBroadcastEnabled(enabled: boolean): void {
    this.broadcastEnabled = enabled;
  }

  /** Submit a trusted co-located tool call through the exact same FIFO and
   * durable acknowledgement boundary used by socket clients. */
  invokeAuthoritatively(
    name: string,
    input: Record<string, unknown>,
    context: AuthoritativeInvocationContext,
  ): Promise<MCPResponse> {
    const failure = this.currentAuthorityFailure();
    if (failure !== undefined) return Promise.resolve(this.authorityUnavailableResponse());
    if (this.intentQueue.length >= MAX_QUEUED_INTENTS) {
      return Promise.resolve({
        success: false,
        error: { code: "capacity_exceeded", message: "Authoritative intent queue is full" },
      });
    }
    const response = new Promise<MCPResponse>((resolve) => {
      this.intentQueue.push({
        name,
        input,
        session: {
          ...context,
          causedBy: context.causedBy === undefined ? undefined : [...context.causedBy],
        },
        resolve,
      });
    });
    // A co-located host may use the executor without starting transport loops.
    // Schedule one shared drain; calls arriving before it runs join the batch.
    if (!this.running) this.scheduleStandaloneDrain();
    return response;
  }

  private scheduleStandaloneDrain(): void {
    if (this.standaloneDrainScheduled) return;
    this.standaloneDrainScheduled = true;
    void Promise.resolve().then(async () => {
      try {
        await this.doTick();
      } catch (error) {
        this.poisonAuthority(error);
        this.completeDispatch(this.rejectQueuedAfterFailure());
      } finally {
        this.standaloneDrainScheduled = false;
        if (!this.running && this.intentQueue.length > 0 && this.currentAuthorityFailure() === undefined) {
          this.scheduleStandaloneDrain();
        }
      }
    });
  }

  private async withAuthorityLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.authorityTail;
    let release!: () => void;
    this.authorityTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Start the accept + tick loops (returns immediately; loops run in background). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.bgLoops.push(this.ready.then(() => {
      if (!this.running) return;
      this.startLoops();
    }, (err) => {
      this.running = false;
      const dispatch = this.rejectQueuedAfterFailure();
      this.completeDispatch(dispatch);
      if (dispatch.sends.length > 0) void Promise.allSettled(dispatch.sends);
      defaultOps.op_log(`AuthoritativeServer rehydrate failed; not starting loops: ${err instanceof Error ? err.message : String(err)}`);
    }));
  }

  private startLoops(): void {
    // The accept loop blocks on accept(); it is NOT awaited at shutdown (the
    // owner closes the listener to release it). The tick + per-connection loops
    // ARE awaited so a test drains cleanly.
    this.acceptLoopP = this.acceptLoop();
    this.bgLoops.push(this.tickLoop());
  }

  /** Stop the loops and close every connection so the event loop can drain. The
   *  caller closes the listener afterward to release the accept loop. */
  async shutdown(): Promise<void> {
    this.running = false;
    const ids = [...this.conns.keys()];
    for (const id of ids) {
      try {
        await this.transport.close(id);
      } catch {
        // already gone
      }
    }
    this.conns.clear();
    await Promise.allSettled(this.bgLoops);
    this.bgLoops = [];
    this.closeDurableLog();
  }

  // ---- accept / per-connection read loops ---------------------------------

  // Run several accepts CONCURRENTLY. transport.accept() performs the per-connection
  // WebSocket UPGRADE handshake before it resolves, so doing them one-at-a-time means a
  // single stalled / half-open peer (a browser mid-reconnect, a probe) blocks EVERY
  // subsequent connection for the whole handshake timeout -- the accept loop wedges and
  // new clients (a coordinator bridge, the chat channel) can't get in. A pool decouples
  // them: a stalled handshake only occupies ONE slot; other clients keep connecting.
  private async acceptLoop(): Promise<void> {
    let inFlight = 0;
    let closed = false; // the listener returned ACCEPT_CLOSED -- stop replenishing the pool
    const pump = (): void => {
      while (this.running && !closed && inFlight < ACCEPT_CONCURRENCY) {
        inFlight += 1;
        void this.acceptOne()
          .then((listenerClosed) => { if (listenerClosed) closed = true; })
          .finally(() => {
            inFlight -= 1;
            if (this.running && !closed) pump();
          });
      }
    };
    pump();
  }

  /** Accept ONE connection. Returns true when the listener is CLOSED so the pool STOPS
   *  replenishing -- otherwise a transport that returns ACCEPT_CLOSED while `running` is
   *  still true would respawn forever into a microtask spin that starves the event loop. */
  private async acceptOne(): Promise<boolean> {
    let connId: number;
    try {
      connId = await this.transport.accept();
    } catch {
      return false; // transient accept/handshake error on this slot -- keep the pool going
    }
    if (connId === ACCEPT_CLOSED || !this.running) return true;
    const conn: ClientConn = { connId, subscribed: false, closing: false, queuedIntents: 0 };
    this.conns.set(connId, conn);
    this.bgLoops.push(this.connLoop(conn));
    return false;
  }

  private async connLoop(conn: ClientConn): Promise<void> {
    while (this.running && !conn.closing) {
      let line: string;
      try {
        line = await this.transport.recv(conn.connId);
      } catch {
        // transport error -> drop the client
        break;
      }
      try {
        if (line.length === 0) break;
        if (line.length > MAX_WIRE_MESSAGE_CHARS) {
          await this.reply(conn.connId, this.error(null, JSON_RPC_ERRORS.invalidRequest, "Request exceeds the 1 MiB message limit"));
          break;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        await this.handleLine(conn, trimmed);
      } catch {
        await this.reply(conn.connId, this.error(null, JSON_RPC_ERRORS.internalError, "Internal error"));
      }
    }
    // Free the session's admission slot so the M7 session-admission quota stays
    // accurate across reconnects.
    if (conn.session !== undefined) this.policy?.releaseSession(conn.session.sessionId);
    this.conns.delete(conn.connId);
  }

  // ---- dispatch ------------------------------------------------------------

  private async handleLine(conn: ClientConn, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await this.reply(conn.connId, this.error(null, JSON_RPC_ERRORS.parseError, "Parse error"));
      return;
    }
    const rec = asRecord(parsed);
    if (rec === undefined || rec.jsonrpc !== "2.0" || typeof rec.method !== "string") {
      await this.reply(conn.connId, this.error(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request"));
      return;
    }
    if (rec.id !== undefined && rec.id !== null && typeof rec.id !== "string" && typeof rec.id !== "number") {
      await this.reply(conn.connId, this.error(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request"));
      return;
    }
    const id = (rec.id ?? null) as string | number | null;
    const params = rec.params;

    if (rec.method !== "initialize" && conn.session === undefined) {
      await this.reply(conn.connId, this.error(id, -32000, "MCP session is not initialized"));
      return;
    }

    try {
      switch (rec.method) {
      case "initialize": {
        if (conn.session !== undefined) {
          await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.invalidRequest, "MCP session is already initialized"));
          return;
        }
        const p = asRecord(params);
        if (p === undefined || typeof p.agentId !== "string" || typeof p.sessionId !== "string" || typeof p.profile !== "string") {
          await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.invalidParams, "initialize requires agentId, sessionId, and profile"));
          return;
        }
        if (this.initializeAuthToken !== undefined && p.authToken !== this.initializeAuthToken) {
          await this.reply(conn.connId, this.error(id, mcpErrorToJsonRpc("forbidden"), "initialize denied: missing or invalid auth token"));
          return;
        }
        if (this.allowedProfiles !== undefined && !this.allowedProfiles.has(p.profile)) {
          await this.reply(conn.connId, this.error(id, mcpErrorToJsonRpc("forbidden"), `initialize denied: profile '${p.profile}' is not allowed on this listener`));
          return;
        }
        // SESSION ADMISSION (M7): the policy engine decides whether this session
        // may be admitted (revoked session / unknown profile / session quota). The
        // decision is audited; a denied admission is rejected here so the client
        // never receives a permission set — admission is the only way to obtain one.
        if (this.policy !== undefined) {
          const decision = this.policy.admitSession({
            boundary: "session",
            agentId: p.agentId,
            sessionId: p.sessionId,
            cap: "",
            profile: p.profile,
          });
          this.tracer.emit({
            type: policyEventType(decision),
            actorId: p.agentId,
            threadId: p.sessionId,
            parentEventId: null,
            causedBy: [],
            payload: policyEventPayload(decision),
          });
          if (!decision.allow) {
            await this.reply(conn.connId, this.error(id, mcpErrorToJsonRpc("forbidden"), `session admission denied: ${decision.reason}`));
            return;
          }
        }
        // ATTRIBUTION is bound HERE, from the session, never from a per-call
        // payload (the spike's session-bound rule). A client cannot raise its
        // own privilege per intent: the profile -> permission set is fixed now.
        conn.session = {
          agentId: p.agentId,
          sessionId: p.sessionId,
          profile: p.profile,
          permissions: resolveProfile(p.profile),
        };
        await this.reply(conn.connId, this.success(id, {
          protocolVersion: "2026-06-23",
          session: { agentId: p.agentId, sessionId: p.sessionId, profile: p.profile },
        }));
        return;
      }
      case "tools/list":
      case "listTools":
        if (conn.session === undefined) return;
        await this.reply(conn.connId, this.success(id, { tools: this.registry.list(conn.session.permissions) }));
        return;
      case "tools/call":
      case "callTool": {
        if (conn.session === undefined) return;
        const p = asRecord(params);
        if (p === undefined || typeof p.name !== "string") {
          await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.invalidParams, "tools/call requires name and object arguments"));
          return;
        }
        const args = p.arguments === undefined ? {} : asRecord(p.arguments);
        if (args === undefined) {
          await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.invalidParams, "tools/call requires object arguments"));
          return;
        }
        // Reads do not wait for a simulation tick, but they do enter the same FIFO
        // world lock as mutation batches. Otherwise an async transaction can yield
        // between operations and a reader can observe a state that never committed.
        // The reply send remains outside that lock.
        const skillName = p.name;
        const def = this.registry.describe(skillName);
        if (def !== undefined && skillEffect(def) === "read") {
          const result = await this.withAuthorityLock(async () => {
            await this.ready;
            if (this.currentAuthorityFailure() !== undefined) return this.authorityUnavailableResponse();
            return this.registry.invoke(skillName, args, {
              agentId: conn.session!.agentId,
              sessionId: conn.session!.sessionId,
              permissions: conn.session!.permissions,
              profile: conn.session!.profile,
              tick: this.tick,
              world: this.world,
            });
          });
          if (!result.success && result.error !== undefined) {
            await this.reply(conn.connId, this.error(id, mcpErrorToJsonRpc(result.error.code), result.error.message, result));
          } else {
            await this.reply(conn.connId, this.success(id, result));
          }
          return;
        }
        if (this.currentAuthorityFailure() !== undefined) {
          await this.reply(conn.connId, this.error(
            id,
            JSON_RPC_ERRORS.internalError,
            "Authoritative persistence is unavailable; mutating intents are disabled until restart",
          ));
          return;
        }
        // INTENT: queue for application at the next tick boundary (one total
        // order). NOTE: the payload's `context`, if any, is IGNORED -- attribution
        // comes from conn.session only.
        const queuedByConnection = conn.queuedIntents ?? 0;
        if (this.intentQueue.length >= MAX_QUEUED_INTENTS || queuedByConnection >= MAX_QUEUED_INTENTS_PER_CONNECTION) {
          await this.reply(conn.connId, this.error(id, mcpErrorToJsonRpc("capacity_exceeded"), "Authoritative intent queue is full"));
          return;
        }
        this.intentQueue.push({ connId: conn.connId, reqId: rec.id, name: skillName, input: args, session: conn.session });
        conn.queuedIntents = queuedByConnection + 1;
        return;
      }
      case SYNC_METHODS.subscribe: {
        if (this.currentAuthorityFailure() !== undefined) {
          await this.reply(conn.connId, this.error(
            id,
            JSON_RPC_ERRORS.internalError,
            "Authoritative state is unavailable after a persistence failure; restart is required",
          ));
          return;
        }
        const joined = await this.withAuthorityLock(async () => {
          await this.ready;
          if (this.currentAuthorityFailure() !== undefined) return undefined;
          const p = asRecord(params);
          conn.aoi = parseAoi(p?.aoi);
          conn.subscribed = true;
          this.prev = this.snapshotMap();
          return { snapshot: this.snapshotLine(conn), tick: this.tick };
        });
        if (joined === undefined) {
          await this.reply(conn.connId, this.authorityUnavailableWire(id));
          return;
        }
        await this.sendSafe(conn.connId, joined.snapshot);
        await this.reply(conn.connId, this.success(id, { ok: true, tick: joined.tick }));
        return;
      }
      case WORLDLOG_METHODS.subscribe: {
        if (this.currentAuthorityFailure() !== undefined) {
          await this.reply(conn.connId, this.error(
            id,
            JSON_RPC_ERRORS.internalError,
            "Authoritative state is unavailable after a persistence failure; restart is required",
          ));
          return;
        }
        // K4: mirrors the state/subscribe pattern above -- push the join batch BEFORE the ack, so
        // a client that only ever reacts to worldlog/append (no separate initial poll) still gets
        // the tail from `since` immediately. worldlogTail is the SAME helper worldlog.tail (the
        // skill) calls, so a client that mixes an occasional poll with this push can never see the
        // two disagree on what "authoring since X" means.
        const initial = await this.withAuthorityLock(async () => {
          await this.ready;
          if (this.currentAuthorityFailure() !== undefined) return undefined;
          const p = asRecord(params);
          const rawSince = p?.since;
          const since = typeof rawSince === "number" && Number.isFinite(rawSince) ? Math.max(0, Math.floor(rawSince)) : 0;
          const tail = worldlogTail(this.recorder, this.registry, since, this.publishedWorldlogCommands);
          conn.worldlogCursor = tail.next;
          return tail;
        });
        if (initial === undefined) {
          await this.reply(conn.connId, this.authorityUnavailableWire(id));
          return;
        }
        await this.sendSafe(conn.connId, JSON.stringify({
          jsonrpc: "2.0",
          method: WORLDLOG_METHODS.append,
          params: initial,
        }));
        await this.reply(conn.connId, this.success(id, { ok: true, next: initial.next }));
        return;
      }
      case SYNC_METHODS.declareAoi: {
        if (this.currentAuthorityFailure() !== undefined) {
          await this.reply(conn.connId, this.error(
            id,
            JSON_RPC_ERRORS.internalError,
            "Authoritative state is unavailable after a persistence failure; restart is required",
          ));
          return;
        }
        const aoiResult = await this.withAuthorityLock(async () => {
          await this.ready;
          if (this.currentAuthorityFailure() !== undefined) return undefined;
          const aoi = parseAoi(params);
          const prevAoi = conn.aoi;
          conn.aoi = aoi;
          const removed: string[] = [];
          if (conn.subscribed) {
            for (const [entId, state] of this.prev) {
              if (inAoi(prevAoi, state.pos) && !inAoi(aoi, state.pos)) removed.push(entId);
            }
          }
          return removed.length === 0 ? null : JSON.stringify({
              jsonrpc: "2.0",
              method: SYNC_METHODS.delta,
              params: { tick: this.tick, causedBy: [], changes: [], removed },
            });
        });
        if (aoiResult === undefined) {
          await this.reply(conn.connId, this.authorityUnavailableWire(id));
          return;
        }
        if (aoiResult !== null) await this.sendSafe(conn.connId, aoiResult);
        await this.reply(conn.connId, this.success(id, { ok: true }));
        return;
      }
      case "shutdown": {
        await this.reply(conn.connId, this.success(id, { ok: true }));
        conn.closing = true;
        await this.transport.close(conn.connId);
        return;
      }
      default:
        if (this.currentAuthorityFailure() !== undefined) {
          await this.reply(conn.connId, this.authorityUnavailableWire(id));
          return;
        }
        if (this.onClientMessage !== undefined) {
          const handled = await this.onClientMessage(rec.method, params, {
            session: conn.session,
            connId: conn.connId,
            reply: (result: unknown) => this.reply(conn.connId, this.success(id, result)),
            push: (method: string, params: unknown) => this.sendSafe(conn.connId, JSON.stringify({
              jsonrpc: "2.0",
              method,
              params,
            })),
            error: (message: string) => this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.internalError, message)),
          });
          if (handled) return;
        }
        // AUTHORITY: there is NO set-state verb. Any unknown method (a direct
        // state write attempt included) is rejected; state is untouched.
        await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${rec.method}`));
        return;
      }
    } catch {
      await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.internalError, "Internal error"));
    }
  }

  // ---- tick loop -----------------------------------------------------------

  private async tickLoop(): Promise<void> {
    while (this.running) {
      await defaultOps.op_sleep_ms(this.tickMs);
      if (!this.running) break;
      try {
        await this.doTick();
      } catch (err) {
        // A single bad tick (a throwing skill handler, a transient transport error)
        // must NOT kill the authoritative loop and freeze ALL authoring. Log and
        // continue; the next tick re-drains the queue. Without this boundary one
        // rejected op silently wedges the server (the observed long-running-host stall).
        defaultOps.op_log(`AuthoritativeServer.doTick error (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async doTick(): Promise<void> {
    await this.ready;
    const dispatch = await this.withAuthorityLock(() => this.doTickExclusive());
    this.completeDispatch(dispatch);
    if (dispatch.sends.length > 0) await Promise.allSettled(dispatch.sends);
  }

  private async doTickExclusive(): Promise<TickDispatch> {
    if (this.currentAuthorityFailure() !== undefined) return this.rejectQueuedAfterFailure();
    // An authoritative world with no participants and no pending input has
    // nothing to advance -- skip the step (and its world-log entry) so an idle
    // server does not accumulate state unbounded.
    if (this.conns.size === 0 && this.intentQueue.length === 0) return { sends: [], completions: [] };
    this.tick += 1;
    this.recorder.tick = this.tick;

    // 1. Apply intents accepted since the last tick, in arrival order. Each goes
    //    through SkillRegistry.invoke (permission check + recorder hook), so the
    //    authoritative timeline stays an M1 log and authority holds.
    const causedBy: number[] = [];
    const queue = this.intentQueue.splice(0, MAX_INTENTS_PER_TICK);
    for (const intent of queue) this.decrementQueuedConnection(intent);
    const outcomes: Array<{ intent: QueuedIntent; result: MCPResponse }> = [];
    for (const it of queue) {
      const result: MCPResponse = await this.registry.invoke(it.name, it.input, {
        agentId: it.session.agentId,
        sessionId: it.session.sessionId,
        permissions: it.session.permissions,
        profile: it.session.profile,
        causedBy: it.session.causedBy === undefined ? undefined : [...it.session.causedBy],
        tick: this.tick,
        world: this.world,
      });
      outcomes.push({ intent: it, result });
      if (this.authoring?.kernel.poisoned) {
        this.poisonAuthority(this.authoring.kernel.poisonReason ?? new Error("authoring transaction kernel is poisoned"));
        // Nothing after a failed rollback may execute against the indeterminate
        // world. Reject this whole batch plus every intent accepted behind it.
        const remainingBatch = queue.slice(outcomes.length);
        const queuedBehind = this.intentQueue.splice(0);
        for (const pending of queuedBehind) this.decrementQueuedConnection(pending);
        return this.rejectIntentsAfterFailure([
          ...outcomes.map((outcome) => outcome.intent),
          ...remainingBatch,
          ...queuedBehind,
        ]);
      }
    }

    // 2. Advance the authoritative sim one fixed step (recorded), then sync
    //    native body transforms into ECS storage (the per-tick engine rule).
    this.recOps.op_physics_step();
    let persistenceFailure: Error | undefined;
    try {
      // This is the commit boundary for successful mutating intents. No success
      // response is constructed until every finalized command through this tick
      // has reached the durable sink.
      this.flushDurableLog();
    } catch (err) {
      persistenceFailure = this.poisonDurableLog(err);
      defaultOps.op_log(`AuthoritativeServer: durable world-log append failed; authoring poisoned until restart: ${persistenceFailure.message}`);
    }
    if (persistenceFailure !== undefined) {
      // The in-memory world and recorder may now be ahead of the recoverable
      // prefix. Every outcome in the batch fails and no state is synchronized or
      // published. Later queued work is drained by the fail-stop path.
      return this.rejectIntentsAfterFailure(outcomes.map((outcome) => outcome.intent));
    }
    syncAllBodies(this.world);

    const dispatch: TickDispatch = { sends: [], completions: [] };
    for (const { intent, result } of outcomes) {
      if (result.success) causedBy.push(this.intentSeq++);
      if (intent.resolve !== undefined) dispatch.completions.push({ resolve: intent.resolve, response: result });
      if (intent.connId === undefined || intent.reqId === undefined) continue;
      const line = !result.success && result.error !== undefined
        ? this.error(intent.reqId ?? null, mcpErrorToJsonRpc(result.error.code), result.error.message, result)
        : this.success(intent.reqId ?? null, result);
      dispatch.sends.push(this.sendSafe(intent.connId, line));
    }

    // 3. Skip the O(world) capture+diff entirely when nothing will consume a delta:
    //    broadcasting off, or NO client subscribed. `prev` is refreshed on subscribe,
    //    so a joining client always diffs against a fresh baseline. (Under active
    //    subscription the diff is still O(world): captureWorldState walks every entity,
    //    as there is no cross-boundary dirty signal. TODO(P4.perf): thread an
    //    entities-touched-this-tick set out of the sim/skill-apply path so the diff
    //    scans only mutated entities. The AoI filter below already bounds each client's
    //    OUTPUT to O(relevant).)
    if (!this.broadcastEnabled) return dispatch;
    let anySubscribed = false;
    for (const c of this.conns.values()) { if (c.subscribed) { anySubscribed = true; break; } }
    if (!anySubscribed) return dispatch;

    const prev = this.prev;
    const cur = this.snapshotMap();
    const changes: EntityState[] = [];
    for (const [id, state] of cur) {
      const before = prev.get(id);
      if (before === undefined || !sameState(before, state)) changes.push(state);
    }
    // Entities present last tick but gone now = authoritative removals (despawn).
    const removedIds: string[] = [];
    for (const id of prev.keys()) {
      if (!cur.has(id)) removedIds.push(id);
    }
    this.prev = cur;

    if (changes.length === 0 && removedIds.length === 0) return dispatch;

    // 4. Broadcast per subscribed client, filtered by that client's AoI. A client
    //    only ever sees entities relevant to it -> O(relevant), not O(K). Removals
    //    are per-client: a global despawn OR an entity that moved OUT of this client's
    //    AoI (was relevant last tick, is not now) both leave the client's view, so
    //    both are reported as `removed` ids -- without them a client view never
    //    converges (removed/exited entities would persist forever).
    const fullInterestDeltaLine = JSON.stringify({
      jsonrpc: "2.0",
      method: SYNC_METHODS.delta,
      params: { tick: this.tick, causedBy, changes, removed: removedIds },
    });
    let broadcast = false;
    for (const conn of this.conns.values()) {
      if (!conn.subscribed) continue;
      if (conn.aoi === undefined) {
        broadcast = true;
        dispatch.sends.push(this.sendSafe(conn.connId, fullInterestDeltaLine));
        continue;
      }
      const filtered: EntityState[] = [];
      const removed: string[] = [];
      for (const e of changes) {
        if (inAoi(conn.aoi, e.pos)) {
          filtered.push(e);
        } else {
          // Changed but no longer in AoI: if it was in AoI last tick it EXITED.
          const before = prev.get(e.id);
          if (before !== undefined && inAoi(conn.aoi, before.pos)) removed.push(e.id);
        }
      }
      for (const id of removedIds) {
        const before = prev.get(id);
        if (before !== undefined && inAoi(conn.aoi, before.pos)) removed.push(id);
      }
      if (filtered.length === 0 && removed.length === 0) continue;
      broadcast = true;
      dispatch.sends.push(this.sendSafe(conn.connId, JSON.stringify({
        jsonrpc: "2.0",
        method: SYNC_METHODS.delta,
        params: { tick: this.tick, causedBy, changes: filtered, removed },
      })));
    }
    if (broadcast) this.lastBroadcastTick = this.tick;
    return dispatch;
  }

  /** Replay the persisted tail through the RECORDING ops so the recorder repopulates its
   *  in-memory history. Returns how many replayed step records the idle-step filter dropped
   *  from re-recording (legacy logs only; a post-cut log re-records 1:1 and returns 0). */
  private async rehydrate(commands: WorldCommand[]): Promise<number> {
    const droppedBefore = this.recorder.droppedIdleSteps;
    for (const cmd of commands) {
      if (cmd.kind === "seed") {
        throw new Error(`AuthoritativeServer rehydrate: unexpected seed command in replay tail at seq ${cmd.seq}`);
      }
      // Thread the ORIGINAL tick into the recorder so a re-recorded physics command keeps its
      // historical tick (the ops proxy stamps rec.tick). Required for a faithful compacted
      // rewrite; previously the in-memory twin re-recorded rehydrated physics with tick 0.
      this.recorder.tick = cmd.tick;
      if (cmd.kind === "physics") {
        const op = this.recOps[PHYSICS_OP_FN[cmd.op]] as (...a: unknown[]) => unknown;
        const outLen = PHYSICS_OP_OUT_BUFFER[cmd.op];
        if (outLen === undefined) op(...cmd.args);
        else op(...cmd.args, new Float32Array(outLen));
        if (cmd.op === "step") syncAllBodies(this.world);
        continue;
      }
      const response = await this.registry.invoke(cmd.tool, cmd.input, {
        agentId: cmd.actorId,
        sessionId: cmd.sessionId,
        permissions: new Set(cmd.perms),
        tick: cmd.tick,
        world: this.world,
        causedBy: [],
      });
      if (!response.success) {
        const code = response.error?.code ?? "unknown";
        const message = response.error?.message ?? "skill invocation failed";
        throw new Error(`AuthoritativeServer rehydrate: command seq ${cmd.seq} tool ${cmd.tool} failed (${code}): ${message}`);
      }
    }
    // Every replayed command must re-record exactly once -- except a legacy idle step the filter
    // provably-safely dropped from re-recording (it was still APPLIED above). Strict accounting:
    // re-recorded + dropped must equal the persisted count, so a double-record or a silent miss
    // still fails loudly.
    const droppedSteps = this.recorder.droppedIdleSteps - droppedBefore;
    if (this.recorder.commandCount + droppedSteps !== this.rehydratedCommands) {
      throw new Error(
        `AuthoritativeServer rehydrate: recorder has ${this.recorder.commandCount} commands after replay ` +
          `(+${droppedSteps} idle steps dropped), expected ${this.rehydratedCommands}`,
      );
    }
    return droppedSteps;
  }

  private currentAuthorityFailure(): Error | undefined {
    if (this.authoring?.kernel.poisoned && this.authorityIntegrityFailure === undefined) {
      this.poisonAuthority(this.authoring.kernel.poisonReason ?? new Error("authoring transaction kernel is poisoned"));
    }
    return this.durableLogFailure ?? this.authorityIntegrityFailure;
  }

  private poisonAuthority(error: unknown): Error {
    if (this.authorityIntegrityFailure === undefined) {
      this.authorityIntegrityFailure = error instanceof Error ? error : new Error(String(error));
    }
    return this.authorityIntegrityFailure;
  }

  private authorityUnavailableResponse(): MCPResponse {
    return {
      success: false,
      error: {
        code: "handler_error",
        message: "Authoritative state is unavailable after an integrity or persistence failure; restart is required",
      },
    };
  }

  private authorityUnavailableWire(id: string | number | null): string {
    return this.error(
      id,
      JSON_RPC_ERRORS.internalError,
      "Authoritative state is unavailable after an integrity or persistence failure; restart is required",
    );
  }

  private mutationUnavailableResponse(): MCPResponse {
    return {
      success: false,
      error: {
        code: "handler_error",
        message: this.durableLogFailure !== undefined
          ? "Authoritative mutation could not be persisted; authoring is disabled until restart"
          : "Authoritative mutation failed integrity checks; authoring is disabled until restart",
      },
    };
  }

  private mutationUnavailableWire(id: string | number | null): string {
    return this.error(id, JSON_RPC_ERRORS.internalError, this.mutationUnavailableResponse().error!.message);
  }

  private decrementQueuedConnection(intent: QueuedIntent): void {
    if (intent.connId === undefined) return;
    const source = this.conns.get(intent.connId);
    if (source !== undefined) source.queuedIntents = Math.max(0, source.queuedIntents - 1);
  }

  private rejectQueuedAfterFailure(): TickDispatch {
    const queued = this.intentQueue.splice(0);
    for (const intent of queued) this.decrementQueuedConnection(intent);
    return this.rejectIntentsAfterFailure(queued);
  }

  private rejectIntentsAfterFailure(intents: readonly QueuedIntent[]): TickDispatch {
    const response = this.mutationUnavailableResponse();
    const dispatch: TickDispatch = { sends: [], completions: [] };
    for (const intent of intents) {
      if (intent.resolve !== undefined) dispatch.completions.push({ resolve: intent.resolve, response });
      if (intent.connId !== undefined && intent.reqId !== undefined) {
        dispatch.sends.push(this.sendSafe(intent.connId, this.mutationUnavailableWire(intent.reqId ?? null)));
      }
    }
    return dispatch;
  }

  private completeDispatch(dispatch: TickDispatch): void {
    for (const completion of dispatch.completions) completion.resolve(completion.response);
  }

  // ---- snapshot / state helpers -------------------------------------------

  private snapshotMap(): Map<string, EntityState> {
    const out = new Map<string, EntityState>();
    // sorted=false: the diff keys by id, so the per-tick id sort is pure waste here.
    for (const e of captureWorldState(this.world, false).entities) out.set(e.id, e);
    return out;
  }

  private flushDurableLog(): void {
    if (this.durableLogClosed) return;
    const authorityFailure = this.currentAuthorityFailure();
    if (authorityFailure !== undefined) throw authorityFailure;
    try {
      this.durableLog?.flush();
      if (this.durableLog !== undefined && this.durableWorldlogPushPending) {
        this.durableWorldlogPushPending = false;
        this.pushWorldlogAppends();
      }
    } catch (err) {
      throw this.poisonDurableLog(err);
    }
  }

  private poisonDurableLog(err: unknown): Error {
    if (this.durableLogFailure === undefined) {
      this.durableLogFailure = err instanceof Error ? err : new Error(String(err));
    }
    return this.durableLogFailure;
  }

  private closeDurableLog(): void {
    if (this.durableLog === undefined || this.durableLogClosed) return;
    if (this.currentAuthorityFailure() !== undefined) {
      // close() flushes. Retrying a poisoned writer could append a later in-memory
      // suffix after an unknown partial failure, so preserve the last known prefix.
      this.durableLogClosed = true;
      return;
    }
    this.durableLog.close();
    this.durableLogClosed = true;
  }

  private snapshotLine(conn: ClientConn): string {
    // Reuse the M2 capture for the authoritative join view, then project it to
    // the wire + filter to the client's AoI (the snapshot is part of the stream,
    // so it must be O(relevant) too).
    const snap = captureWorldSnapshot(this.world, {
      sessionId: this.sessionId,
      tick: this.tick,
      snapshotSeq: this.recorder.commandCount,
    });
    const entities: EntityState[] = [];
    for (const e of snap.entities) {
      if (!inAoi(conn.aoi, e.pos)) continue;
      entities.push({ id: e.id, eid: e.eid, pos: e.pos, rot: e.rot, scale: e.scale });
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      method: SYNC_METHODS.snapshot,
      params: { tick: this.tick, entities },
    });
  }

  /** K4 (worldlog poll -> subscribe): fired from WorldRecorder.onFinalized for every command
   *  newly admitted to the contiguous finalized prefix. For each subscribed connection, compute its authoring tail from its
   *  stored cursor and push a batch -- but ONLY when there is something new to report, so an
   *  otherwise-idle world never wakes a subscriber with an empty push every time an unrelated
   *  command finalizes elsewhere (e.g. two independent agent chains). A dead connection is simply
   *  absent from `this.conns` (connLoop's teardown / sendSafe's send-failure prune both delete it
   *  synchronously), so this loop can never push to, or throw for, a disconnected client. */
  private pushWorldlogAppends(): void {
    if (this.currentAuthorityFailure() !== undefined) return;
    for (const conn of this.conns.values()) {
      if (conn.worldlogCursor === undefined) continue;
      const tail = worldlogTail(this.recorder, this.registry, conn.worldlogCursor, this.publishedWorldlogCommands);
      if (tail.commands.length === 0 && !tail.reset) continue;
      conn.worldlogCursor = tail.next;
      void this.sendSafe(conn.connId, JSON.stringify({
        jsonrpc: "2.0",
        method: WORLDLOG_METHODS.append,
        params: tail,
      }));
    }
  }

  // ---- wire helpers --------------------------------------------------------

  private success(id: string | number | null, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private error(id: string | number | null, code: number, message: string, data?: unknown): string {
    return JSON.stringify(data === undefined
      ? { jsonrpc: "2.0", id, error: { code, message } }
      : { jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private async reply(connId: number, line: string): Promise<void> {
    await this.sendSafe(connId, line);
  }

  private async sendSafe(connId: number, line: string): Promise<void> {
    try {
      await this.transport.send(connId, line);
    } catch {
      // Client disconnected mid-send: prune it so the broadcast loop stops trying.
      this.conns.delete(connId);
    }
  }
}


/** Build a server transport whose `accept` pulls from the host `--mcp-ws` listener. */
export function hostTransport(net: NetOps): NetServerTransport {
  return {
    accept: () => net.op_net_accept_host(),
    recv: (id) => net.op_net_recv(id),
    send: (id, line) => net.op_net_send(id, line),
    close: (id) => net.op_net_close(id),
  };
}

/** Build a server transport whose `accept` pulls from a self-bound listener. */
export function listenerTransport(net: NetOps, listenerId: number): NetServerTransport {
  return {
    accept: () => net.op_net_accept(listenerId),
    recv: (id) => net.op_net_recv(id),
    send: (id, line) => net.op_net_send(id, line),
    close: (id) => net.op_net_close(id),
  };
}
