// limina CLIENT view (Phase 4 M4/M5) -- a thin networked view over the real
// WebSocket transport. The client is NOT a simulator: it submits INTENTS
// (tools/call) and applies authoritative state the server pushes (a snapshot on
// subscribe, then per-tick deltas). It demuxes id-correlated JSON-RPC responses
// from server notifications (state/snapshot, state/delta) on one socket.

import { ops as defaultOps } from "../engine.ts";
import type { EntityState } from "../worldlog/log.ts";
import type { AreaOfInterest, DeltaParams, NetOps, SnapshotParams } from "./protocol.ts";
import { parseDeltaParams, parseSnapshotParams, SYNC_METHODS } from "./protocol.ts";

type Net = NetOps;

interface Pending {
  resolve: (msg: JsonRpcMsg) => void;
  reject: (err: unknown) => void;
}

interface Waiter {
  id: string;
  predicate: (state: EntityState) => boolean;
  resolve: (state: EntityState) => void;
  done: boolean;
}

export interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export class NetClient {
  private readonly net: Net;
  readonly connId: number;
  private nextId = 1;
  private running = true;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters: Waiter[] = [];

  /** Latest authoritative state per entity, as synced (snapshot + deltas). */
  readonly state = new Map<string, EntityState>();
  /** Every entity id this client has EVER seen on its stream (M5 inspection). */
  readonly seenEntityIds = new Set<string>();
  /** Raw deltas received, in order (for stream-content assertions). */
  readonly deltas: DeltaParams[] = [];
  readonly snapshots: SnapshotParams[] = [];
  /** Optional hook fired on every sync message (method, params). */
  onSync?: (method: string, params: SnapshotParams | DeltaParams) => void;

  private constructor(net: Net, connId: number) {
    this.net = net;
    this.connId = connId;
  }

  static async connect(net: Net, url: string): Promise<NetClient> {
    const connId = await net.op_net_connect(url);
    const client = new NetClient(net, connId);
    void client.recvLoop();
    return client;
  }

  async initialize(agentId: string, sessionId: string, profile: string): Promise<JsonRpcMsg> {
    return this.request("initialize", { agentId, sessionId, profile });
  }

  async listTools(): Promise<JsonRpcMsg> {
    return this.request("tools/list", {});
  }

  /** Submit an intent. Resolves with the JSON-RPC response (result or error)
   *  the server returns after applying it at the next tick boundary. */
  async call(name: string, args: Record<string, unknown>): Promise<JsonRpcMsg> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Raw request with an arbitrary method (used to probe authority: a method the
   *  wire does not expose, e.g. a direct state write, must be rejected). */
  async rawRequest(method: string, params: unknown): Promise<JsonRpcMsg> {
    return this.request(method, params);
  }

  async subscribe(aoi?: AreaOfInterest): Promise<JsonRpcMsg> {
    return this.request(SYNC_METHODS.subscribe, aoi === undefined ? {} : { aoi });
  }

  async declareAoi(aoi: AreaOfInterest): Promise<JsonRpcMsg> {
    return this.request(SYNC_METHODS.declareAoi, aoi);
  }

  /** Resolve once the client's synced state for `id` satisfies `predicate`, or
   *  reject after `timeoutMs`. The gating signal for cross-client latency. */
  waitForEntityValue(id: string, predicate: (state: EntityState) => boolean, timeoutMs: number): Promise<EntityState> {
    const current = this.state.get(id);
    if (current !== undefined && predicate(current)) return Promise.resolve(current);
    return new Promise<EntityState>((resolve, reject) => {
      const waiter: Waiter = { id, predicate, resolve, done: false };
      this.waiters.push(waiter);
      void defaultOps.op_sleep_ms(timeoutMs).then(() => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`waitForEntityValue timeout for ${id}`));
      });
    });
  }

  async close(): Promise<void> {
    this.running = false;
    try {
      await this.net.op_net_close(this.connId);
    } catch {
      // already gone
    }
    for (const [, p] of this.pending) p.reject(new Error("client closed"));
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<JsonRpcMsg> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.net.op_net_send(this.connId, JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch((err) => {
      const p = this.pending.get(id);
      if (p !== undefined) {
        this.pending.delete(id);
        p.reject(err);
      }
    });
    return promise;
  }

  private async recvLoop(): Promise<void> {
    while (this.running) {
      let line: string;
      try {
        line = await this.net.op_net_recv(this.connId);
      } catch {
        break;
      }
      if (line.length === 0) break;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
    for (const [, p] of this.pending) p.reject(new Error("connection closed"));
    this.pending.clear();
  }

  private handleMessage(msg: JsonRpcMsg): void {
    if (msg.method === SYNC_METHODS.snapshot) {
      const params = parseSnapshotParams(msg.params);
      if (params === undefined) return;
      this.snapshots.push(params);
      this.applySync(params.entities);
      if (this.onSync !== undefined) this.onSync(msg.method, params);
      return;
    }
    if (msg.method === SYNC_METHODS.delta) {
      const params = parseDeltaParams(msg.params);
      if (params === undefined) return;
      this.deltas.push(params);
      this.applySync(params.changes);
      if (this.onSync !== undefined) this.onSync(msg.method, params);
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (pending !== undefined) {
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    }
  }

  private applySync(entities: EntityState[]): void {
    for (const e of entities) {
      this.seenEntityIds.add(e.id);
      this.state.set(e.id, e);
    }
    this.checkWaiters();
  }

  private checkWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      const state = this.state.get(waiter.id);
      if (state !== undefined && waiter.predicate(state)) {
        waiter.done = true;
        this.waiters.splice(i, 1);
        waiter.resolve(state);
      }
    }
  }
}
