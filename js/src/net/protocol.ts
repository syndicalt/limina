// limina authoritative-sync wire contract (Phase 4 M4/M5).
//
// The networked surface is JSON-RPC 2.0 (the same envelope as the MCP transport)
// EXTENDED with a read-only state-sync channel. Authority is STRUCTURAL: the only
// mutation verb on the wire is `tools/call` (an INTENT -> SkillRegistry.invoke,
// permission-checked, applied at a tick boundary). There is deliberately NO
// "set state" verb -- a client cannot express a direct authoritative write, and
// any unknown method is rejected (method-not-found). Attribution is bound to the
// session at `initialize`, never read from a per-call payload.
//
// Client -> Server requests (JSON-RPC, carry `id`):
//   initialize {agentId, sessionId, profile}        -> session bind
//   tools/list {}                                    -> available intents
//   tools/call {name, arguments}                     -> INTENT (applied at tick)
//   state/subscribe {aoi?}                           -> opt-in to the sync stream;
//                                                       server pushes a snapshot now
//                                                       + a per-tick delta thereafter
//   aoi/declare {center:[x,y,z], radius}             -> update the area-of-interest
//                                                       (pushes a `removed` delta for
//                                                       entities the new AoI drops)
//   shutdown {}                                      -> close
//
// Server -> Client notifications (no `id`, only to SUBSCRIBED clients):
//   state/snapshot {tick, entities[]}                -> AoI-filtered join view
//   state/delta    {tick, causedBy[], changes[], removed[]} -> AoI-filtered changed
//                                                       set + ids no longer relevant
//
// A client that never subscribes (e.g. a plain MCP tool caller) receives no
// pushes -- the existing single-client tools/call path is unchanged.

import { z } from "../../build/zod.bundle.mjs";
import type { EntityState } from "../worldlog/log.ts";

/** A spherical area-of-interest: the client only syncs entities within `radius`
 *  of `center`. Absent AoI on a subscription = full interest (whole world). */
export interface AreaOfInterest {
  center: [number, number, number];
  radius: number;
}

/** Pushed once on subscribe: the AoI-filtered view of authoritative state at the
 *  join tick (derived from the M2 WorldSnapshot capture). */
export interface SnapshotParams {
  tick: number;
  entities: EntityState[];
}

/** Pushed each tick to a subscriber: only the entities that changed this tick AND
 *  fall inside the client's AoI. `causedBy` lists the server-assigned ids of the
 *  intents applied on this tick (intent -> applied -> synced correlation).
 *  `removed` lists entity ids that left the client's relevant set (world removal, an
 *  entity moving out of AoI, or the client shrinking/moving its AoI via aoi/declare)
 *  so the client view converges; absent/[] on old streams. */
export interface DeltaParams {
  tick: number;
  causedBy: number[];
  changes: EntityState[];
  removed?: string[];
}

export const SYNC_METHODS = {
  snapshot: "state/snapshot",
  delta: "state/delta",
  subscribe: "state/subscribe",
  declareAoi: "aoi/declare",
} as const;

/** The host net ops the server/client transports drive (real WebSocket sockets:
 *  server listen/accept + client connect, then per-connection recv/send/close). */
export interface NetOps {
  op_net_listen(port: number): Promise<number>;
  op_net_listener_port(listenerId: number): number;
  op_net_accept(listenerId: number): Promise<number>;
  op_net_close_listener(listenerId: number): void;
  op_net_accept_host(): Promise<number>;
  op_net_connect(url: string): Promise<number>;
  op_net_recv(connId: number): Promise<string>;
  op_net_send(connId: number, line: string): Promise<void>;
  op_net_close(connId: number): Promise<void>;
}

/** True when `pos` is inside `aoi` (or `aoi` is undefined = full interest). The
 *  single authority for what "relevant" means, shared by snapshot + delta filters
 *  so the join view and the live stream agree. */
export function inAoi(aoi: AreaOfInterest | undefined, pos: readonly [number, number, number]): boolean {
  if (aoi === undefined) return true;
  const dx = pos[0] - aoi.center[0];
  const dy = pos[1] - aoi.center[1];
  const dz = pos[2] - aoi.center[2];
  return dx * dx + dy * dy + dz * dz <= aoi.radius * aoi.radius;
}

/** Parse + validate an AoI from untrusted JSON params (subscribe / aoi declare).
 *  Returns undefined when absent or malformed (treated as full interest). */
export function parseAoi(value: unknown): AreaOfInterest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const center = rec.center;
  const radius = rec.radius;
  if (!Array.isArray(center) || center.length !== 3) return undefined;
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0) return undefined;
  for (const c of center) {
    if (typeof c !== "number" || !Number.isFinite(c)) return undefined;
  }
  return { center: [center[0], center[1], center[2]], radius };
}

// ---- wire boundary validation (the sync channel is network data) ----------

const num = z.number();
const entityStateSchema = z.object({
  id: z.string(),
  eid: z.number(),
  pos: z.tuple([num, num, num]),
  rot: z.tuple([num, num, num, num]),
  scale: z.tuple([num, num, num]),
  body: z.tuple([num, num, num, num, num, num, num]).optional(),
});
const snapshotParamsSchema = z.object({ tick: z.number(), entities: z.array(entityStateSchema) });
const deltaParamsSchema = z.object({ tick: z.number(), causedBy: z.array(z.number()), changes: z.array(entityStateSchema), removed: z.array(z.string()).optional() });

/** Validate a pushed `state/snapshot` payload; undefined if malformed. */
export function parseSnapshotParams(value: unknown): SnapshotParams | undefined {
  const parsed = snapshotParamsSchema.safeParse(value);
  return parsed.success ? (parsed.data as SnapshotParams) : undefined;
}

/** Validate a pushed `state/delta` payload; undefined if malformed. */
export function parseDeltaParams(value: unknown): DeltaParams | undefined {
  const parsed = deltaParamsSchema.safeParse(value);
  return parsed.success ? (parsed.data as DeltaParams) : undefined;
}
