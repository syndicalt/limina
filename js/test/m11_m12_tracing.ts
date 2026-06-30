// M11/M12 — trace replay window + inspector snapshot; EventLoom JSONL export to
// disk, re-read, integrity-chain verification, and causal-tree reconstruction.

import { ops } from "../src/engine.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { createHeadlessContext } from "../src/game/index.ts";

interface ExportedEvent {
  id: string;
  type: string;
  causedBy: string[];
  payload: unknown;
  integrity: { hash: string; previousHash: string | null };
}

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    const rec = value as Record<string, unknown>;
    return rec[key];
  }
  return undefined;
}

const ctx = createHeadlessContext({ session: "ses_trace" });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.registry.tracer;
ops.op_physics_create_world(-9.81);
const builderPerms = resolveProfile("builder.readWrite");
const baseAt = (agentId: string, tick: number, causedBy?: string[]) => ({ agentId, sessionId: "ses_trace", permissions: builderPerms, tick, world, causedBy });

const created: MCPResponse = await registry.invoke("scene.createEntity", { position: [0, 1, 0] }, baseAt("agt_a", 1));
const entity = field(created.result, "entity");
if (typeof entity !== "string") throw new Error("setup failed");
const firstEventId = created.metadata?.eventsEmitted[0];

// A causally-linked update at tick 5 (skill.executed causedBy the first event).
await registry.invoke("ecs.updateComponent", { entity, component: "position", value: [1, 1, 1] }, baseAt("agt_a", 5, firstEventId !== undefined ? [firstEventId] : []));
await registry.invoke("scene.queryEntities", {}, baseAt("agt_a", 9));
await registry.invoke("agent.emitEvent", { type: "hello", payload: {} }, baseAt("agt_b", 3));

// M11: replay window.
const allA = tracer.trace("agt_a");
if (allA.length === 0) throw new Error("no events for agt_a");
const since5 = tracer.trace("agt_a", 5);
if (since5.length === 0 || since5.length >= allA.length) throw new Error("sinceTick filter ineffective");
for (const e of since5) {
  const t = field(e.payload, "tick");
  if (typeof t === "number" && t < 5) throw new Error("sinceTick leaked an earlier event");
}

// M11: inspector snapshot.
const snap = tracer.inspect();
if (snap.threadId !== "ses_trace") throw new Error("inspect threadId");
if (!snap.actors.includes("agt_a") || !snap.actors.includes("agt_b")) throw new Error("inspect actors");
if (snap.eventCount < 4) throw new Error("inspect eventCount");

// M12: export -> disk -> re-read -> verify.
const jsonl = tracer.exportJsonl();
ops.op_write_trace("ses_trace.jsonl", jsonl);
const readBack = ops.op_read_trace("ses_trace.jsonl");
if (readBack !== jsonl) throw new Error("trace file did not round-trip byte-for-byte");

const events: ExportedEvent[] = readBack.trim().split("\n").map((line): ExportedEvent => JSON.parse(line));
let previousHash: string | null = null;
const byId = new Map<string, ExportedEvent>();
for (const e of events) {
  if (e.integrity.previousHash !== previousHash) throw new Error("integrity chain break");
  if (!e.integrity.hash.startsWith("sha256:")) throw new Error("missing sha256 prefix");
  previousHash = e.integrity.hash;
  byId.set(e.id, e);
}

// Reconstruct the causal tree: every causedBy id resolves to a known event.
let edges = 0;
for (const e of events) {
  for (const parent of e.causedBy) {
    if (!byId.has(parent)) throw new Error("dangling causedBy: " + parent);
    edges += 1;
  }
}
if (edges === 0) throw new Error("no causal edges reconstructed");

ops.op_log(`M11/M12 OK: replay window + inspector; ${events.length}-event JSONL round-tripped, chain verified, ${edges} causal edge(s)`);
