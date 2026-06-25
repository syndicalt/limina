// M8 — queryable audit surface (headless, REAL, falsifiable). Performs a few
// ALLOWED + DENIED actions through the policy-checked boundary, then queries the
// audit surface and asserts every answer is reconstructed from the REAL recorded
// trace (scan, never fabricate):
//
//   audit.explain { eventId }  -> for an ALLOWED action: the governing policy
//     decision (allow + matching rule + the real context values), the provenance
//     (agent/session/profile), and the causal-parent chain back to the real
//     recorded request event; for a DENIED action: the denial decision (deny +
//     quota.exceeded) + provenance + the real causal parent.
//   audit.query  { decision:"deny" } -> denials summarized by rule, from real events.
//   audit.query  { package }         -> package provenance from real events.
//   audit.usage  { sessionId }       -> real allowed/denied call counts per cap.
//
// FALSIFIABILITY: a wrong/empty answer fails — the asserts check the decision
// matches the ACTUAL recorded rule/allow, the provenance matches the event
// envelope, and the ancestry contains the SPECIFIC recorded parent id; an unknown
// event id must throw.

import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function rec(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error("expected object, got " + JSON.stringify(value));
  return value as Record<string, unknown>;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return key in record ? record[key] : undefined;
}

// ---- wiring ---------------------------------------------------------------
const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };
ops.op_physics_create_world(0);
ops.op_physics_add_ground(-50);

const tracer = new LiminaTracer("ses_audit");
const engine = new PolicyEngine();
engine.setQuota({ cap: "physics.applyImpulse", perSession: true, limit: 2, windowMs: 60_000 });
const registry = new SkillRegistry(tracer, engine);
registerCoreSkills(registry);

function base(agentId: string, sessionId: string, profile: string, tick: number, causedBy?: string[]) {
  return { agentId, sessionId, profile, permissions: resolveProfile(profile), tick, world, causedBy };
}
const sysBase = base("agt_review", "ses_review", "system.readonly", 9);

// ---- perform real actions (allowed + denied) with real causal parents ------
// An ALLOWED action linked to a recorded "request" event (a real causal parent).
const allowReq = tracer.emit({ type: "agent.action.requested", actorId: "agt_actor", threadId: "ses_actor", parentEventId: null, causedBy: [], payload: { intent: "create-ball" } });
const createRes = await registry.invoke("scene.createEntity", { position: [0, 5, 0], dynamic: true }, base("agt_actor", "ses_actor", "builder.readWrite", 1, [allowReq]));
assert(createRes.success, "setup: the allowed create must succeed");
const ballId = field(createRes.result, "entity");
const createEmitted = createRes.metadata?.eventsEmitted ?? [];
const skillExecId = createEmitted[createEmitted.length - 1]; // policy.decision, then skill.executed
assert(typeof skillExecId === "string" && skillExecId.length > 0, "setup: captured the skill.executed event id");

// Two allowed impulses (within the quota), then a 3rd that the quota DENIES, the
// denied call linked to its own recorded request event.
for (let i = 0; i < 2; i++) await registry.invoke("physics.applyImpulse", { entity: ballId, impulse: [1, 0, 0] }, base("agt_actor", "ses_actor", "builder.readWrite", 1));
const denyReq = tracer.emit({ type: "agent.action.requested", actorId: "agt_actor", threadId: "ses_actor", parentEventId: null, causedBy: [], payload: { intent: "impulse-3" } });
const overRes = await registry.invoke("physics.applyImpulse", { entity: ballId, impulse: [1, 0, 0] }, base("agt_actor", "ses_actor", "builder.readWrite", 1, [denyReq]));
assert(!overRes.success, "setup: the 3rd impulse must be denied by the quota");
const denyEmitted = overRes.metadata?.eventsEmitted ?? [];
const denyEvtId = denyEmitted[denyEmitted.length - 1]; // policy.denied
assert(typeof denyEvtId === "string" && denyEvtId.length > 0, "setup: captured the policy.denied event id");

// A package over-claim (package provenance source).
registry.admitPackageLoad({ agentId: "agt_actor", sessionId: "ses_actor", pkg: "shady-pack@3.1.0", declaredCaps: ["scene.read", "ops.secret"], grantedCaps: ["scene.read"] });

// ===========================================================================
// audit.explain — ALLOWED action: decision + provenance + causal trace.
// ===========================================================================
const explainAllow = rec(ok(await registry.invoke("audit.explain", { eventId: skillExecId }, sysBase)));
assert(explainAllow.found === true, "explain(allowed): a governing decision must be found");
const dAllow = rec(explainAllow.decision);
assert(dAllow.allow === true && dAllow.rule === "profile.grant", "explain(allowed): decision matches the REAL recorded rule (allow / profile.grant)");
const ctxAllow = rec(dAllow.context);
assert(ctxAllow.cap === "scene.createEntity" && ctxAllow.agentId === "agt_actor" && ctxAllow.sessionId === "ses_actor", "explain(allowed): the decision context values match the real crossing");
const provAllow = rec(explainAllow.provenance);
assert(provAllow.agentId === "agt_actor" && provAllow.sessionId === "ses_actor" && provAllow.profile === "builder.readWrite", "explain(allowed): provenance matches the recorded event envelope + decision");
const ancAllow = arr(rec(explainAllow.causalTrace).ancestry).map((a) => rec(a).id);
assert(ancAllow.includes(allowReq), "explain(allowed): the causal ancestry includes the REAL recorded request parent");
assert(ancAllow.includes(dAllow.eventId), "explain(allowed): the ancestry includes the governing policy.decision event");
ops.op_log("  audit.explain(allowed): decision=profile.grant(allow), provenance=agt_actor/ses_actor/builder.readWrite, ancestry->request+decision (from real events)");

// ===========================================================================
// audit.explain — DENIED action: the denial decision + provenance + causal trace.
// ===========================================================================
const explainDeny = rec(ok(await registry.invoke("audit.explain", { eventId: denyEvtId }, sysBase)));
const dDeny = rec(explainDeny.decision);
assert(dDeny.allow === false && dDeny.rule === "quota.exceeded", "explain(denied): decision matches the REAL recorded denial (deny / quota.exceeded)");
const provDeny = rec(explainDeny.provenance);
assert(provDeny.agentId === "agt_actor" && provDeny.sessionId === "ses_actor", "explain(denied): provenance matches the recorded denial");
const ancDeny = arr(rec(explainDeny.causalTrace).ancestry).map((a) => rec(a).id);
assert(ancDeny.includes(denyReq), "explain(denied): the causal ancestry includes the REAL recorded request parent");
ops.op_log("  audit.explain(denied): decision=quota.exceeded(deny), provenance=agt_actor, ancestry->the real request event");

// ===========================================================================
// audit.query — denials by rule; package provenance.
// ===========================================================================
const denials = rec(ok(await registry.invoke("audit.query", { decision: "deny" }, sysBase)));
const denialSummary = rec(denials.summary);
const deniedCount = denialSummary.denied;
assert(typeof deniedCount === "number" && deniedCount >= 2, "query(deny): real denials counted (quota + package over-claim)");
const byRule = rec(denialSummary.byRule);
const quotaRuleCount = byRule["quota.exceeded"];
const overclaimRuleCount = byRule["package.overclaim"];
assert(typeof quotaRuleCount === "number" && quotaRuleCount >= 1 && typeof overclaimRuleCount === "number" && overclaimRuleCount >= 1, "query(deny): denials grouped by the REAL rules that fired");

const pkgQuery = rec(ok(await registry.invoke("audit.query", { package: "shady-pack@3.1.0" }, sysBase)));
const pkgDecisions = arr(rec(pkgQuery.summary).packages);
assert(pkgDecisions.includes("shady-pack@3.1.0"), "query(package): package provenance surfaced from real events");
const pkgRows = arr(pkgQuery.decisions);
assert(pkgRows.some((d) => rec(d).package === "shady-pack@3.1.0" && rec(d).rule === "package.overclaim"), "query(package): the over-claim decision is recoverable with its real rule");
ops.op_log("  audit.query: denials by rule (quota.exceeded + package.overclaim), package provenance (shady-pack@3.1.0) — all from real events");

// ===========================================================================
// audit.usage — real resource usage per session+cap.
// ===========================================================================
const usage = rec(ok(await registry.invoke("audit.usage", { sessionId: "ses_actor" }, sysBase)));
const rows = arr(usage.perSessionCap).map(rec);
const impulseRow = rows.find((r) => r.cap === "physics.applyImpulse");
assert(impulseRow !== undefined, "usage: physics.applyImpulse usage row exists");
assert(impulseRow.allowed === 2 && impulseRow.denied === 1, "usage: REAL counts — 2 allowed + 1 denied impulse for ses_actor");
ops.op_log("  audit.usage(ses_actor): physics.applyImpulse allowed=2 denied=1 (real recorded counts)");

// ===========================================================================
// FALSIFIABILITY: an unknown event id must throw (no fabricated answer).
// ===========================================================================
const bogus = await registry.invoke("audit.explain", { eventId: "evt_does_not_exist_000000000000_deadbeef" }, sysBase);
assert(!bogus.success, "audit.explain on an unknown event id must FAIL, never fabricate an answer");

ops.op_log("p4_audit OK: 'why allowed/denied' answered from REAL recorded events — policy decision (matching rule + context) + provenance + causal-parent chain; denials/usage/package-provenance queryable; unknown id rejected");
