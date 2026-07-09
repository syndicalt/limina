import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { registerAuthoringSkills, type AuthoringTransaction } from "../src/authoring/index.ts";
import { SceneAuthoringAdapter } from "../src/authoring/adapters/scene.ts";
import { StaticAuthoringAdapterAllowlist } from "../src/authoring/adapter.ts";
import { Position } from "../src/ecs/world.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_skills: ${message}`);
}

const PROJECT_ID = "project.authoring-skills";

async function setup(session: string) {
  const context = createHeadlessContext({ session });
  const created = await context.registry.invoke("scene.createEntity", {
    shape: "box",
    position: [1, 2, 3],
  }, context.base);
  assert(created.success, "failed to seed the bodyless scene entity");
  const entity = (created.result as { entity: string }).entity;
  const recorder = new WorldRecorder(session);
  recorder.attach(context.registry);
  const adapter = new SceneAuthoringAdapter({ world: context.world });
  const runtime = registerAuthoringSkills(context.registry, {
    projectId: PROJECT_ID,
    sha256: (canonical) => context.world.ops.op_sha256(canonical),
    adapters: new StaticAuthoringAdapterAllowlist([adapter]),
  });
  const base = {
    ...context.base,
    permissions: new Set(["authoring.read", "authoring.write"]),
  };
  return { ...context, entity, recorder, runtime, base };
}

function transaction(
  id: string,
  head: { projectId: string; revision: number; headHash: `sha256:${string}` },
  entity: string,
): AuthoringTransaction {
  return {
    schema: "limina.authoring-transaction/v1",
    transactionId: id,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [{
      adapter: "scene",
      adapterVersion: "1.0.0",
      action: "transform.set",
      input: { entity, position: [9, 8, 7] },
    }],
  };
}

const live = await setup("ses_authoring_skills_live");
const headResponse = await live.registry.invoke("authoring.head", {}, live.base);
assert(headResponse.success, "authoring.head failed for an authorized reader");
const genesis = headResponse.result as typeof live.runtime.kernel.head;
const tx = transaction("tx.skill.commit", genesis, live.entity);
const committed = await live.registry.invoke("authoring.commit", { transaction: tx }, live.base);
assert(committed.success && (committed.result as { committed: boolean }).committed, "new transaction did not commit");
assert(Position.x[live.world.entities.resolve(live.entity)!.eid] === 9, "scene adapter mutation did not apply");
assert(live.runtime.kernel.head.revision === 1, "successful skill did not advance the project head");
assert(live.recorder.commandCount === 1, "new transaction was not recorded exactly once");

const command = live.recorder.commandAt(0);
assert(command?.kind === "skill" && command.tool === "authoring.commit", "recorded command is not authoring.commit");
const recordedInput = command.input as { transaction: AuthoringTransaction; commitRecord?: unknown };
assert(recordedInput.commitRecord !== undefined, "recorder did not pin the committed receipt/head envelope");

const retry = await live.registry.invoke("authoring.commit", { transaction: tx }, live.base);
assert(retry.success && !(retry.result as { committed: boolean }).committed, "identical retry was not idempotent");
assert(live.recorder.commandCount === 1, "idempotent retry duplicated the authoritative world log");

const stale = await live.registry.invoke("authoring.commit", {
  transaction: { ...tx, transactionId: "tx.skill.stale" },
}, live.base);
assert(!stale.success && stale.error?.code === "conflict", "stale project head did not return an actionable conflict");
assert(live.recorder.commandCount === 1, "failed stale transaction remained recorded");

const denied = await live.registry.invoke("authoring.commit", { transaction: tx }, {
  ...live.base,
  permissions: new Set(["authoring.read"]),
});
assert(!denied.success && denied.error?.code === "forbidden", "authoring.write permission was not enforced");

const replay = await setup("ses_authoring_skills_replay");
const replayed = await replay.registry.invoke("authoring.commit", recordedInput, replay.base);
assert(replayed.success && (replayed.result as { committed: boolean }).committed, "recorded transaction did not replay");
assert(replay.runtime.kernel.head.headHash === live.runtime.kernel.head.headHash, "replay reconstructed a different project head");
assert(Position.x[replay.world.entities.resolve(replay.entity)!.eid] === 9, "replay reconstructed different scene state");

const tampered = JSON.parse(JSON.stringify(recordedInput)) as {
  transaction: AuthoringTransaction;
  commitRecord: { receipt: { headHash: string } };
};
tampered.commitRecord.receipt.headHash = `sha256:${"f".repeat(64)}`;
const corruptSetup = await setup("ses_authoring_skills_corrupt");
const corrupt = await corruptSetup.registry.invoke("authoring.commit", tampered, corruptSetup.base);
assert(!corrupt.success && corrupt.error?.code === "handler_error", "tampered replay envelope did not fail closed");

ops.op_log("p_authoring_skills OK: permissioned commit/head, receipt pinning, idempotent filtering, conflict mapping, and replay verification");
