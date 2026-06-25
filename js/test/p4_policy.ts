// M7 — dynamic policy engine at the non-bypassable boundaries (headless, REAL,
// falsifiable). Proves the M7 acceptance end to end:
//
//   (a) a CONTEXT-DEPENDENT decision enforced at the boundary: the SAME capability
//       (ecs.updateComponent) is ALLOWED under a builder context and DENIED under a
//       player context — the profile is a policy input, not a static gate;
//   (b) a QUOTA: the N+1th call in a window is DENIED + audited (rule quota.exceeded);
//   (c) REVOCATION mid-session: the next call after revoke is DENIED + audited (rule
//       revoked);
//   (d) BYPASS: an untrusted agent cannot reach a mutating capability except through
//       the policy-checked registry boundary — a forbidden crossing is denied with
//       ZERO side effect, no host/engine handle is reachable from inside the sandbox,
//       and the ONLY working mutation path is a policy-ALLOWED crossing;
//   (e) SESSION ADMISSION over a REAL socket: a revoked session is denied at
//       initialize (boundary #3);
//   (f) the PACKAGE-LOAD hook (boundary #4, for M9): a capability over-claim and a
//       revoked package are denied + audited.
//
// FALSIFIABILITY (the binding anti-hack clause): the quota scenario is re-run with
// the policy stubbed to ALWAYS-ALLOW and the N+1th call is shown to succeed —
// proving the real engine's denial is what makes (b) load-bearing. Likewise (a),
// (c), (e), (f) assert real denials that a no-op policy would let through.

import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { PolicyEngine, type PolicyContext, type PolicyDecision } from "../src/policy/engine.ts";
import { SandboxedSkillHost } from "../src/sandbox/host.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient } from "../src/net/client.ts";
import type { NetOps } from "../src/net/protocol.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return key in record ? record[key] : undefined;
}

// ---- Engine wiring (headless: stub scene, real bitECS + Rapier + tracer) ----
const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };
ops.op_physics_create_world(0);
ops.op_physics_add_ground(-50);

const tracer = new LiminaTracer("ses_policy");
const engine = new PolicyEngine();
const registry = new SkillRegistry(tracer, engine);
registerCoreSkills(registry);

function base(agentId: string, sessionId: string, profile: string, tick: number) {
  return { agentId, sessionId, profile, permissions: resolveProfile(profile), tick, world };
}

// ===========================================================================
// (a) CONTEXT-DEPENDENT decision: same cap, allowed in one context, denied in another.
// ===========================================================================
const ent = field(ok(await registry.invoke("scene.createEntity", { position: [0, 0, 0], dynamic: true }, base("agt_b", "ses_b", "builder.readWrite", 1))), "entity");
assert(typeof ent === "string", "setup: builder created an entity");
const entId: string = typeof ent === "string" ? ent : "";

const allowRes = await registry.invoke("ecs.updateComponent", { entity: entId, component: "position", value: [1, 0, 0] }, base("agt_b", "ses_b", "builder.readWrite", 1));
assert(allowRes.success, "builder.readWrite context: ecs.updateComponent must be ALLOWED");
const denyRes = await registry.invoke("ecs.updateComponent", { entity: entId, component: "position", value: [2, 0, 0] }, base("agt_p", "ses_p", "player.limited", 1));
assert(!denyRes.success && denyRes.error?.code === "forbidden", "player.limited context: the SAME cap must be DENIED");

const allowEvt = tracer.trace("agt_b").find((e) => e.type === "policy.decision" && field(e.payload, "cap") === "ecs.updateComponent");
assert(allowEvt !== undefined && field(allowEvt.payload, "allow") === true && field(allowEvt.payload, "rule") === "profile.grant", "the ALLOW is audited as policy.decision rule=profile.grant");
const denyEvt = tracer.trace("agt_p").find((e) => e.type === "policy.denied" && field(e.payload, "cap") === "ecs.updateComponent");
assert(denyEvt !== undefined && field(denyEvt.payload, "rule") === "profile.denied", "the DENY is audited as policy.denied rule=profile.denied");
ops.op_log("  (a) context-dependent: ecs.updateComponent allowed under builder, DENIED under player; both audited");

// ===========================================================================
// (b) QUOTA: limit 3 per window -> the 4th call is DENIED + audited.
// ===========================================================================
const quotaSession = "ses_quota";
engine.setQuota({ cap: "physics.applyImpulse", perSession: true, limit: 3, windowMs: 60_000 });
const ball = field(ok(await registry.invoke("scene.createEntity", { position: [0, 5, 0], dynamic: true }, base("agt_setup", "ses_setup", "builder.readWrite", 2))), "entity");
const ballId: string = typeof ball === "string" ? ball : "";
for (let i = 1; i <= 3; i++) {
  const r = await registry.invoke("physics.applyImpulse", { entity: ballId, impulse: [1, 0, 0] }, base("agt_q", quotaSession, "player.limited", 2));
  assert(r.success, `impulse ${i}/3 within the quota window must be allowed`);
}
const over = await registry.invoke("physics.applyImpulse", { entity: ballId, impulse: [1, 0, 0] }, base("agt_q", quotaSession, "player.limited", 2));
assert(!over.success && over.error?.code === "forbidden", "the 4th (N+1th) call must be DENIED by the quota");
const qDeny = tracer.trace("agt_q").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "quota.exceeded");
assert(qDeny !== undefined, "the quota denial must be audited with rule quota.exceeded");
const qState = field(qDeny.payload, "quota");
assert(typeof field(qState, "used") === "number" && (field(qState, "used") as number) >= (field(qState, "limit") as number), "the audited quota snapshot shows exhaustion (used >= limit)");
ops.op_log("  (b) quota: 3 allowed, 4th DENIED (quota.exceeded) + audited with the live quota snapshot");

// ===========================================================================
// (c) REVOCATION mid-session: revoke a cap, the next call is DENIED + audited.
// ===========================================================================
const revSession = "ses_rev";
const rEnt = field(ok(await registry.invoke("scene.createEntity", { position: [3, 0, 0], dynamic: false }, base("agt_r", revSession, "builder.readWrite", 3))), "entity");
const rEntId: string = typeof rEnt === "string" ? rEnt : "";
const preRevoke = await registry.invoke("ecs.updateComponent", { entity: rEntId, component: "position", value: [4, 0, 0] }, base("agt_r", revSession, "builder.readWrite", 3));
assert(preRevoke.success, "pre-revoke: ecs.updateComponent allowed for the builder session");
engine.revoke(revSession, "ecs.updateComponent");
const postRevoke = await registry.invoke("ecs.updateComponent", { entity: rEntId, component: "position", value: [5, 0, 0] }, base("agt_r", revSession, "builder.readWrite", 3));
assert(!postRevoke.success && postRevoke.error?.code === "forbidden", "post-revoke: the next call to the revoked cap must be DENIED");
const revDeny = tracer.trace("agt_r").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "revoked");
assert(revDeny !== undefined, "the revocation denial must be audited with rule revoked");
ops.op_log("  (c) revocation: allowed before revoke, DENIED on the next call after revoke; audited (rule=revoked)");

// ===========================================================================
// (c2) RESOURCE BUDGET (calls): a per-session call budget denies once spent.
// ===========================================================================
const budgetSession = "ses_budget";
engine.setBudget(budgetSession, { calls: 2 });
const bEnt = field(ok(await registry.invoke("scene.createEntity", { position: [6, 0, 0], dynamic: false }, base("agt_bud", "ses_setup", "builder.readWrite", 4))), "entity");
const bEntId: string = typeof bEnt === "string" ? bEnt : "";
for (let i = 1; i <= 2; i++) {
  const r = await registry.invoke("ecs.updateComponent", { entity: bEntId, component: "position", value: [i, 0, 0] }, base("agt_bud", budgetSession, "builder.readWrite", 4));
  assert(r.success, `budgeted call ${i}/2 must be allowed`);
}
const overBudget = await registry.invoke("ecs.updateComponent", { entity: bEntId, component: "position", value: [9, 0, 0] }, base("agt_bud", budgetSession, "builder.readWrite", 4));
assert(!overBudget.success && overBudget.error?.code === "forbidden", "the call past the session budget must be DENIED");
const budgetDeny = tracer.trace("agt_bud").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "budget.calls");
assert(budgetDeny !== undefined, "the budget denial must be audited with rule budget.calls");
ops.op_log("  (c2) resource budget: 2 calls allowed, the next DENIED (budget.calls) + audited");

// ===========================================================================
// (d) BYPASS: the ONLY path to a mutating cap is the policy-checked boundary.
// ===========================================================================
const host = new SandboxedSkillHost(registry, tracer, engine);
const EVIL = `
globalThis.decide = function () {
  // (1) a forbidden mutating cap (player lacks scene.write) -> denied at the policy boundary.
  host.invoke("scene.createEntity", JSON.stringify({ position: [7, 0, 0], dynamic: true }));
  // (2) BYPASS attempt: try to grab the host/engine/ops/registry directly. All must be unreachable.
  return JSON.stringify({
    ops: typeof ops,
    registry: typeof registry,
    engine: typeof engine,
    Deno: typeof Deno,
    require: typeof require,
  });
};`;
host.create({ agentId: "agt_evil", sessionId: "ses_evil", profile: "player.limited", code: EVIL });
const evilPerc = { selfId: "agt_evil", nearby: [], position: [0, 0, 0], recentEvents: [], tick: 4 };
const entBeforeBypass = world.entities.ids().length;
const evil = await host.runDecision("agt_evil", { perception: evilPerc, world, tick: 4 });
const entAfterBypass = world.entities.ids().length;
assert(evil.executed === 0 && evil.denied >= 1, "the forbidden mutating crossing must be DENIED at the policy boundary");
assert(entAfterBypass === entBeforeBypass, "the denied crossing must have ZERO side effect (no entity created via a bypass)");

const probe = host.produceCalls("agt_evil", evilPerc);
const report = JSON.parse(probe.value ?? "{}");
assert(field(report, "ops") === "undefined" && field(report, "registry") === "undefined" && field(report, "engine") === "undefined", "no host/engine/registry handle is reachable from inside the sandbox (no bypass path)");
assert(field(report, "Deno") === "undefined" && field(report, "require") === "undefined", "no privileged global is reachable either (M6 containment holds under M7)");

const evilPolicyDeny = tracer.trace("agt_evil").find((e) => e.type === "policy.denied" && field(e.payload, "cap") === "scene.createEntity");
assert(evilPolicyDeny !== undefined && field(evilPolicyDeny.payload, "rule") === "profile.denied", "the sandbox forbidden crossing is audited as policy.denied at the registry boundary");

// The ONLY working mutation path: a policy-ALLOWED crossing through the registry.
const GOOD = `globalThis.decide = function () { host.invoke("scene.createEntity", JSON.stringify({ position: [8, 0, 0], dynamic: false })); return "ok"; };`;
host.create({ agentId: "agt_good", sessionId: "ses_good", profile: "builder.readWrite", code: GOOD });
const goodPerc = { selfId: "agt_good", nearby: [], position: [0, 0, 0], recentEvents: [], tick: 4 };
const eb = world.entities.ids().length;
const good = await host.runDecision("agt_good", { perception: goodPerc, world, tick: 4 });
const ea = world.entities.ids().length;
assert(good.executed === 1 && ea === eb + 1, "the only working mutation path is a policy-ALLOWED crossing through SkillRegistry.invoke");
ops.op_log("  (d) bypass: forbidden crossing denied (zero effect), no host/engine handle reachable; the only working path is the policy-allowed boundary");

// ===========================================================================
// (d2) RESOURCE BUDGET (CPU) tied to the M6 sandbox knob: each decision burns its
//      CPU deadline; once the session's CPU budget is spent, the next crossing is denied.
// ===========================================================================
const cpuSession = "ses_cpu";
engine.setBudget(cpuSession, { cpuMs: 30 });
const CPU_DECIDE = `globalThis.decide = function () { host.invoke("scene.createEntity", JSON.stringify({ position: [0, 12, 0], dynamic: false })); return "ok"; };`;
host.create({ agentId: "agt_cpu", sessionId: cpuSession, profile: "builder.readWrite", code: CPU_DECIDE }, { cpuDeadlineMs: 20 });
const cpuPerc = { selfId: "agt_cpu", nearby: [], position: [0, 0, 0], recentEvents: [], tick: 5 };
const cpu1 = await host.runDecision("agt_cpu", { perception: cpuPerc, world, tick: 5 }); // charges 20 -> 20 < 30 -> allow
assert(cpu1.executed === 1, "CPU budget: the first sandbox decision (within budget) executes its crossing");
const cpu2 = await host.runDecision("agt_cpu", { perception: cpuPerc, world, tick: 5 }); // charges 20 -> 40 >= 30 -> deny
assert(cpu2.executed === 0 && cpu2.denied >= 1, "CPU budget tied to the sandbox deadline knob: once spent, the next crossing is DENIED");
const cpuDeny = tracer.trace("agt_cpu").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "budget.cpu");
assert(cpuDeny !== undefined, "the CPU-budget denial must be audited with rule budget.cpu");
ops.op_log("  (d2) resource budget (CPU) tied to the M6 sandbox deadline knob: first decision allowed, next DENIED (budget.cpu) + audited");

// ===========================================================================
// (e) SESSION ADMISSION over a REAL socket (boundary #3): a revoked session is denied.
// ===========================================================================
const net = ops as unknown as NetOps;
const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;
const serverEngine = new PolicyEngine();
serverEngine.revokeSession("ses_banned");
const server = new AuthoritativeServer(listenerTransport(net, listenerId), { sessionId: "ses_srv", policy: serverEngine });
server.start();

const okClient = await NetClient.connect(net, url);
const okInit = await okClient.initialize("agt_ok", "ses_ok", "player.limited");
assert(okInit.error === undefined, "a normal session must be admitted by policy");
const banned = await NetClient.connect(net, url);
const banInit = await banned.initialize("agt_ban", "ses_banned", "player.limited");
assert(banInit.error !== undefined && banInit.error.code === -32001, "a REVOKED session must be DENIED admission at initialize (boundary #3)");
const srvTracer = server.registry.tracer as LiminaTracer;
const banEvt = srvTracer.trace("agt_ban").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "session.revoked");
assert(banEvt !== undefined, "the denied session admission must be audited (rule=session.revoked)");
await okClient.close();
await banned.close();
await server.shutdown();
net.op_net_close_listener(listenerId);
ops.op_log("  (e) session admission: normal session admitted, revoked session DENIED at initialize (-32001) over a real socket; audited");

// ===========================================================================
// (f) PACKAGE-LOAD hook (boundary #4, for M9): over-claim + revoked package denied.
// ===========================================================================
const pkgOk = registry.admitPackageLoad({ agentId: "agt_pkg", sessionId: "ses_pkg", pkg: "cool-skills@1.0.0", declaredCaps: ["scene.read", "physics.write"], grantedCaps: ["scene.read", "physics.write", "ecs.read"] });
assert(pkgOk.allow && pkgOk.rule === "package.admitted", "a package whose declared caps are within its grant is admitted");
const pkgBad = registry.admitPackageLoad({ agentId: "agt_pkg", sessionId: "ses_pkg", pkg: "evil-skills@2.0.0", declaredCaps: ["scene.read", "ops.rawExec"], grantedCaps: ["scene.read"] });
assert(!pkgBad.allow && pkgBad.rule === "package.overclaim", "a package over-claiming an ungranted cap must be DENIED");
engine.revokePackage("revoked-pkg@1.0.0");
const pkgRev = registry.admitPackageLoad({ agentId: "agt_pkg", sessionId: "ses_pkg", pkg: "revoked-pkg@1.0.0", declaredCaps: ["scene.read"], grantedCaps: ["scene.read"] });
assert(!pkgRev.allow && pkgRev.rule === "package.revoked", "a revoked package must be DENIED load");
const pkgDeny = tracer.trace("agt_pkg").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "package.overclaim");
assert(pkgDeny !== undefined && field(pkgDeny.payload, "package") === "evil-skills@2.0.0", "the package over-claim must be audited with package provenance");
ops.op_log("  (f) package load: within-grant admitted, over-claim DENIED, revoked package DENIED; audited with provenance");

// ===========================================================================
// FALSIFIABILITY: stub the policy to ALWAYS-ALLOW -> the quota (b) denial vanishes.
// ===========================================================================
class AlwaysAllowEngine extends PolicyEngine {
  override evaluate(ctx: PolicyContext): PolicyDecision {
    return { allow: true, rule: "profile.grant", reason: "stubbed always-allow", boundary: ctx.boundary, context: { agentId: ctx.agentId, sessionId: ctx.sessionId, cap: ctx.cap } };
  }
}
const stubTracer = new LiminaTracer("ses_stub");
const stubEngine = new AlwaysAllowEngine();
stubEngine.setQuota({ cap: "physics.applyImpulse", perSession: true, limit: 3, windowMs: 60_000 });
const stubReg = new SkillRegistry(stubTracer, stubEngine);
registerCoreSkills(stubReg);
const stubBall = field(ok(await stubReg.invoke("scene.createEntity", { position: [0, 9, 0], dynamic: true }, base("agt_s", "ses_s", "builder.readWrite", 5))), "entity");
const stubBallId: string = typeof stubBall === "string" ? stubBall : "";
for (let i = 0; i < 3; i++) await stubReg.invoke("physics.applyImpulse", { entity: stubBallId, impulse: [1, 0, 0] }, base("agt_s", "ses_s", "player.limited", 5));
const stub4 = await stubReg.invoke("physics.applyImpulse", { entity: stubBallId, impulse: [1, 0, 0] }, base("agt_s", "ses_s", "player.limited", 5));
assert(stub4.success, "FALSIFIABILITY: with the policy stubbed to always-allow, the 4th call is NOT denied — the real quota denial in (b) is load-bearing");
ops.op_log("  [falsifiable] stubbed always-allow lets the 4th impulse through -> the real engine's denial is what (b) tests");

ops.op_log("p4_policy OK: context-dependent decision enforced; quota N+1 denied; revocation denied; bypass impossible (only the policy-checked boundary mutates); session admission + package-load enforced; all denials audited; falsifiable against an always-allow stub");
