// Phase 10 chunk C — coordinator / delegate model. A coordinator (scripted, holding
// `orchestrate` + `approval.review`) delegates TWO workers with DISTINCT, scoped
// bundles. We assert:
//   (a) each worker is bundle-scoped — exposure AND invocation (a worker holding
//       only `scene.read` is DENIED scene.createEntity, and `delegate` is hidden
//       from a worker bundle);
//   (b) a worker's MUTATING action is HELD (no world change) and surfaced;
//   (c) the coordinator GRANTS one held edit (it applies — world changes) and
//       DENIES the other (dropped, never applied);
//   (d) the causal record is intact: agent.delegated -> (worker) skill.approval.pending
//       -> granted -> executed  /  -> denied;
//   (e) determinism — running the whole scenario twice yields byte-identical traces.
//
// Mirrors p7_approval (the gate) + agent_multiturn (the bounded worker loop), with
// ScriptedProviders so the run is deterministic and headless.

import { EntityTable, ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { ScriptedProvider } from "../src/agents/llm.ts";
import type { DecideRequest } from "../src/agents/llm.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { DELEGATE_REVIEW_PROFILE, ORCHESTRATE_PERMISSION, registerOrchestrationSkills } from "../src/skills/orchestration.ts";
import { agentGrants } from "../src/agents/agent.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p10_delegate FAIL: " + msg);
}

const sceneStub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };

ops.op_physics_create_world(0);

// The two worker bundles — DISTINCT and least-privilege.
const BUNDLE_A = ["scene.read", "scene.write"]; // a scene writer
const BUNDLE_B = ["scene.read", "ecs.read", "ecs.modify"]; // an ecs writer (NO scene.write)

interface ScenarioResult {
  coordDecisionId: string;
  delA: { workerId: string; steps: number; toolCalls: number; reason: string };
  delB: { workerId: string; steps: number; toolCalls: number; reason: string };
  pendingSkills: string[];
  entitiesAfterHold: number;
  entitiesAfterResolve: number;
  workerBTagged: boolean;
  workerBDeniedWrite: boolean;
  granted: { resolved: boolean; applied: boolean };
  denied: { resolved: boolean };
  exposure: { workerASeesDelegate: boolean; workerBSeesCreate: boolean; readOnlySeesCreate: boolean };
  causal: {
    delegatedWorkerIds: string[];
    pendingActorMatchesDelegated: boolean;
    grantedLinkedToPending: boolean;
    executedLinkedToGranted: boolean;
    deniedLinkedToPending: boolean;
    delegateExecutedLinkedToDecision: boolean;
  };
  // A deterministic trace projection (id encodes seq+type+actor+payload via fnv;
  // causedBy/threadId are ids — all stable across identical runs; timestamps are
  // excluded by construction).
  traceSig: string;
}

async function runScenario(): Promise<ScenarioResult> {
  const agents = new AgentRegistry();

  // Worker A: proposes a single mutating scene.createEntity (HELD), then stops.
  const providerA = new ScriptedProvider((req: DecideRequest): MCPRequest[] =>
    req.previousResults.length === 0 ? [{ tool: "scene.createEntity", input: { position: [1, 0, 0] } }] : []);
  // Worker B: (1) tries scene.createEntity — DENIED (no scene.write in bundle);
  //           (2) proposes ecs.addComponent — HELD (ecs.modify); then stops.
  const providerB = new ScriptedProvider((req: DecideRequest): MCPRequest[] => {
    const n = req.previousResults.length;
    if (n === 0) return [{ tool: "scene.createEntity", input: { position: [2, 0, 0] } }];
    if (n === 1) return [{ tool: "ecs.addComponent", input: { entity: "ent_0", component: "review-me" } }];
    return [];
  });
  const providers = { wA: providerA, wB: providerB };

  // Wire the delegate skill (Phase 10C) through the core registration path.
  const ctx = createHeadlessContext({ scene: sceneStub, agents, coreOpts: { providers, agents }, session: "ses_coord" });
  const world = ctx.world;
  const tracer = ctx.tracer;
  const registry = ctx.registry;

  // A pre-existing entity (ent_0) for worker B to (try to) tag.
  const setup = { agentId: "engine", sessionId: "ses_coord", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  await registry.invoke("scene.createEntity", { position: [0, 0, 0] }, setup);
  const baselineEntities = world.entities.ids().length; // 1

  // NOTE: the review gate is NOT installed by the test — registerCoreSkills ->
  // registerOrchestrationSkills co-installs it. If that production wiring is missing,
  // the worker mutations below would apply un-held and the "held" assertions fail.

  const coordPerms = resolveProfile("reviewer.coordinator");
  assert(coordPerms.has(ORCHESTRATE_PERMISSION) && coordPerms.has("approval.review"), "coordinator profile missing orchestrate/approval.review");
  const coordBase = (tick: number, causedBy?: string[]) => ({
    agentId: "agt_coord", sessionId: "ses_coord", permissions: coordPerms, profile: "reviewer.coordinator", tick, world, causedBy,
  });

  // The coordinator's decision event (the cause the delegate action is audited to).
  const coordDecisionId = tracer.emit({
    type: "agent.decision.made", actorId: "agt_coord", threadId: "ses_coord",
    parentEventId: null, causedBy: [], payload: { tick: 1, kind: "decompose" },
  });

  // --- Delegate two workers with distinct bundles -------------------------
  const respA = await registry.invoke("delegate", { task: "place a marker cube", bundle: BUNDLE_A, provider: "wA", maxSteps: 4, maxToolCalls: 4, timeoutMs: 5000 }, coordBase(1, [coordDecisionId]));
  assert(respA.success, "delegate A failed: " + JSON.stringify(respA.error));
  const delA = respA.result as ScenarioResult["delA"];

  const respB = await registry.invoke("delegate", { task: "tag the target", bundle: BUNDLE_B, provider: "wB", maxSteps: 4, maxToolCalls: 4, timeoutMs: 5000 }, coordBase(2, [coordDecisionId]));
  assert(respB.success, "delegate B failed: " + JSON.stringify(respB.error));
  const delB = respB.result as ScenarioResult["delB"];

  // (b) Both workers' mutating edits are HELD — the world has NOT changed yet.
  const entitiesAfterHold = world.entities.ids().length;

  // (a) Worker B was DENIED scene.createEntity (bundle has scene.read, not scene.write).
  const workerBDeniedWrite = tracer.trace(delB.workerId).some((e) =>
    e.type === "security.permission.denied" && (e.payload as { skill?: string }).skill === "scene.createEntity");

  // (a) Exposure scoping — workers only SEE their bundle.
  const exposure = {
    workerASeesDelegate: registry.list(new Set(BUNDLE_A)).some((t) => t.name === "delegate"),
    workerBSeesCreate: registry.list(new Set(BUNDLE_B)).some((t) => t.name === "scene.createEntity"),
    readOnlySeesCreate: registry.list(new Set(["scene.read"])).some((t) => t.name === "scene.createEntity"),
  };

  // --- The coordinator reviews the held edits -----------------------------
  const listed = await registry.invoke("approval.list", {}, coordBase(3));
  assert(listed.success, "coordinator approval.list failed");
  const pending = (listed.result as { pending: { approvalId: string; skill: string; agentId: string }[] }).pending;
  const pendingSkills = pending.map((p) => p.skill).sort();

  const heldA = pending.find((p) => p.agentId === delA.workerId && p.skill === "scene.createEntity");
  const heldB = pending.find((p) => p.agentId === delB.workerId && p.skill === "ecs.addComponent");
  assert(heldA !== undefined, "worker A's scene.createEntity was not held");
  assert(heldB !== undefined, "worker B's ecs.addComponent was not held");

  // (c) GRANT worker A's edit (it applies), DENY worker B's (dropped).
  const grantRes = await registry.invoke("approval.grant", { approvalId: heldA.approvalId }, coordBase(4));
  assert(grantRes.success, "approval.grant failed");
  const granted = grantRes.result as { resolved: boolean; applied: boolean };

  const denyRes = await registry.invoke("approval.deny", { approvalId: heldB.approvalId, reason: "off-task" }, coordBase(5));
  assert(denyRes.success, "approval.deny failed");
  const denied = denyRes.result as { resolved: boolean };

  const entitiesAfterResolve = world.entities.ids().length;
  const workerBTagged = (world.tags.get(world.entities.resolve("ent_0")!.eid)?.has("review-me")) ?? false;

  // (d) Causal record.
  const coordTrace = tracer.trace("agt_coord");
  const delegatedEvents = coordTrace.filter((e) => e.type === "agent.delegated");
  const delegatedWorkerIds = delegatedEvents.map((e) => (e.payload as { workerId: string }).workerId).sort();
  const delegatedA = delegatedEvents.find((e) => (e.payload as { workerId: string }).workerId === delA.workerId);

  const pendingEvA = tracer.trace(delA.workerId).find((e) => e.type === "skill.approval.pending");
  const grantedEv = tracer.trace(delA.workerId).find((e) => e.type === "skill.approval.granted");
  const executedEvA = tracer.trace(delA.workerId).find((e) =>
    e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "scene.createEntity");
  const pendingEvB = tracer.trace(delB.workerId).find((e) => e.type === "skill.approval.pending");
  const deniedEv = tracer.trace(delB.workerId).find((e) => e.type === "skill.approval.denied");
  const delegateExecuted = coordTrace.find((e) =>
    e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "delegate");

  const causal = {
    delegatedWorkerIds,
    pendingActorMatchesDelegated: delegatedA !== undefined && pendingEvA !== undefined && pendingEvA.actorId === delA.workerId,
    grantedLinkedToPending: grantedEv !== undefined && pendingEvA !== undefined && grantedEv.causedBy.includes(pendingEvA.id),
    executedLinkedToGranted: executedEvA !== undefined && grantedEv !== undefined && executedEvA.causedBy.includes(grantedEv.id),
    deniedLinkedToPending: deniedEv !== undefined && pendingEvB !== undefined && deniedEv.causedBy.includes(pendingEvB.id),
    delegateExecutedLinkedToDecision: delegateExecuted !== undefined && delegateExecuted.causedBy.includes(coordDecisionId),
  };

  // (e) Deterministic projection of the whole durable trace.
  const traceSig = JSON.stringify(tracer.replay().events.map((e) => ({ id: e.id, t: e.type, a: e.actorId, th: e.threadId, c: e.causedBy })));

  return {
    coordDecisionId, delA, delB, pendingSkills, entitiesAfterHold, entitiesAfterResolve,
    workerBTagged, workerBDeniedWrite, granted, denied, exposure, causal, traceSig,
  };
}

// ---- Run + assert ---------------------------------------------------------
const r = await runScenario();
const baseline = 1; // ent_0 pre-created

// (a) bundle enforcement — exposure + invocation.
assert(!r.exposure.workerASeesDelegate, "worker A bundle wrongly EXPOSED the `delegate` skill");
assert(!r.exposure.workerBSeesCreate, "worker B bundle wrongly EXPOSED scene.createEntity (needs scene.write)");
assert(!r.exposure.readOnlySeesCreate, "a scene.read-only bundle wrongly EXPOSED scene.createEntity");
assert(r.workerBDeniedWrite, "worker B was NOT denied scene.createEntity despite lacking scene.write");

// (b) held -> no world change.
assert(r.entitiesAfterHold === baseline, `held edits changed the world before review (entities=${r.entitiesAfterHold}, expected ${baseline})`);
assert(r.pendingSkills.length === 2 && r.pendingSkills[0] === "ecs.addComponent" && r.pendingSkills[1] === "scene.createEntity", "expected exactly the two held mutating skills, got " + JSON.stringify(r.pendingSkills));

// (c) grant applies, deny drops.
assert(r.granted.resolved && r.granted.applied, "coordinator grant did not apply worker A's edit");
assert(r.entitiesAfterResolve === baseline + 1, `granted edit did not create the entity (entities=${r.entitiesAfterResolve})`);
assert(r.denied.resolved, "coordinator deny did not resolve");
assert(!r.workerBTagged, "denied edit was applied — worker B's tag leaked through");

// (d) causal record intact.
assert(r.causal.delegatedWorkerIds.length === 2, "expected two agent.delegated events, got " + JSON.stringify(r.causal.delegatedWorkerIds));
assert(r.causal.pendingActorMatchesDelegated, "agent.delegated does not connect to the worker's held action");
assert(r.causal.grantedLinkedToPending, "granted not linked to pending");
assert(r.causal.executedLinkedToGranted, "executed not linked to granted");
assert(r.causal.deniedLinkedToPending, "denied not linked to pending");
assert(r.causal.delegateExecutedLinkedToDecision, "delegate action not linked to the coordinator's decision");

// worker run outcomes (sanity that the bounded loop actually ran).
assert(r.delA.toolCalls === 1 && r.delA.reason === "no_tool_calls", "worker A loop unexpected: " + JSON.stringify(r.delA));
assert(r.delB.toolCalls === 2 && r.delB.reason === "no_tool_calls", "worker B loop unexpected: " + JSON.stringify(r.delB));
assert(r.delA.workerId === "agt_coord.w1" && r.delB.workerId === "agt_coord.w2", "worker ids not deterministic: " + r.delA.workerId + "," + r.delB.workerId);

// (e) determinism — a second identical run produces a byte-identical trace.
const r2 = await runScenario();
assert(r2.traceSig === r.traceSig, "re-running the scenario produced a different trace (non-deterministic)");
assert(r2.delA.workerId === r.delA.workerId && r2.delB.workerId === r.delB.workerId, "worker ids differ across runs");

// (B2) the review gate DEFAULT-HOLDS every write-class skill (not just scene/ecs/
// physics) — an arbitrary bundle's terrain/agent/ui/social/audio writes are reviewed.
{
  const gate = reviewProfileGate(new Set([DELEGATE_REVIEW_PROFILE]));
  const held = (perms: string[]): boolean =>
    gate("some.skill", { profile: DELEGATE_REVIEW_PROFILE } as never, { permissions: perms } as never);
  assert(held(["agent.write"]) && held(["terrain.generate"]) && held(["ui.write"]) && held(["social.act"]) && held(["audio.play"]),
    "the review gate must hold ALL write-class skills (agent/terrain/ui/social/audio), not just scene/ecs/physics");
  assert(!held(["scene.read"]) && !held(["scene.read", "ecs.read"]), "read-only skills must NOT be held");
}

// (B3) a worker BUNDLE may not contain escalation caps. At the DEFAULT depth budget
// (maxDepth=1, via registerCoreSkills) `approval.review` (self-approval) AND
// `orchestrate` (a depth-1 worker would spawn at depth 2, past the cap) are both denied.
{
  const agents = new AgentRegistry();
  const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene: sceneStub, camera, ops, agents };
  const registry = new SkillRegistry(new LiminaTracer("ses_b3"));
  registerCoreSkills(registry, { providers: { p: new ScriptedProvider(() => []) }, agents });
  const base = { agentId: "c", sessionId: "ses_b3", permissions: resolveProfile("reviewer.coordinator"), profile: "reviewer.coordinator", tick: 0, world };
  const escApproval = await registry.invoke("delegate", { task: "x", bundle: ["scene.read", "approval.review"], provider: "p" }, base);
  assert(!escApproval.success, "delegate with approval.review in the bundle must be REJECTED (would self-approve)");
  const escOrch = await registry.invoke("delegate", { task: "x", bundle: ["scene.read", "orchestrate"], provider: "p" }, base);
  assert(!escOrch.success, "delegate with orchestrate in the bundle must be REJECTED at the default depth cap (maxDepth=1)");
}

// (FIX 1) The cross-agent TRACE surface is gated behind `trace.read`: a scoped
// delegate worker can neither SEE nor INVOKE trace.tail / explainEvent / export, while
// an observer profile (system.readonly) carries trace.read and keeps all three.
{
  const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene: sceneStub, camera, ops };
  const registry = new SkillRegistry(new LiminaTracer("ses_traceguard"));
  registerCoreSkills(registry, { providers: { p: new ScriptedProvider(() => []) }, agents: new AgentRegistry() });
  const traceSkills = ["trace.tail", "trace.explainEvent", "trace.export"];

  // A least-privilege worker runs on its BUNDLE grants (agentGrants prefers the bundle).
  const workerGrants = agentGrants({ profile: DELEGATE_REVIEW_PROFILE, bundle: new Set(BUNDLE_A) });
  assert(!workerGrants.has("trace.read"), "a delegate.review worker bundle must NOT carry trace.read");
  for (const s of traceSkills) {
    assert(!registry.list(workerGrants).some((t) => t.name === s), `worker bundle wrongly EXPOSED ${s} (trace surface must be behind trace.read)`);
  }
  // Invocation is denied too (exposure == invocation boundary): forbidden, not pending.
  const workerBase = { agentId: "agt_coord.w1", sessionId: "ses_traceguard", permissions: workerGrants, profile: DELEGATE_REVIEW_PROFILE, tick: 0, world };
  const deniedTail = await registry.invoke("trace.tail", { limit: 10 }, workerBase);
  assert(!deniedTail.success && deniedTail.error?.code === "forbidden", "a scoped worker must be DENIED trace.tail (forbidden): " + JSON.stringify(deniedTail.error));
  const deniedExport = await registry.invoke("trace.export", { name: "leak.jsonl" }, workerBase);
  assert(!deniedExport.success && deniedExport.error?.code === "forbidden", "a scoped worker must be DENIED trace.export (no disk write): " + JSON.stringify(deniedExport.error));

  // An observer (system.readonly) carries trace.read -> sees AND invokes the surface.
  const obs = resolveProfile("system.readonly");
  assert(obs.has("trace.read"), "system.readonly must carry trace.read");
  for (const s of traceSkills) {
    assert(registry.list(obs).some((t) => t.name === s), `observer profile (system.readonly) should SEE ${s}`);
  }
  const obsTail = await registry.invoke("trace.tail", { limit: 10 }, { agentId: "agt_obs", sessionId: "ses_traceguard", permissions: obs, profile: "system.readonly", tick: 0, world });
  assert(obsTail.success, "observer trace.tail should succeed: " + JSON.stringify(obsTail.error));

  // (FINDING 1) inspector.snapshot must NOT be a trace.read BYPASS. Its `trace` block is
  // the same cross-agent surface; a caller holding the four reads but NO trace.read must
  // get a count-only stub (no actor identities, no event payloads), while a trace.read
  // holder still gets the real recent trace. (On revert to `trace: tracer.inspect()`
  // unconditionally, the four-read caller would see real events and this fails.)
  const fourReads = new Set(["scene.read", "ecs.read", "physics.read", "agent.read"]);
  assert(!fourReads.has("trace.read"), "guard: the four-reads set must not include trace.read");
  const snapNoTrace = await registry.invoke("inspector.snapshot", { limit: 5 }, { agentId: "agt_fourread", sessionId: "ses_traceguard", permissions: fourReads, profile: "system.readonly", tick: 0, world });
  assert(snapNoTrace.success, "inspector.snapshot must STAY invocable for a four-read caller (only the trace block is redacted): " + JSON.stringify(snapNoTrace.error));
  const tNo = (snapNoTrace.result as { trace: { recent: unknown[]; actors: unknown[]; eventCount: number } }).trace;
  assert(tNo.recent.length === 0 && tNo.actors.length === 0, "inspector.snapshot leaked the cross-agent trace to a caller WITHOUT trace.read (recent/actors must be empty) — trace.read bypass");
  assert(tNo.eventCount > 0, "the stub should still report a non-payload eventCount");
  const snapObs = await registry.invoke("inspector.snapshot", { limit: 5 }, { agentId: "agt_obs2", sessionId: "ses_traceguard", permissions: obs, profile: "system.readonly", tick: 0, world });
  assert(snapObs.success, "inspector.snapshot for a trace.read observer failed: " + JSON.stringify(snapObs.error));
  const tObs = (snapObs.result as { trace: { recent: unknown[]; actors: unknown[] } }).trace;
  assert(tObs.recent.length > 0 && tObs.actors.length > 0, "a trace.read holder must still get the REAL recent trace from inspector.snapshot");
}

// (FIX 2) Delegation DEPTH budget. With maxDepth=2 a depth-1 worker MAY delegate a
// leaf sub-worker, but a worker that would land at depth 2 is denied `orchestrate`;
// `approval.review` is denied at EVERY depth. (Default maxDepth=1 — blocking ALL
// nesting — is covered by the B3 block above; this proves the budget is honored.)
{
  const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene: sceneStub, camera, ops };
  const registry = new SkillRegistry(new LiminaTracer("ses_depth"));
  registerCoreSkills(registry); // core skills, but NO delegate/gate yet
  // Wire delegation with a depth budget of 2. registerOrchestrationSkills co-installs
  // the review gate; clear it so this focused test isolates the DEPTH-budget contract
  // from the orthogonal review-holding of the `delegate` call itself.
  registerOrchestrationSkills(registry, { providers: { p: new ScriptedProvider(() => []) }, agents: new AgentRegistry(), maxDepth: 2 });
  registry.clearApprovalGate();
  // delegation depth is looked up by ctx.agentId; the spawned worker id carries it forward.
  const asAgent = (agentId: string, tick: number) => ({
    agentId, sessionId: "ses_depth",
    permissions: new Set([ORCHESTRATE_PERMISSION, "scene.read"]), profile: DELEGATE_REVIEW_PROFILE, tick, world,
  });

  // depth 0 coordinator -> MAY grant a depth-1 worker `orchestrate` (childDepth 1 < 2).
  const d1 = await registry.invoke("delegate", { task: "t", bundle: ["scene.read", ORCHESTRATE_PERMISSION], provider: "p" }, asAgent("agt_coord", 0));
  assert(d1.success, "maxDepth=2: a depth-0 coordinator must be able to grant a depth-1 worker orchestrate: " + JSON.stringify(d1.error));
  const w1 = (d1.result as { workerId: string }).workerId; // depthOf=1

  // depth 1 worker -> CAN delegate a LEAF sub-worker (bundle without orchestrate).
  const d2 = await registry.invoke("delegate", { task: "t", bundle: ["scene.read"], provider: "p" }, asAgent(w1, 1));
  assert(d2.success, "maxDepth=2: a depth-1 worker must be able to delegate a leaf sub-worker: " + JSON.stringify(d2.error));

  // depth 1 worker -> may NOT grant a sub-worker that would land at depth 2 `orchestrate`.
  const d2bad = await registry.invoke("delegate", { task: "t", bundle: ["scene.read", ORCHESTRATE_PERMISSION], provider: "p" }, asAgent(w1, 1));
  assert(!d2bad.success, "maxDepth=2: orchestrate must be REJECTED for a worker that would sit at depth 2 (the cap)");

  // `approval.review` is rejected at EVERY depth (self-approval — never relaxed).
  for (const [id, depth] of [["agt_coord", 0], [w1, 1]] as const) {
    const r = await registry.invoke("delegate", { task: "t", bundle: ["scene.read", "approval.review"], provider: "p" }, asAgent(id, depth));
    assert(!r.success, `approval.review must be rejected in a worker bundle at depth ${depth}`);
  }
}

ops.op_log(
  `p10_delegate OK: coordinator delegated 2 workers (bundles [${BUNDLE_A.join(",")}] / [${BUNDLE_B.join(",")}]); ` +
  `each bundle-scoped (B denied scene.createEntity; delegate hidden from worker bundles); both mutating edits HELD ` +
  `(entities ${baseline}->${baseline}); granted A applies (entities->${r.entitiesAfterResolve}), denied B dropped (tagged=${r.workerBTagged}); ` +
  `causal tree delegated->pending->granted/executed & ->denied intact; deterministic across 2 runs.`,
);
