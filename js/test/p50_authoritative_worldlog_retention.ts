// P50 -- authoritative server can compact world-log hot memory behind a durable log.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";
import { verifyWorldLog } from "../src/worldlog/verify.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p50_authoritative_worldlog_retention: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext): string {
  const eid = spawnRenderable(world.ecs, STUB, 0, 0, 0);
  return world.entities.create({ eid });
}

class ScriptedTransport implements NetServerTransport {
  readonly sent: string[] = [];
  private accepted = false;
  private inbound: string[] = [];

  script(inbound: string[]): void {
    this.inbound = [...inbound];
  }

  async accept(): Promise<number> {
    if (this.accepted) return ACCEPT_CLOSED;
    this.accepted = true;
    return 1;
  }

  async recv(_connId: number): Promise<string> {
    const next = this.inbound.shift();
    if (next !== undefined) return next;
    await ops.op_sleep_ms(40);
    return "";
  }

  async send(_connId: number, line: string): Promise<void> {
    this.sent.push(line);
  }

  async close(_connId: number): Promise<void> {}
}

const LOG_NAME = "p50_authoritative_worldlog_retention.jsonl";
ops.op_write_trace(LOG_NAME, "");

let marker = "";
const transport = new ScriptedTransport();

const server = new AuthoritativeServer(transport, {
  sessionId: "p50_authoritative_worldlog_retention",
  tickMs: 8,
  worldLog: { name: LOG_NAME, compactFlushed: true },
  bootstrap: ({ world, recordedOps }) => {
    marker = spawnMarker(world);
    // A falling dynamic body: since the idle-step cut (kernel K-compaction, worldlog/step-filter.ts)
    // only steps that MOVE something are recorded, so the ticks need real motion for the durable
    // stream to carry the step records the retention assertions below count on.
    recordedOps.op_physics_add_box(0, 5, 0, 0.5);
  },
});

transport.script([
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { agentId: "agent_p50", sessionId: "session_p50", profile: "builder.readWrite" },
  }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ecs.updateComponent", arguments: { entity: marker, component: "position", value: [5, 0, 0] } },
  }),
]);

server.start();
await ops.op_sleep_ms(120);
await server.shutdown();

const disk = ops.op_read_trace(LOG_NAME);
const parsed = parseWorldLog(disk);
const verified = verifyWorldLog(disk);

assert(server.recorder.commandCount >= 4, "server should record seed, world bootstrap, ticks, and the accepted skill");
assert(server.recorder.commands.length < server.recorder.commandCount, "durable server log should compact flushed commands out of hot memory");
assert(parsed.commands.length === server.recorder.commandCount, "durable log should preserve every compacted authoritative command");
assert(verified.ok, `durable authoritative world log should verify (${verified.reason ?? "no reason"})`);

ops.op_log("[js] p50_authoritative_worldlog_retention OK: authoritative server compacts hot world-log memory behind a verified durable log");
