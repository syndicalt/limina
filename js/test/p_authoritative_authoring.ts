import { ops, type Transformable } from "../src/engine.ts";
import { Position, spawnRenderable } from "../src/ecs/world.ts";
import {
  ACCEPT_CLOSED,
  AuthoritativeServer,
  type AuthoritativeInvocationContext,
  type NetServerTransport,
} from "../src/net/server.ts";
import { SceneAuthoringAdapter } from "../src/authoring/adapters/scene.ts";
import { canonicalHash, type AuthoringTransaction, type WorldProjectHead } from "../src/authoring/index.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoritative_authoring FAIL: ${message}`);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

const object: Transformable = {
  position: { x: 0, y: 0, z: 0, set() {} },
  quaternion: { x: 0, y: 0, z: 0, w: 1, set() {} },
  scale: { x: 1, y: 1, z: 1, set() {} },
};

function bootstrapEntity({ world }: { world: AuthoritativeServer["world"] }): void {
  const eid = spawnRenderable(world.ecs, object, 1, 2, 3);
  const entity = world.entities.create({ eid });
  assert(entity === "ent_0", `deterministic bootstrap entity changed to ${entity}`);
}

const projectId = "project.authoritative-server";
const context: AuthoritativeInvocationContext = {
  agentId: "agt_authoritative_authoring",
  sessionId: "ses_authoritative_authoring",
  profile: "builder.readWrite",
  permissions: new Set(["authoring.read", "authoring.write", "ecs.modify", "scene.read"]),
  causedBy: ["evt_chat_decision"],
};

function transaction(
  transactionId: string,
  head: WorldProjectHead,
  position: [number, number, number],
  overrides: Partial<AuthoringTransaction> = {},
): AuthoringTransaction {
  return {
    schema: "limina.authoring-transaction/v1",
    transactionId,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [{
      adapter: "scene",
      adapterVersion: "1.0.0",
      action: "transform.set",
      input: { entity: "ent_0", position },
    }],
    ...overrides,
  };
}

async function head(server: AuthoritativeServer): Promise<WorldProjectHead> {
  const response = await server.invokeAuthoritatively("authoring.head", {}, context);
  assert(response.success, `authoring.head failed: ${JSON.stringify(response.error)}`);
  return response.result as WorldProjectHead;
}

function server(logName: string): AuthoritativeServer {
  return new AuthoritativeServer(new IdleTransport(), {
    sessionId: "p_authoritative_authoring",
    tickMs: 1000,
    worldLog: { name: logName },
    authoring: { projectId },
    bootstrap: bootstrapEntity,
  });
}

let rejectedEphemeral = false;
try {
  new AuthoritativeServer(new IdleTransport(), {
    sessionId: "p_authoritative_authoring_ephemeral",
    authoring: { projectId },
  });
} catch (error) {
  rejectedEphemeral = error instanceof Error && error.message.includes("requires a durable worldLog");
}
assert(rejectedEphemeral, "authoring was allowed without a durable WorldLog");

const LOG = "p_authoritative_authoring.jsonl";
ops.op_write_trace(LOG, "");
const first = server(LOG);
await first.ready;
const genesis = await head(first);
assert(genesis.projectId === projectId && genesis.revision === 0, "server exposed the wrong project genesis");

const appendEvents: string[] = [];
const originalAppend = ops.op_append_trace;
ops.op_append_trace = (name: string, content: string): void => {
  if (name === LOG) appendEvents.push("append");
  originalAppend(name, content);
};
const firstTx = transaction("tx.authoritative.first", genesis, [9, 8, 7]);
const firstCommit = first.invokeAuthoritatively("authoring.commit", { transaction: firstTx }, context);
void firstCommit.then(() => appendEvents.push("resolved"));
const firstResponse = await firstCommit;
ops.op_append_trace = originalAppend;
assert(firstResponse.success, `first commit failed: ${JSON.stringify(firstResponse.error)}`);
assert(appendEvents.join(",") === "append,resolved", `commit resolved before durable append: ${appendEvents}`);
const committedEvent = first.registry.tracer.trace(context.agentId).find((event) =>
  event.type === "skill.executed" &&
  (event.payload as { skill?: string }).skill === "authoring.commit"
);
assert(committedEvent?.causedBy.includes("evt_chat_decision"), "co-located executor dropped causal provenance");
assert(Position.x[first.world.entities.resolve("ent_0")!.eid] === 9, "committed transform was not applied");
const afterFirst = first.authoring!.kernel.head;
assert(afterFirst.revision === 1, "committed transaction did not advance the head");
const countAfterFirst = parseWorldLog(ops.op_read_trace(LOG)).commands.length;

const retry = await first.invokeAuthoritatively("authoring.commit", { transaction: firstTx }, context);
assert(retry.success && !(retry.result as { committed: boolean }).committed, "identical retry was not idempotent");
assert(parseWorldLog(ops.op_read_trace(LOG)).commands.length === countAfterFirst, "retry duplicated the WorldLog command");

const staleBase = first.authoring!.kernel.head;
const staleA = transaction("tx.authoritative.stale-a", staleBase, [4, 5, 6]);
const staleB = transaction("tx.authoritative.stale-b", staleBase, [7, 7, 7]);
const [staleResultA, staleResultB] = await Promise.all([
  first.invokeAuthoritatively("authoring.commit", { transaction: staleA }, context),
  first.invokeAuthoritatively("authoring.commit", { transaction: staleB }, context),
]);
assert(staleResultA.success, "first concurrent writer did not commit");
assert(!staleResultB.success && staleResultB.error?.code === "conflict", "stale concurrent writer did not receive conflict");

const beforeWrongProject = first.authoring!.kernel.head;
const wrongProject = await first.invokeAuthoritatively("authoring.commit", {
  transaction: transaction("tx.authoritative.wrong-project", beforeWrongProject, [0, 0, 0], { projectId: "project.other" }),
}, context);
assert(!wrongProject.success && wrongProject.error?.code === "invalid_input", "wrong-project transaction did not fail closed");
assert(first.authoring!.kernel.head.headHash === beforeWrongProject.headHash, "wrong-project transaction changed the head");

const durableHead = first.authoring!.kernel.head;
await first.shutdown();
const reboot = server(LOG);
await reboot.ready;
assert(reboot.authoring!.kernel.head.headHash === durableHead.headHash, "restart reconstructed a different authoring head");
assert(reboot.authoring!.kernel.head.revision === durableHead.revision, "restart reconstructed a different revision");
assert(Position.x[reboot.world.entities.resolve("ent_0")!.eid] === 4, "restart reconstructed different scene state");
await reboot.shutdown();

// Adapter semantic drift must stop recovery. Altering the version also invalidates
// the pinned transaction hash, so replay cannot silently reinterpret old commands.
const DRIFT_LOG = "p_authoritative_authoring_version_drift.jsonl";
const drifted = ops.op_read_trace(LOG).replace('"adapterVersion":"1.0.0"', '"adapterVersion":"9.0.0"');
assert(drifted !== ops.op_read_trace(LOG), "fixture had no adapter version to alter");
ops.op_write_trace(DRIFT_LOG, drifted);
const drift = server(DRIFT_LOG);
const driftPending = drift.invokeAuthoritatively("authoring.head", {}, context);
let driftRejected = false;
try {
  await drift.ready;
} catch (error) {
  driftRejected = error instanceof Error && error.message.includes("authoring.commit failed");
}
assert(driftRejected, "version-drifted durable command did not reject recovery");
const driftResponse = await Promise.race([
  driftPending,
  ops.op_sleep_ms(100).then(() => undefined),
]);
assert(driftResponse !== undefined && !driftResponse.success,
  "standalone invocation did not resolve when durable rehydrate rejected");
await drift.shutdown();

// A committed in-memory transaction is not authority until its WorldLog append
// succeeds. Failure hides the advanced kernel and close must not retry it.
const APPEND_FAIL_LOG = "p_authoritative_authoring_append_failure.jsonl";
ops.op_write_trace(APPEND_FAIL_LOG, "");
const appendFailed = server(APPEND_FAIL_LOG);
await appendFailed.ready;
const appendFailGenesis = await head(appendFailed);
const beforeAppendFailDisk = ops.op_read_trace(APPEND_FAIL_LOG);
ops.op_append_trace = (name: string, content: string): void => {
  if (name === APPEND_FAIL_LOG) throw new Error("injected authoring append failure");
  originalAppend(name, content);
};
try {
  const failedCommit = await appendFailed.invokeAuthoritatively("authoring.commit", {
    transaction: transaction("tx.authoritative.append-failure", appendFailGenesis, [30, 0, 0]),
  }, context);
  assert(!failedCommit.success && failedCommit.error?.message.includes("could not be persisted"),
    "failed authoring append produced a success or ambiguous error");
  assert(appendFailed.authoring!.kernel.head.revision === 1, "fixture did not reach the in-memory partial-commit state");
  const hiddenAfterAppend = await appendFailed.invokeAuthoritatively("authoring.head", {}, context);
  assert(!hiddenAfterAppend.success, "append-poisoned server exposed its in-memory head");
  assert(ops.op_read_trace(APPEND_FAIL_LOG) === beforeAppendFailDisk, "failed append changed the durable prefix");
} finally {
  ops.op_append_trace = originalAppend;
  await appendFailed.shutdown();
}
assert(ops.op_read_trace(APPEND_FAIL_LOG) === beforeAppendFailDisk, "append-poisoned close retried dirty data");

// An incomplete rollback is a process-wide authority failure. A failed close may
// not append a trailer or retry the dirty suffix.
const POISON_LOG = "p_authoritative_authoring_rollback_poison.jsonl";
ops.op_write_trace(POISON_LOG, "");
const poisoned = server(POISON_LOG);
await poisoned.ready;
const poisonGenesis = await head(poisoned);
const beforePoisonDisk = ops.op_read_trace(POISON_LOG);
const originalRollback = SceneAuthoringAdapter.prototype.rollback;
SceneAuthoringAdapter.prototype.rollback = async function injectedRollbackFailure(): Promise<void> {
  throw new Error("injected rollback failure");
};
try {
  const poisonTx = transaction("tx.authoritative.poison", poisonGenesis, [100, 0, 0]);
  const poisonEid = poisoned.world.entities.resolve("ent_0")!.eid;
  const beforeHash = canonicalHash((input) => ops.op_sha256(input), {
    kind: "transform",
    states: [{
      entity: "ent_0",
      eid: poisonEid,
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }],
  });
  poisonTx.operations[0].guard = { beforeHash, afterHash: `sha256:${"f".repeat(64)}` };
  const [earlierResult, poisonResult] = await Promise.all([
    poisoned.invokeAuthoritatively("ecs.addComponent", { entity: "ent_0", component: "marker" }, context),
    poisoned.invokeAuthoritatively("authoring.commit", { transaction: poisonTx }, context),
  ]);
  assert(!earlierResult.success, "earlier successful intent in the poisoned batch was acknowledged");
  assert(!poisonResult.success && poisonResult.error?.code === "handler_error", "rollback poison returned a normal domain error");
  assert(poisoned.authoring!.kernel.poisoned, "kernel did not retain rollback poison");
  const hiddenHead = await poisoned.invokeAuthoritatively("authoring.head", {}, context);
  assert(!hiddenHead.success, "poisoned server exposed its in-memory head");
  assert(ops.op_read_trace(POISON_LOG) === beforePoisonDisk, "poisoned recorder suffix reached durable storage");
} finally {
  SceneAuthoringAdapter.prototype.rollback = originalRollback;
  await poisoned.shutdown();
}
assert(ops.op_read_trace(POISON_LOG) === beforePoisonDisk, "poisoned close appended or retried durable data");

ops.op_log("p_authoritative_authoring OK: durable project transactions, replay, idempotency, conflicts, project isolation, version pinning, and fail-stop rollback poison");
