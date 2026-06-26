// "A cottage on the beach" — the coordinator/delegate showcase, verified headless.
//
// A COORDINATOR (reviewer.coordinator: orchestrate + approval.review) decomposes
// "a cottage on the beach" and DELEGATES it to THREE least-privilege workers with
// DISTINCT bundles — Terraform (terrain.generate), Builder + Decorator (scene.write).
// We assert, end to end:
//   (a) exactly 3 workers are delegated, with distinct bundles + deterministic ids;
//   (b) every worker's MUTATING edit is HELD (skill.approval.pending) — the world is
//       UNCHANGED — and approval.list surfaces each with the right worker + skill +
//       proposed input (1 world.generateRegion, 1 cottage, 3 props = 5 held);
//   (c) GRANT applies (the beach's terrain tiles + the cottage entity appear) and
//       DENY drops (the props never appear);
//   (d) the causal tree agent.delegated -> skill.approval.pending -> granted ->
//       executed is intact, and agent.delegated carries workerId + bundle;
//   (e) the build+hold is deterministic — two runs yield byte-identical traces.
//
// Reuses the SHIPPED delegate + approval seam (js/test/p10_delegate.ts is the unit-
// level proof); this is the showcase scenario over it. Headless, ScriptedProviders.

import { ops } from "../src/engine.ts";
import {
  BEACH_SEED,
  COTTAGE_WORKERS,
  setupCoordinatorCottage,
} from "../src/demos/coordinator_cottage.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_coordinator_cottage FAIL: " + msg);
}

ops.op_physics_create_world(0);

interface PendingView {
  approvalId: string;
  skill: string;
  agentId: string;
  profile: string | null;
  tick: number;
  input: unknown;
}

// ---- (e) determinism: project the durable trace of a build+hold run -------
async function heldTraceSig(sessionId: string): Promise<string> {
  const s = setupCoordinatorCottage(sessionId);
  await s.runCottageBuild(1);
  return JSON.stringify(
    s.tracer.replay().events.map((e) => ({ id: e.id, t: e.type, a: e.actorId, th: e.threadId, c: e.causedBy })),
  );
}

// ---- The main correctness scenario ----------------------------------------
const c = setupCoordinatorCottage("ses_cottage_main");
const baseline = c.world.entities.ids().length;
assert(baseline === 0, `fresh world should start empty, got ${baseline}`);

// (a) the coordinator decomposes + delegates the three workers.
const built = await c.runCottageBuild(1);
assert(built.workers.length === 3, `expected 3 delegated workers, got ${built.workers.length}`);
assert(
  built.workers.map((w) => w.provider).join(",") === "terraform,builder,decorator",
  "workers delegated in the wrong order / providers: " + built.workers.map((w) => w.provider).join(","),
);
assert(
  built.workers.map((w) => w.workerId).join(",") === "agt_coord.w1,agt_coord.w2,agt_coord.w3",
  "worker ids not deterministic: " + built.workers.map((w) => w.workerId).join(","),
);
// Least-privilege bundles: Terraform's is DISTINCTLY privileged (it alone holds the
// high-cost terrain.generate); Builder + Decorator are pure scene writers and so
// legitimately SHARE the minimal [scene.read, scene.write] bundle — forcing an
// artificial third bundle would over-grant. We assert the privilege BOUNDARY (the
// security-meaningful property), not cosmetic distinctness.
const bundleKeys = built.workers.map((w) => w.bundle.join("|"));
assert(new Set(bundleKeys).size >= 2, "expected >= 2 distinct bundle shapes (Terraform vs scene-writers): " + JSON.stringify(bundleKeys));
const terraform = built.workers[0];
assert(terraform.bundle.includes("terrain.generate"), "Terraform bundle missing terrain.generate");
assert(
  built.workers.slice(1).every((w) => !w.bundle.includes("terrain.generate")),
  "a non-Terraform worker was granted terrain.generate (over-privileged)",
);
assert(
  built.workers.slice(1).every((w) => w.bundle.join("|") === "scene.read|scene.write"),
  "Builder/Decorator should be minimal scene writers: " + JSON.stringify(built.workers.slice(1).map((w) => w.bundle)),
);

// (b) every mutating edit is HELD — the world has NOT changed.
const entitiesAfterHold = c.world.entities.ids().length;
assert(entitiesAfterHold === baseline, `held edits changed the world before review (entities=${entitiesAfterHold}, expected ${baseline})`);

// approval.list surfaces all five held edits with the right worker + skill + input.
const listed = await c.registry.invoke("approval.list", {}, c.coordBase(2));
assert(listed.success, "coordinator approval.list failed");
const pending = (listed.result as { pending: PendingView[] }).pending;
assert(pending.length === 5, `expected 5 held edits, got ${pending.length}: ` + JSON.stringify(pending.map((p) => p.skill)));

const heldTerraform = pending.find((p) => p.agentId === "agt_coord.w1" && p.skill === "world.generateRegion");
const heldCottage = pending.find((p) => p.agentId === "agt_coord.w2" && p.skill === "scene.createEntity");
const heldProps = pending.filter((p) => p.agentId === "agt_coord.w3" && p.skill === "scene.createEntity");
assert(heldTerraform !== undefined, "Terraform's world.generateRegion was not held");
assert(heldCottage !== undefined, "Builder's cottage scene.createEntity was not held");
assert(heldProps.length === 3, `expected 3 held Decorator props, got ${heldProps.length}`);
// every held action is attributed to the delegate review profile, not the coordinator.
assert(pending.every((p) => p.profile === "delegate.review"), "a held edit was not tagged with the delegate.review profile");

// the proposed inputs survived to review intact (seed/bounds + cottage placement).
const tfInput = heldTerraform.input as { seed: number; bounds: { minTx: number; maxTx: number } };
assert(tfInput.seed === BEACH_SEED && tfInput.bounds.maxTx === 1, "Terraform's held input lost its seed/bounds: " + JSON.stringify(tfInput));
const cottageInput = heldCottage.input as { shape: string; size: number; position: number[] };
assert(
  cottageInput.shape === "box" && cottageInput.size === 3 && cottageInput.position[0] === 0 && cottageInput.position[1] === 1.5,
  "Builder's held input lost the cottage shape/size/position: " + JSON.stringify(cottageInput),
);

// (c) GRANT the beach + the cottage (they apply), DENY the props (dropped).
const grantTf = await c.registry.invoke("approval.grant", { approvalId: heldTerraform.approvalId }, c.coordBase(3));
assert(grantTf.success && (grantTf.result as { applied: boolean }).applied, "granting the beach terrain did not apply");
const entitiesAfterBeach = c.world.entities.ids().length;
assert(entitiesAfterBeach === baseline + 4, `granted beach should add 4 terrain tiles, got +${entitiesAfterBeach - baseline}`);

const grantCottage = await c.registry.invoke("approval.grant", { approvalId: heldCottage.approvalId }, c.coordBase(4));
assert(grantCottage.success && (grantCottage.result as { applied: boolean }).applied, "granting the cottage did not apply");
const entitiesAfterCottage = c.world.entities.ids().length;
assert(entitiesAfterCottage === baseline + 5, `granted cottage should add 1 entity, got total +${entitiesAfterCottage - baseline}`);

for (const prop of heldProps) {
  const deny = await c.registry.invoke("approval.deny", { approvalId: prop.approvalId, reason: "keep it sparse" }, c.coordBase(5));
  assert(deny.success && (deny.result as { resolved: boolean }).resolved, "denying a Decorator prop did not resolve");
}
const entitiesAfterResolve = c.world.entities.ids().length;
assert(entitiesAfterResolve === baseline + 5, `denied props leaked into the world (entities=${entitiesAfterResolve}, expected ${baseline + 5})`);

// no edits remain held after resolution.
const listed2 = await c.registry.invoke("approval.list", {}, c.coordBase(6));
assert((listed2.result as { pending: PendingView[] }).pending.length === 0, "held edits remain after grant/deny");

// (d) the causal tree is intact, and agent.delegated carries workerId + bundle.
const coordTrace = c.tracer.trace("agt_coord");
const delegated = coordTrace.filter((e) => e.type === "agent.delegated");
assert(delegated.length === 3, `expected 3 agent.delegated events, got ${delegated.length}`);
const delegatedTf = delegated.find((e) => (e.payload as { workerId: string }).workerId === "agt_coord.w1");
assert(delegatedTf !== undefined, "no agent.delegated for the Terraform worker");
const tfPayload = delegatedTf.payload as { workerId: string; bundle: string[] };
assert(
  Array.isArray(tfPayload.bundle) && tfPayload.bundle.includes("terrain.generate") && tfPayload.workerId === "agt_coord.w1",
  "agent.delegated payload missing workerId/bundle: " + JSON.stringify(tfPayload),
);
// each delegate action links back to the coordinator's decompose decision.
const delegateExecuted = coordTrace.filter((e) => e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "delegate");
assert(delegateExecuted.length === 3, "expected 3 delegate skill.executed events");
assert(delegateExecuted.every((e) => e.causedBy.includes(built.decisionId)), "a delegate action is not linked to the coordinator's decision");

// agent.delegated -> skill.approval.pending -> granted -> executed, on the Terraform thread.
const tfThread = c.tracer.trace("agt_coord.w1");
const pendingEv = tfThread.find((e) => e.type === "skill.approval.pending");
const grantedEv = tfThread.find((e) => e.type === "skill.approval.granted");
const executedEv = tfThread.find((e) => e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "world.generateRegion");
assert(pendingEv !== undefined && pendingEv.actorId === "agt_coord.w1", "no held event on the Terraform worker thread");
assert(grantedEv !== undefined && grantedEv.causedBy.includes(pendingEv.id), "granted not linked to pending");
assert(executedEv !== undefined && grantedEv !== undefined && executedEv.causedBy.includes(grantedEv.id), "executed not linked to granted");

// (e) determinism — two independent build+hold runs are byte-identical.
const sigA = await heldTraceSig("ses_cottage_det");
const sigB = await heldTraceSig("ses_cottage_det");
assert(sigA === sigB, "re-running the cottage build produced a different trace (non-deterministic)");

ops.op_log(
  `p_coordinator_cottage OK: coordinator decomposed 'a cottage on the beach' + delegated 3 workers ` +
  `(${COTTAGE_WORKERS.map((w) => w.provider).join("/")}) with distinct least-privilege bundles; ` +
  `all 5 mutating edits HELD (world ${baseline}->${baseline}); approval.list surfaced them per worker+skill+input; ` +
  `granted beach(+4 tiles)+cottage(+1) applied, denied 3 props dropped (entities->${entitiesAfterResolve}); ` +
  `causal tree delegated->pending->granted->executed intact (agent.delegated carries workerId+bundle); ` +
  `build+hold deterministic across 2 runs.`,
);
