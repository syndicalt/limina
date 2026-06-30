// M6 — untrusted-code isolation substrate (QuickJS via the limina-sandbox crate).
//
// Proves the M6 acceptance end to end, headless and for real:
//   1. a deliberately-malicious untrusted skill attempts the SIX escapes and ALL
//      are CONTAINED (the probe's own observed output is printed): host globals
//      absent, an ungranted/unknown capability is denied at the registry boundary
//      with ZERO side effect AND audited, another agent's private state cannot be
//      read, an infinite loop is bounded by the CPU deadline, a memory bomb is a
//      catchable OOM, and crashes (stack overflow / uncaught throw) are isolated —
//      the host keeps serving after each;
//   2. the LEGITIMATE granted path: untrusted decision code's capability call
//      really mutates the world THROUGH SkillRegistry.invoke, the mutation is
//      observable, and the crossing is attributed HOST-SIDE (a spoofed agentId in
//      the untrusted payload is IGNORED);
//   3. the sandboxed-agent decision path runs in the LIVE agent loop via the
//      existing perception -> decision -> action systems behind the provider seam.
//
// Falsifiability: assertions FAIL if isolation were faked — Deno must be
// undefined inside the sandbox; the denied capability must leave the entity count
// unchanged; and NO trace event may be attributed to the spoofed identity.
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/context.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { SandboxedSkillHost } from "../src/sandbox/host.ts";
import { SandboxedProvider } from "../src/sandbox/provider.ts";
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
  // Dynamic-key read of an in-process object value: widen to an index map on a
  // named local (never inlined into the access) so the lookup is type-checked.
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return key in record ? record[key] : undefined;
}

// ---- Engine wiring (headless: stub scene, real bitECS + Rapier + tracer) ----
const agents = new AgentRegistry();
const ctx = createHeadlessContext({ session: "ses_iso", agentId: "engine", agents });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.tracer;

// No gravity so an impulse moves a body ONLY from the agent's action (deterministic).
ops.op_physics_create_world(0);
ops.op_physics_add_ground(-50);

const builder = ctx.base;

const host = new SandboxedSkillHost(registry, tracer);

// A secret no capability exposes and no perception carries — the cross-agent
// leak target. It lives in the host (engine side), never injected into a sandbox.
const VICTIM_SECRET = 1337133;

// ===========================================================================
// PHASE A — containment of the resource/crash/global escapes (raw probes).
// ===========================================================================
host.create(
  { agentId: "agt_probe", sessionId: "ses_iso", profile: "system.readonly", code: "globalThis.decide = function(){ return 'noop'; };" },
  { memLimitBytes: 64 * 1024 * 1024 },
);

// ESCAPE 1 — reach host/engine globals (Deno.core.ops / process / require / fetch / ctor-walk).
const PROBE_REACH = `
(function () {
  function probe(fn) { try { var v = fn(); return (v === undefined) ? "undefined" : (v === null ? "null" : typeof v); } catch (e) { return "threw"; } }
  var r = {};
  r.Deno = probe(function () { return (typeof Deno !== "undefined") ? Deno : undefined; });
  r.Deno_core_ops = probe(function () { return (typeof Deno !== "undefined" && Deno.core && Deno.core.ops) ? Deno.core.ops : undefined; });
  r.process = probe(function () { return (typeof process !== "undefined") ? process : undefined; });
  r.require = probe(function () { return (typeof require !== "undefined") ? require : undefined; });
  r.fetch = probe(function () { return (typeof fetch !== "undefined") ? fetch : undefined; });
  r.globalThis_keys = Object.getOwnPropertyNames(globalThis).sort().join(",");
  r.ctor_escape = (function () { try { var F = (function(){}).constructor; var g = F("return this")(); return (g && (g.Deno || g.process || g.require)) ? "REACHED-HOST" : "global-has-no-host"; } catch (e) { return "threw"; } })();
  return JSON.stringify(r);
})()
`;
const reach = host.evalRaw("agt_probe", PROBE_REACH);
assert(reach.ok && reach.value !== undefined, "reach probe should evaluate");
const reachReport: unknown = JSON.parse(reach.value ?? "{}");
ops.op_log("  [E1] malicious probe's OWN report of reachable host globals:");
ops.op_log("       " + (reach.value ?? ""));
assert(field(reachReport, "Deno") === "undefined", "Deno must be undefined inside the sandbox");
assert(field(reachReport, "Deno_core_ops") === "undefined", "Deno.core.ops must be undefined inside the sandbox");
assert(field(reachReport, "process") === "undefined", "process must be undefined inside the sandbox");
assert(field(reachReport, "require") === "undefined", "require must be undefined inside the sandbox");
assert(field(reachReport, "fetch") === "undefined", "fetch must be undefined inside the sandbox");
assert(field(reachReport, "ctor_escape") === "global-has-no-host", "Function-ctor walk must not reach a host global");
ops.op_log("  [E1] CONTAINED: no host handle reachable; reachable globals = " + String(field(reachReport, "globalThis_keys")));

// ESCAPE 4 — CPU exhaustion: an infinite loop bounded by the per-decision deadline.
const loop = host.evalRaw("agt_probe", "var n = 0; while (true) { n = (n + 1) % 99; }", { deadlineMs: 120 });
assert(!loop.ok, "infinite loop must not complete normally");
assert((loop.error ?? "").toLowerCase().includes("interrupt"), "infinite loop must be halted by the interrupt deadline, got: " + String(loop.error));
const aliveAfterLoop = host.evalRaw("agt_probe", "1 + 1");
assert(aliveAfterLoop.ok && aliveAfterLoop.value === "2", "host/sandbox must keep serving after the loop is halted");
ops.op_log("  [E4] CONTAINED: infinite loop halted -> " + String(loop.error) + "; host alive (1+1=" + String(aliveAfterLoop.value) + ")");

// ESCAPE 5 — memory bomb: a catchable OOM on a small per-agent memory budget; host survives.
host.create(
  { agentId: "agt_membomb", sessionId: "ses_iso", profile: "system.readonly", code: "globalThis.decide = function(){ return 'noop'; };" },
  { memLimitBytes: 4 * 1024 * 1024 },
);
const bomb = host.evalRaw("agt_membomb", "var a = []; for (;;) { a.push(new Array(100000).fill(7)); }");
assert(!bomb.ok, "memory bomb must not complete normally");
assert((bomb.error ?? "").toLowerCase().includes("memory"), "memory bomb must trip the memory cap, got: " + String(bomb.error));
const aliveAfterBomb = host.evalRaw("agt_membomb", "1 + 1");
assert(aliveAfterBomb.ok && aliveAfterBomb.value === "2", "the memory-bomb sandbox must keep serving after OOM");
// The OTHER sandbox is untouched => the host PROCESS survived the OOM.
assert(host.evalRaw("agt_probe", "40 + 2").value === "42", "the host process must survive another sandbox's OOM");
ops.op_log("  [E5] CONTAINED: memory bomb -> " + String(bomb.error) + "; host process alive");

// ESCAPE 6 — crashes: stack overflow + uncaught throw are isolated; host serves.
const stack = host.evalRaw("agt_probe", "function rec(x){ return rec(x + 1) + 1; } rec(0)");
assert(!stack.ok, "stack overflow must be contained");
assert((stack.error ?? "").toLowerCase().includes("stack"), "stack overflow must report a stack error, got: " + String(stack.error));
const thrown = host.evalRaw("agt_probe", "throw new Error('hostile skill detonates');");
assert(!thrown.ok, "uncaught throw must be contained");
assert((thrown.error ?? "").includes("hostile skill detonates"), "uncaught throw must surface its message, got: " + String(thrown.error));
assert(host.evalRaw("agt_probe", "7 * 6").value === "42", "host must keep serving after crashes");
ops.op_log("  [E6] CONTAINED: stack overflow -> " + String(stack.error) + "; throw -> " + String(thrown.error) + "; host alive");

// ===========================================================================
// PHASE B — ungranted capability (E2) + cross-agent read (E3) through the bridge.
// A player.limited agent CANNOT scene.write; an unknown op is not_found; another
// agent's private state is never reachable. Every refusal is audited.
// ===========================================================================
const MALICIOUS_DECIDE = `
globalThis.decide = function () {
  var ownView = host.invoke("perception", "{}");                                   // read cap: this agent's OWN view
  var crossRead = host.invoke("agent.readOtherState", JSON.stringify({ target: "agt_victim" })); // recorded -> denied (unknown skill)
  host.invoke("ops.rawExec", JSON.stringify({ cmd: "rm -rf /" }));                 // recorded -> denied (unknown privileged op)
  host.invoke("scene.createEntity", JSON.stringify({ position: [1, 2, 3], agentId: "agt_admin" })); // recorded -> denied (forbidden: no scene.write)
  return JSON.stringify({ ownView: ownView, crossRead: crossRead });
};`;
host.create({ agentId: "agt_evil", sessionId: "ses_evil", profile: "player.limited", code: MALICIOUS_DECIDE }, { cpuDeadlineMs: 100 });

// agt_evil's injected perception is its OWN view — it never carries the victim secret.
const evilPerception = { selfId: "agt_evil", nearby: [], position: [0, 0, 0], recentEvents: [], tick: 1 };
assert(!JSON.stringify(evilPerception).includes(String(VICTIM_SECRET)), "the secret must not be in the agent's own injected perception");

// Inspect what the malicious decide() could actually read (its OWN return value).
const evilProbe = host.produceCalls("agt_evil", evilPerception);
assert(evilProbe.ok, "malicious decide() should run to completion (it is contained, not crashed)");
assert(!(evilProbe.value ?? "").includes(String(VICTIM_SECRET)), "the victim secret must not be reachable from inside the sandbox");
// The cross-agent read was recorded as an intent (never executed in-sandbox): it returns only the queued ack, no data.
assert((evilProbe.value ?? "").includes("queued"), "an unknown capability returns only a queued ack, never data");

const entitiesBefore = world.entities.ids().length;
const evilResult = await host.runDecision("agt_evil", { perception: evilPerception, world, tick: 1 });
const entitiesAfter = world.entities.ids().length;

assert(evilResult.ok, "the malicious decision itself ran (its actions are what get denied)");
assert(evilResult.executed === 0, "NO malicious capability may execute, got executed=" + evilResult.executed);
assert(evilResult.denied >= 1, "at least the forbidden scene.createEntity must be denied, got denied=" + evilResult.denied);
assert(entitiesAfter === entitiesBefore, "the denied scene.createEntity must have ZERO side effect (entity count unchanged)");

const createCross = evilResult.crossings.find((c) => c.cap === "scene.createEntity");
assert(createCross !== undefined && createCross.denied && createCross.code === "forbidden", "scene.createEntity must be a permission-forbidden denial");
const rawExecCross = evilResult.crossings.find((c) => c.cap === "ops.rawExec");
assert(rawExecCross !== undefined && !rawExecCross.success, "the unknown privileged op ops.rawExec must be refused");
const crossReadCross = evilResult.crossings.find((c) => c.cap === "agent.readOtherState");
assert(crossReadCross !== undefined && !crossReadCross.success, "the cross-agent read must be refused at the boundary");
for (const c of evilResult.crossings) {
  assert(!(c.reason ?? "").includes(String(VICTIM_SECRET)), "no denial reason may leak the victim secret");
}

// Audited: the registry emits a permission denial AND the host emits a sandbox denial event.
const evilTrace = tracer.trace("agt_evil");
assert(evilTrace.some((e) => e.type === "security.permission.denied"), "the forbidden cap must emit a registry permission-denied audit event");
assert(evilTrace.some((e) => e.type === "sandbox.capability.denied"), "every refused crossing must emit a sandbox audit event");
ops.op_log("  [E2/E3] CONTAINED: executed=" + evilResult.executed + " denied=" + evilResult.denied + " entities " + entitiesBefore + "->" + entitiesAfter + "; secret not leaked; denials audited");

// ===========================================================================
// PHASE C — legitimate granted path through the bridge, with host-bound attribution.
// A spoofed agentId in the untrusted payload MUST be ignored.
// ===========================================================================
const goodEntity = field(ok(await registry.invoke("scene.createEntity", { position: [0, 0, 0], dynamic: true }, builder)), "entity");
assert(typeof goodEntity === "string", "setup: agt_good entity created");
const goodEntityId: string = typeof goodEntity === "string" ? goodEntity : "";
const goodBodyId = world.entities.resolve(goodEntityId)?.bodyId ?? -1;

const LEGIT_DECIDE = `
globalThis.decide = function () {
  var p = JSON.parse(host.invoke("perception", "{}"));
  // Spoof attribution in the payload — the host must IGNORE it.
  host.invoke("physics.applyImpulse", JSON.stringify({ entity: p.selfEntity, impulse: [12, 0, 0], agentId: "agt_spoofed", sessionId: "ses_spoofed" }));
  return "ok";
};`;
host.create({ agentId: "agt_good", sessionId: "ses_good", profile: "builder.readWrite", code: LEGIT_DECIDE });

const goodPerception = { selfId: "agt_good", selfEntity: goodEntityId, position: [0, 0, 0], nearby: [], recentEvents: [], tick: 2 };
const beforePos = new Float32Array(3);
ops.op_physics_body_pos(goodBodyId, beforePos);
const goodResult = await host.runDecision("agt_good", { perception: goodPerception, world, tick: 2 });
for (let i = 0; i < 12; i++) ops.op_physics_step();
const afterPos = new Float32Array(3);
ops.op_physics_body_pos(goodBodyId, afterPos);

assert(goodResult.ok && goodResult.executed === 1 && goodResult.denied === 0, "the granted physics.applyImpulse must execute");
assert(afterPos[0] > beforePos[0] + 0.1, "the granted capability must really mutate the world (body moved +x): " + beforePos[0] + " -> " + afterPos[0]);

// The mutation crossed SkillRegistry.invoke (world log / trace) attributed HOST-SIDE.
const goodTrace = tracer.trace("agt_good");
const exec = goodTrace.find((e) => e.type === "skill.executed" && field(e.payload, "skill") === "physics.applyImpulse");
assert(exec !== undefined, "the mutation must emit skill.executed through the registry");
assert(exec.actorId === "agt_good", "skill.executed must be attributed host-side to agt_good, got " + String(exec?.actorId));
const invoked = goodTrace.find((e) => e.type === "sandbox.capability.invoked" && field(e.payload, "cap") === "physics.applyImpulse");
assert(invoked !== undefined, "the crossing must emit a sandbox audit event");
assert(field(invoked.payload, "attributedTo") === "agt_good", "the sandbox audit must record host-bound attribution");
assert(field(invoked.payload, "claimedAgentId") === "agt_spoofed", "the sandbox audit must record the IGNORED spoofed claim for forensics");
// FALSIFIABILITY: if attribution had used the payload, events would exist under agt_spoofed.
assert(tracer.trace("agt_spoofed").length === 0, "NO trace event may be attributed to the spoofed identity");
ops.op_log("  [LEGIT] mutation through SkillRegistry.invoke: body x " + beforePos[0].toFixed(2) + " -> " + afterPos[0].toFixed(2) + "; attributed to agt_good (spoof 'agt_spoofed' ignored)");

// ===========================================================================
// PHASE D — sandboxed-agent decision path in the LIVE agent loop (provider seam).
// An untrusted agent perceives, decides IN ITS QUICKJS SANDBOX, and its action is
// applied via the existing decision/action systems through SkillRegistry.invoke.
// ===========================================================================
const runnerEntity = field(ok(await registry.invoke("scene.createEntity", { position: [0, 0, 20], dynamic: true }, builder)), "entity");
const targetEntity = field(ok(await registry.invoke("scene.createEntity", { position: [12, 0, 20], dynamic: false }, builder)), "entity");
assert(typeof runnerEntity === "string" && typeof targetEntity === "string", "setup: runner + target entities created");
const runnerEntityId: string = typeof runnerEntity === "string" ? runnerEntity : "";

agents.add({
  id: "agt_runner", type: "player", entityId: runnerEntityId,
  perceptionRadius: 50, decisionIntervalTicks: 1, profile: "player.limited", sessionId: "ses_runner",
  llm: { provider: "sandboxed", model: "", systemPrompt: "move toward the nearest entity" },
});
const RUNNER_DECIDE = `
globalThis.decide = function () {
  var p = JSON.parse(host.invoke("perception", "{}"));
  if (!p || !p.nearby || p.nearby.length === 0 || !p.position || !p.selfEntity) return "wait";
  var t = p.nearby[0];
  var d = [t.position[0] - p.position[0], t.position[1] - p.position[1], t.position[2] - p.position[2]];
  var len = Math.sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2]) || 1;
  host.invoke("physics.applyImpulse", JSON.stringify({ entity: p.selfEntity, impulse: [d[0]/len*3, d[1]/len*3, d[2]/len*3] }));
  return "move";
};`;
host.create({ agentId: "agt_runner", sessionId: "ses_runner", profile: "player.limited", code: RUNNER_DECIDE });

const providers = { sandboxed: new SandboxedProvider(host) };
const runnerBody = world.entities.resolve(runnerEntityId)?.bodyId ?? -1;
const runnerStart = new Float32Array(3);
ops.op_physics_body_pos(runnerBody, runnerStart);
for (let tick = 10; tick <= 16; tick++) {
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, providers, tracer, tick);
  await actionSystem(agents, registry, world, tick);
  ops.op_physics_step();
  await Promise.resolve(); // pump the sandboxed provider's decide().then enqueue
}
const runnerEnd = new Float32Array(3);
ops.op_physics_body_pos(runnerBody, runnerEnd);
assert(runnerEnd[0] > runnerStart[0] + 0.1, "the sandboxed agent must move toward the target in the live loop: " + runnerStart[0] + " -> " + runnerEnd[0]);
const runnerExec = tracer.trace("agt_runner").find((e) => e.type === "skill.executed");
assert(runnerExec !== undefined && runnerExec.actorId === "agt_runner", "the sandboxed agent's action must execute through the registry, attributed host-side");
ops.op_log("  [LOOP] sandboxed agent moved x " + runnerStart[0].toFixed(2) + " -> " + runnerEnd[0].toFixed(2) + " via decision/action systems");

// ===========================================================================
// PHASE E — teardown: contexts are freed.
// ===========================================================================
const liveBefore = host.liveCount();
assert(liveBefore === 5, "expected 5 live sandboxes (probe, membomb, evil, good, runner), got " + liveBefore);
for (const id of ["agt_probe", "agt_membomb", "agt_evil", "agt_good", "agt_runner"]) assert(host.destroy(id), "destroy " + id);
assert(host.liveCount() === 0, "all sandboxes must be freed after teardown, got " + host.liveCount());

ops.op_log("p4_isolation OK: 6 escapes contained (host alive after each); ungranted cap denied+audited with zero side effect; cross-agent state not leaked; legitimate granted path mutates the world through SkillRegistry.invoke with host-bound attribution (spoof ignored); sandboxed agent runs in the live loop; sandboxes freed");
