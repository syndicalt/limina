import { ops, type Transformable } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import { SceneAuthoringAdapter } from "../src/authoring/adapters/scene.ts";
import type { AuthoringOperation, AuthoringTransaction, WorldProjectHead } from "../src/authoring/index.ts";
import {
  ACCEPT_CLOSED,
  AuthoritativeServer,
  type AuthoritativeInvocationContext,
  type NetServerTransport,
} from "../src/net/server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authority_serialization FAIL: ${message}`);
}

class CaptureTransport implements NetServerTransport {
  readonly sent: string[] = [];
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, line: string): Promise<void> { this.sent.push(line); }
  async close(_connId: number): Promise<void> {}
}

const object: Transformable = {
  position: { x: 0, y: 0, z: 0, set() {} },
  quaternion: { x: 0, y: 0, z: 0, w: 1, set() {} },
  scale: { x: 1, y: 1, z: 1, set() {} },
};

function bootstrapEntity({ world }: { world: AuthoritativeServer["world"] }): void {
  const eid = spawnRenderable(world.ecs, object, 1, 2, 3);
  world.entities.create({ eid });
}

const permissions = new Set(["authoring.read", "authoring.write", "scene.read", "ecs.modify"]);
const context: AuthoritativeInvocationContext = {
  agentId: "agt_serialization",
  sessionId: "ses_serialization",
  profile: "builder.readWrite",
  permissions,
};

function makeTransaction(head: WorldProjectHead): AuthoringTransaction {
  const operation = (position: [number, number, number]): AuthoringOperation => ({
    adapter: "scene",
    adapterVersion: "1.0.0",
    action: "transform.set",
    input: { entity: "ent_0", position },
  });
  return {
    schema: "limina.authoring-transaction/v1",
    transactionId: "tx.serialization.multi-op",
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [operation([10, 0, 0]), operation([20, 0, 0])],
  };
}

const LOG = "p_authority_serialization.jsonl";
ops.op_write_trace(LOG, "");
const transport = new CaptureTransport();
const server = new AuthoritativeServer(transport, {
  sessionId: "p_authority_serialization",
  tickMs: 1000,
  worldLog: { name: LOG },
  authoring: { projectId: "project.serialization" },
  bootstrap: bootstrapEntity,
});
await server.ready;
const headResponse = await server.invokeAuthoritatively("authoring.head", {}, context);
assert(headResponse.success, "failed to read genesis head");

let releaseFirstApply!: () => void;
const firstApplyGate = new Promise<void>((resolve) => { releaseFirstApply = resolve; });
let announceFirstApply!: () => void;
const firstApplied = new Promise<void>((resolve) => { announceFirstApply = resolve; });
let applyCount = 0;
const originalApply = SceneAuthoringAdapter.prototype.apply;
SceneAuthoringAdapter.prototype.apply = async function gatedApply(...args): Promise<void> {
  await originalApply.apply(this, args);
  applyCount += 1;
  if (applyCount === 1) {
    announceFirstApply();
    await firstApplyGate;
  }
};

const conn = {
  connId: 17,
  session: {
    agentId: context.agentId,
    sessionId: context.sessionId,
    profile: context.profile!,
    permissions,
  },
  subscribed: false,
  closing: false,
  queuedIntents: 0,
  worldlogCursor: undefined as number | undefined,
};
const internals = server as unknown as {
  conns: Map<number, typeof conn>;
  handleLine(connection: typeof conn, line: string): Promise<void>;
  doTick(): Promise<void>;
};
internals.conns.set(conn.connId, conn);

try {
  const commit = server.invokeAuthoritatively("authoring.commit", {
    transaction: makeTransaction(headResponse.result as WorldProjectHead),
  }, context);
  await firstApplied;
  const read = internals.handleLine(conn, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "scene.inspect", arguments: { sampleSize: 1 } },
  }));
  await ops.op_sleep_ms(5);
  assert(transport.sent.length === 0, "read escaped while a multi-operation commit was partially applied");
  releaseFirstApply();
  const committed = await commit;
  assert(committed.success, `multi-operation commit failed: ${JSON.stringify(committed.error)}`);
  await read;
  const readWire = JSON.parse(transport.sent[0]) as {
    result?: { result?: { sample?: Array<{ position: number[] }> } };
  };
  assert(readWire.result?.result?.sample?.[0]?.position[0] === 20,
    `serialized read did not observe the committed final state: ${transport.sent[0]}`);
} finally {
  SceneAuthoringAdapter.prototype.apply = originalApply;
}

// A JSON-RPC notification is queued and applied, but has no response id. Its
// per-connection queue accounting must still return to zero.
transport.sent.length = 0;
await internals.handleLine(conn, JSON.stringify({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "ecs.addComponent", arguments: { entity: "ent_0", component: "marker" } },
}));
assert(conn.queuedIntents === 1, "notification was not counted while queued");
await internals.doTick();
assert(conn.queuedIntents === 0, "notification did not release per-connection queue capacity");
assert(transport.sent.length === 0, "JSON-RPC notification produced a reply");

await server.shutdown();
ops.op_log("p_authority_serialization OK: reads cannot observe yielded transaction state and notifications drain without replies");
