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
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { PolicyEngine, policyEventType, policyEventPayload } from "../policy/engine.ts";
import { WorldRecorder } from "../worldlog/recorder.ts";
import { captureWorldSnapshot } from "../worldlog/snapshot.ts";
import { captureWorldState, syncAllBodies, type EntityState } from "../worldlog/log.ts";
import { JSON_RPC_ERRORS, mcpErrorToJsonRpc, type MCPResponse } from "../mcp/protocol.ts";
import { inAoi, parseAoi, SYNC_METHODS, type AreaOfInterest, type NetOps } from "./protocol.ts";

/** op_net_accept returns this when its listener is closed (Rust u32::MAX). */
export const ACCEPT_CLOSED = 0xffffffff;

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
}

interface ClientSession {
  agentId: string;
  sessionId: string;
  profile: string;
  permissions: ReadonlySet<string>;
}

interface ClientConn {
  connId: number;
  session?: ClientSession;
  subscribed: boolean;
  aoi?: AreaOfInterest;
  closing: boolean;
}

interface QueuedIntent {
  connId: number;
  reqId: string | number | null | undefined;
  name: string;
  input: Record<string, unknown>;
  session: ClientSession;
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
  private readonly recOps: EngineOps;
  private readonly transport: NetServerTransport;
  private readonly tickMs: number;
  private readonly sessionId: string;
  private broadcastEnabled: boolean;
  private readonly tracer: LiminaTracer;
  /** The dynamic policy engine (M7); undefined => legacy static-profile admission. */
  private readonly policy?: PolicyEngine;

  private readonly conns = new Map<number, ClientConn>();
  private intentQueue: QueuedIntent[] = [];
  private prev = new Map<string, EntityState>();
  private tick = 0;
  private intentSeq = 0;
  private running = false;
  private bgLoops: Promise<void>[] = [];
  private acceptLoopP?: Promise<void>;

  /** Tick at which the last broadcast happened (for tests). */
  lastBroadcastTick = 0;

  constructor(transport: NetServerTransport, opts: AuthoritativeServerOptions) {
    this.transport = transport;
    this.tickMs = opts.tickMs ?? 8;
    this.sessionId = opts.sessionId;
    this.broadcastEnabled = opts.broadcastEnabled ?? true;
    const baseOps = opts.ops ?? defaultOps;

    const tracer = new LiminaTracer(opts.sessionId);
    this.tracer = tracer;
    this.policy = opts.policy;
    this.registry = new SkillRegistry(tracer, opts.policy);
    registerCoreSkills(this.registry);

    this.recorder = new WorldRecorder(opts.sessionId);
    this.recorder.attach(this.registry);
    this.recorder.seed(opts.seed ?? 0x10ca1ed);
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
      scene,
      camera,
      ops: this.recOps,
      mode: "headless",
    };

    // The authoritative physics world the sim steps each tick.
    this.recOps.op_physics_create_world(0);
    if (opts.bootstrap !== undefined) {
      opts.bootstrap({ world: this.world, recordedOps: this.recOps, registry: this.registry });
    }
    // Seed the change baseline so tick 1 deltas are computed against bootstrap.
    this.prev = this.snapshotMap();
  }

  /** Number of intents the server has APPLIED (recorded skill commands). */
  get appliedIntents(): number {
    return this.intentSeq;
  }

  /** Total world-log commands recorded so far (seed + physics + skill). */
  get loggedCommands(): number {
    return this.recorder.commands.length;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  setBroadcastEnabled(enabled: boolean): void {
    this.broadcastEnabled = enabled;
  }

  /** Start the accept + tick loops (returns immediately; loops run in background). */
  start(): void {
    if (this.running) return;
    this.running = true;
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
  }

  // ---- accept / per-connection read loops ---------------------------------

  private async acceptLoop(): Promise<void> {
    while (this.running) {
      let connId: number;
      try {
        connId = await this.transport.accept();
      } catch {
        break;
      }
      if (connId === ACCEPT_CLOSED || !this.running) break;
      const conn: ClientConn = { connId, subscribed: false, closing: false };
      this.conns.set(connId, conn);
      this.bgLoops.push(this.connLoop(conn));
    }
  }

  private async connLoop(conn: ClientConn): Promise<void> {
    try {
      while (this.running && !conn.closing) {
        const line = await this.transport.recv(conn.connId);
        if (line.length === 0) break;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        await this.handleLine(conn, trimmed);
      }
    } catch {
      // transport error -> drop the client
    } finally {
      // Free the session's admission slot so the M7 session-admission quota stays
      // accurate across reconnects.
      if (conn.session !== undefined) this.policy?.releaseSession(conn.session.sessionId);
      this.conns.delete(conn.connId);
    }
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
    const id = (rec.id ?? null) as string | number | null;
    const params = rec.params;

    switch (rec.method) {
      case "initialize": {
        const p = asRecord(params);
        if (p === undefined || typeof p.agentId !== "string" || typeof p.sessionId !== "string" || typeof p.profile !== "string") {
          await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.invalidParams, "initialize requires agentId, sessionId, and profile"));
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
        await this.reply(conn.connId, this.success(id, { tools: this.registry.list() }));
        return;
      case "tools/call":
      case "callTool": {
        if (conn.session === undefined) {
          await this.reply(conn.connId, this.error(id, -32000, "MCP session is not initialized"));
          return;
        }
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
        // INTENT: queue for application at the next tick boundary (one total
        // order). NOTE: the payload's `context`, if any, is IGNORED -- attribution
        // comes from conn.session only.
        this.intentQueue.push({ connId: conn.connId, reqId: rec.id, name: p.name, input: args, session: conn.session });
        return;
      }
      case SYNC_METHODS.subscribe: {
        const p = asRecord(params);
        conn.aoi = parseAoi(p?.aoi);
        conn.subscribed = true;
        // Push the AoI-filtered join view (reuses the M2 WorldSnapshot capture).
        await this.sendSnapshot(conn);
        await this.reply(conn.connId, this.success(id, { ok: true, tick: this.tick }));
        return;
      }
      case SYNC_METHODS.declareAoi: {
        const aoi = parseAoi(params);
        const prevAoi = conn.aoi;
        conn.aoi = aoi;
        // A client-driven AoI change (shrink/move) drops entities out of view even
        // though they never moved. The per-tick delta only derives exits from THIS
        // tick's `changes` set, so a STATIONARY AoI-exit would linger forever. Push a
        // `removed` delta now for entities inside the OLD AoI but outside the NEW one,
        // using the last authoritative capture (`this.prev`) as their positions --
        // mirroring the snapshot/delta relevance filter so the client view converges.
        if (conn.subscribed) {
          const removed: string[] = [];
          for (const [entId, state] of this.prev) {
            if (inAoi(prevAoi, state.pos) && !inAoi(aoi, state.pos)) removed.push(entId);
          }
          if (removed.length > 0) {
            await this.sendSafe(conn.connId, JSON.stringify({
              jsonrpc: "2.0",
              method: SYNC_METHODS.delta,
              params: { tick: this.tick, causedBy: [], changes: [], removed },
            }));
          }
        }
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
        // AUTHORITY: there is NO set-state verb. Any unknown method (a direct
        // state write attempt included) is rejected; state is untouched.
        await this.reply(conn.connId, this.error(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${rec.method}`));
        return;
    }
  }

  // ---- tick loop -----------------------------------------------------------

  private async tickLoop(): Promise<void> {
    while (this.running) {
      await defaultOps.op_sleep_ms(this.tickMs);
      if (!this.running) break;
      await this.doTick();
    }
  }

  private async doTick(): Promise<void> {
    // An authoritative world with no participants and no pending input has
    // nothing to advance -- skip the step (and its world-log entry) so an idle
    // server does not accumulate state unbounded.
    if (this.conns.size === 0 && this.intentQueue.length === 0) return;
    this.tick += 1;
    this.recorder.tick = this.tick;

    // 1. Apply intents accepted since the last tick, in arrival order. Each goes
    //    through SkillRegistry.invoke (permission check + recorder hook), so the
    //    authoritative timeline stays an M1 log and authority holds.
    const causedBy: number[] = [];
    const queue = this.intentQueue;
    this.intentQueue = [];
    for (const it of queue) {
      const result: MCPResponse = await this.registry.invoke(it.name, it.input, {
        agentId: it.session.agentId,
        sessionId: it.session.sessionId,
        permissions: it.session.permissions,
        profile: it.session.profile,
        tick: this.tick,
        world: this.world,
      });
      if (it.reqId !== undefined) {
        if (!result.success && result.error !== undefined) {
          await this.sendSafe(it.connId, this.error(it.reqId ?? null, mcpErrorToJsonRpc(result.error.code), result.error.message, result));
        } else {
          await this.sendSafe(it.connId, this.success(it.reqId ?? null, result));
        }
      }
      if (result.success) causedBy.push(this.intentSeq++);
    }

    // 2. Advance the authoritative sim one fixed step (recorded), then sync
    //    native body transforms into ECS storage (the per-tick engine rule).
    this.recOps.op_physics_step();
    syncAllBodies(this.world);

    // 3. Compute the change-set by diffing this tick's full capture against the
    //    previous one. NOTE: this is O(world size), not O(changed) -- captureWorldState
    //    walks every entity each tick and there is no cross-boundary dirty signal to
    //    narrow it here. TODO(P4.perf): thread an entities-touched-this-tick set out of
    //    the sim/skill-apply path so the diff scans only mutated entities. The AoI
    //    filter below still bounds each client's OUTPUT to O(relevant).
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

    if (!this.broadcastEnabled) return;
    if (changes.length === 0 && removedIds.length === 0) return;

    // 4. Broadcast per subscribed client, filtered by that client's AoI. A client
    //    only ever sees entities relevant to it -> O(relevant), not O(K). Removals
    //    are per-client: a global despawn OR an entity that moved OUT of this client's
    //    AoI (was relevant last tick, is not now) both leave the client's view, so
    //    both are reported as `removed` ids -- without them a client view never
    //    converges (removed/exited entities would persist forever).
    let broadcast = false;
    for (const conn of this.conns.values()) {
      if (!conn.subscribed) continue;
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
      await this.sendSafe(conn.connId, JSON.stringify({
        jsonrpc: "2.0",
        method: SYNC_METHODS.delta,
        params: { tick: this.tick, causedBy, changes: filtered, removed },
      }));
    }
    if (broadcast) this.lastBroadcastTick = this.tick;
  }

  // ---- snapshot / state helpers -------------------------------------------

  private snapshotMap(): Map<string, EntityState> {
    const out = new Map<string, EntityState>();
    for (const e of captureWorldState(this.world).entities) out.set(e.id, e);
    return out;
  }

  private async sendSnapshot(conn: ClientConn): Promise<void> {
    // Reuse the M2 capture for the authoritative join view, then project it to
    // the wire + filter to the client's AoI (the snapshot is part of the stream,
    // so it must be O(relevant) too).
    const snap = captureWorldSnapshot(this.world, {
      sessionId: this.sessionId,
      tick: this.tick,
      snapshotSeq: this.recorder.commands.length,
    });
    const entities: EntityState[] = [];
    for (const e of snap.entities) {
      if (!inAoi(conn.aoi, e.pos)) continue;
      entities.push({ id: e.id, eid: e.eid, pos: e.pos, rot: e.rot, scale: e.scale });
    }
    await this.sendSafe(conn.connId, JSON.stringify({
      jsonrpc: "2.0",
      method: SYNC_METHODS.snapshot,
      params: { tick: this.tick, entities },
    }));
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
