// M9 + 4b CAPSTONE — packaging + versioned registries (headless, REAL, falsifiable).
//
// Proves the M9 acceptance and the 4b capstone demo end to end: a distributable,
// versioned, MANIFEST-declared third-party package loads under M6 isolation,
// governed by M7 policy, leaving an M8 audit trail — composing the delivered
// substrate, not reimplementing it:
//
//   PHASE 1 — a well-formed, IN-GRANT, IN-COMPAT third-party AGENT package:
//     * installs with a Zod-validated manifest (name@semver, declared caps, asset
//       refs, engineCompat range, untrusted entry, attestation);
//     * resolves by name@range (highest satisfying version);
//     * LOADS via the package.load skill -> compat OK -> admitPackageLoad admits
//       (declared caps within grant) -> the untrusted entry runs in the M6 sandbox;
//     * RUNS isolated and actually MUTATES the world THROUGH the governed registry
//       (its body moves), attributed HOST-SIDE (a spoofed payload id is ignored);
//     * is POLICY-GOVERNED by a REAL quota denial (the N+1th crossing denied) AND
//       a REAL package revocation (a revoked package is denied reload);
//     * is fully AUDITED: audit.explain on the load event returns the governing
//       package-admit decision + package provenance; audit.query{package} surfaces it.
//
//   PHASE 2 — an ESCAPE / capability OVER-CLAIM is CONTAINED:
//     * a package declaring a cap beyond its grant is DENIED at load
//       (admitPackageLoad refuses) and does NOT load + is audited; AND
//     * a loaded within-grant package that tries an UNGRANTED cap at RUNTIME is
//       denied at the M7 boundary with ZERO side effect + audited.
//
//   PHASE 3 — an OUT-OF-COMPAT-BOUNDS version is REJECTED at load (+ audited).
//
//   FALSIFIABILITY (the binding anti-hack clause): the out-of-compat package is
//   otherwise valid and ADMITTABLE (admitPackageLoad would PASS) — only the compat
//   gate rejects it, and an identical entry with an in-bounds range DOES load; the
//   over-claim package PASSES compat and its raw entry loads when host.create is
//   called directly — only admitPackageLoad contains it. So removing the compat
//   check would load the bad version, and removing admitPackageLoad would let the
//   over-claim slip — the asserts FAIL if either gate were stubbed out.

import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { SandboxedSkillHost } from "../src/sandbox/host.ts";
import { ENGINE_VERSION, PackageRegistry, registerPackageSkills, satisfies } from "../src/packages/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array, got " + JSON.stringify(value));
  return value;
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
// No gravity: a body moves ONLY from the agent's impulse (deterministic +x).
ops.op_physics_create_world(0);
ops.op_physics_add_ground(-50);

const tracer = new LiminaTracer("ses_pkg");
const engine = new PolicyEngine();
const registry = new SkillRegistry(tracer, engine);
registerCoreSkills(registry); // core + audit + default package.* skills
const host = new SandboxedSkillHost(registry, tracer, engine);
// The M9 versioned package registry, composing M6 (host) + M7 (registry/engine) + M8 (tracer).
const packages = new PackageRegistry(registry, host, tracer, ENGINE_VERSION, engine);
registerPackageSkills(registry, packages); // rebind package.* to THIS instance

const builderBase = { agentId: "engine", sessionId: "ses_pkg", profile: "builder.readWrite", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Manifest validation: a malformed manifest (bad name + non-semver version) is rejected by Zod.
const badInstall = packages.install({ name: "Bad Name!!", version: "not-semver", kind: "agent", engineCompat: "^1.0.0", entry: "x" });
assert(!badInstall.ok, "an invalid manifest (bad name + non-semver version) must be rejected by the Zod schema");
ops.op_log("p4_packaging: ENGINE_VERSION=" + ENGINE_VERSION + "; malformed manifest rejected (" + (badInstall.error ?? "").slice(0, 40) + "...)");

// ===========================================================================
// PHASE 1 — legitimate governed third-party package: load + run + govern + audit.
// ===========================================================================
const LEGIT_ENTRY = `
globalThis.decide = function () {
  var p = JSON.parse(host.invoke("perception", "{}"));
  if (!p || !p.selfEntity) return "wait";
  // Spoof attribution in the payload — the host must IGNORE it (host-bound).
  host.invoke("physics.applyImpulse", JSON.stringify({ entity: p.selfEntity, impulse: [8, 0, 0], agentId: "agt_pirate_spoof" }));
  return "push";
};`;
const legitManifest = {
  name: "orbit-mover",
  version: "1.2.0",
  kind: "agent" as const,
  declaredCapabilities: ["scene.read", "physics.read", "physics.write"],
  assetRefs: ["asset://orbit-mover/mesh.glb"],
  engineCompat: ">=1.0.0 <2.0.0",
  entry: LEGIT_ENTRY,
  attestation: { signer: "third-party-studio", signature: "sig-deadbeef", algorithm: "ed25519" },
};
const inst = packages.install(legitManifest);
assert(inst.ok && inst.ref === "orbit-mover@1.2.0", "the well-formed third-party manifest installs as orbit-mover@1.2.0");

// Resolve by name@range — highest satisfying version.
assert(packages.resolve("orbit-mover", "^1.0.0")?.ref === "orbit-mover@1.2.0", "resolve picks the version satisfying ^1.0.0");
assert(packages.resolve("orbit-mover", ">=2.0.0") === undefined, "resolve returns nothing when no installed version satisfies the range");

// LOAD via the package.load skill (exercises the registered capability end to end).
const loadRes = ok(await registry.invoke("package.load", { ref: "orbit-mover@1.2.0", agentId: "agt_orbit", sessionId: "ses_orbit", profile: "player.limited" }, builderBase));
assert(field(loadRes, "ok") === true && field(loadRes, "rule") === "package.admitted", "the in-grant in-compat package LOADS (admitted) via package.load");
assert(host.has("agt_orbit"), "the package's untrusted entry is loaded into the M6 sandbox");
const loadEventId = field(loadRes, "loadEventId");
assert(typeof loadEventId === "string", "the load returns an M8 provenance event id");

// RUN isolated + MUTATE the world through the governed registry.
const orbitEntity = field(ok(await registry.invoke("scene.createEntity", { position: [0, 0, 0], dynamic: true }, builderBase)), "entity");
const orbitEntityId: string = typeof orbitEntity === "string" ? orbitEntity : "";
const orbitBody = world.entities.resolve(orbitEntityId)?.bodyId ?? -1;
const orbitPerception = { selfId: "agt_orbit", selfEntity: orbitEntityId, position: [0, 0, 0], nearby: [], recentEvents: [], tick: 5 };
const before = new Float32Array(3);
ops.op_physics_body_pos(orbitBody, before);
const decision1 = await host.runDecision("agt_orbit", { perception: orbitPerception, world, tick: 5 });
for (let i = 0; i < 12; i++) ops.op_physics_step();
const after = new Float32Array(3);
ops.op_physics_body_pos(orbitBody, after);
assert(decision1.ok && decision1.executed === 1 && decision1.denied === 0, "the loaded package agent's granted crossing executes");
assert(after[0] > before[0] + 0.1, "the legitimate package MUTATES the world through the governed registry (body x " + before[0].toFixed(2) + " -> " + after[0].toFixed(2) + ")");
const orbitExec = tracer.trace("agt_orbit").find((e) => e.type === "skill.executed" && field(e.payload, "skill") === "physics.applyImpulse");
assert(orbitExec !== undefined && orbitExec.actorId === "agt_orbit", "the package mutation is attributed host-side to the package agent");
assert(tracer.trace("agt_pirate_spoof").length === 0, "the package's spoofed payload attribution is IGNORED (no event under the spoofed id)");
ops.op_log("  [P1 load+run] orbit-mover@1.2.0 loaded ISOLATED + moved its body x " + before[0].toFixed(2) + " -> " + after[0].toFixed(2) + " via SkillRegistry.invoke (spoof ignored)");

// POLICY-GOVERNED — a REAL quota denial on the loaded package agent.
engine.setQuota({ cap: "physics.applyImpulse", perSession: true, limit: 3, windowMs: 60_000 });
for (let i = 0; i < 3; i++) {
  const r = await host.runDecision("agt_orbit", { perception: orbitPerception, world, tick: 6 + i });
  assert(r.executed === 1, "within-quota package crossing #" + (i + 1) + " executes");
}
const overQuota = await host.runDecision("agt_orbit", { perception: orbitPerception, world, tick: 9 });
assert(overQuota.executed === 0 && overQuota.denied >= 1, "the N+1th package crossing is DENIED by the quota (real M7 governance)");
const qDeny = tracer.trace("agt_orbit").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "quota.exceeded");
assert(qDeny !== undefined, "the quota denial on the package agent is audited (rule=quota.exceeded)");
ops.op_log("  [P1 govern] quota: 3 package crossings allowed, the 4th DENIED (quota.exceeded) + audited");

// POLICY-GOVERNED — a REAL package revocation via the M7 revokePackage path.
assert(packages.revoke("orbit-mover@1.2.0"), "the package can be revoked via the M7 revokePackage path");
const reload = packages.load("orbit-mover@1.2.0", { agentId: "agt_orbit2", sessionId: "ses_orbit2", profile: "player.limited" });
assert(!reload.ok && reload.rejectReason === "package.revoked", "a REVOKED package is DENIED reload");
assert(!host.has("agt_orbit2"), "the revoked package did NOT load (no sandbox created)");
const revDeny = tracer.trace("agt_orbit2").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "package.revoked");
assert(revDeny !== undefined, "the package revocation is audited (rule=package.revoked)");
ops.op_log("  [P1 govern] revocation: revoked package DENIED reload (package.revoked) + audited");

// AUDITED — provenance + a decision via audit.explain / audit.query.
const explain = ok(await registry.invoke("audit.explain", { eventId: loadEventId }, builderBase));
const decisionField = field(explain, "decision");
assert(decisionField !== null && decisionField !== undefined && field(decisionField, "rule") === "package.admitted", "audit.explain on the load event returns the governing package-admit decision");
assert(field(field(decisionField, "context"), "package") === "orbit-mover@1.2.0", "the audited governing decision carries the package provenance");
assert(field(field(explain, "provenance"), "package") === "orbit-mover@1.2.0", "audit.explain provenance names the package");
const q = ok(await registry.invoke("audit.query", { package: "orbit-mover@1.2.0" }, builderBase));
const summary = field(q, "summary");
assert((field(summary, "total") as number) >= 1 && arr(field(summary, "packages")).includes("orbit-mover@1.2.0"), "audit.query{package} surfaces the package provenance from real recorded decisions");
ops.op_log("  [P1 audit] audit.explain -> package.admitted decision + provenance; audit.query{package} -> " + JSON.stringify(field(summary, "packages")));

// ===========================================================================
// PHASE 2 — escape / capability OVER-CLAIM is CONTAINED.
// ===========================================================================
// (2a) over-claim at LOAD: declares scene.write (NOT in player.limited grant).
const OVERCLAIM_ENTRY = `globalThis.decide = function () { host.invoke("scene.createEntity", JSON.stringify({ position: [0, 0, 0] })); return "spawn"; };`;
const overclaimManifest = {
  name: "evil-spawner", version: "0.9.0", kind: "agent" as const,
  declaredCapabilities: ["scene.read", "scene.write"], assetRefs: [],
  engineCompat: ">=1.0.0", entry: OVERCLAIM_ENTRY,
};
assert(packages.install(overclaimManifest).ok, "the over-claim package installs (manifest is well-formed)");
const overLoad = packages.load("evil-spawner@0.9.0", { agentId: "agt_evil_pkg", sessionId: "ses_evil_pkg", profile: "player.limited" });
assert(!overLoad.ok && overLoad.rejectReason === "package.overclaim", "an OVER-CLAIMING package is DENIED at load (admitPackageLoad refuses)");
assert(!host.has("agt_evil_pkg"), "the over-claiming package did NOT load into the sandbox (contained at load)");
const overDeny = tracer.trace("agt_evil_pkg").find((e) => e.type === "policy.denied" && field(e.payload, "rule") === "package.overclaim");
assert(overDeny !== undefined && field(overDeny.payload, "package") === "evil-spawner@0.9.0", "the over-claim is audited with package provenance (rule=package.overclaim)");
ops.op_log("  [P2 over-claim@load] evil-spawner@0.9.0 declares scene.write beyond grant -> DENIED at load, not loaded, audited");

// (2b) RUNTIME containment: a within-grant package whose code tries an ungranted cap.
const SNEAKY_ENTRY = `globalThis.decide = function () { host.invoke("scene.createEntity", JSON.stringify({ position: [3, 3, 3] })); return "sneak"; };`;
const sneakyManifest = {
  name: "sneaky-mover", version: "1.0.0", kind: "agent" as const,
  declaredCapabilities: ["scene.read", "physics.read", "physics.write"], assetRefs: [],
  engineCompat: "^1.0.0", entry: SNEAKY_ENTRY,
};
assert(packages.install(sneakyManifest).ok, "the sneaky package installs");
const sneakyLoad = packages.load("sneaky-mover@1.0.0", { agentId: "agt_sneaky", sessionId: "ses_sneaky", profile: "player.limited" });
assert(sneakyLoad.ok && host.has("agt_sneaky"), "the within-grant package LOADS (its declared caps are within grant)");
const entBefore = world.entities.ids().length;
const sneakyRun = await host.runDecision("agt_sneaky", { perception: { selfId: "agt_sneaky", nearby: [], position: [0, 0, 0], recentEvents: [], tick: 20 }, world, tick: 20 });
const entAfter = world.entities.ids().length;
assert(sneakyRun.executed === 0 && sneakyRun.denied >= 1, "the loaded package's UNGRANTED runtime cap is DENIED at the M7 boundary");
assert(entAfter === entBefore, "the denied runtime crossing has ZERO side effect (no entity created): " + entBefore + " -> " + entAfter);
const sneakyDeny = tracer.trace("agt_sneaky").find((e) => e.type === "policy.denied" && field(e.payload, "cap") === "scene.createEntity");
assert(sneakyDeny !== undefined, "the runtime containment of the loaded package is audited (policy.denied)");
ops.op_log("  [P2 over-claim@runtime] sneaky-mover@1.0.0 loaded but its ungranted scene.createEntity DENIED at the boundary, zero side effect, audited");

// ===========================================================================
// PHASE 3 — out-of-compat-bounds version is REJECTED at load.
// ===========================================================================
const FUTURE_ENTRY = `globalThis.decide = function () { return "noop"; };`;
const futureManifest = {
  name: "future-skill", version: "3.0.0", kind: "agent" as const,
  declaredCapabilities: ["scene.read"], assetRefs: [],
  engineCompat: ">=2.0.0", entry: FUTURE_ENTRY,
};
assert(packages.install(futureManifest).ok, "the future package installs (manifest is well-formed)");
const futureLoad = packages.load("future-skill@3.0.0", { agentId: "agt_future", sessionId: "ses_future", profile: "player.limited" });
assert(!futureLoad.ok && futureLoad.rejectReason === "engine.incompat", "an OUT-OF-COMPAT-BOUNDS package is REJECTED at load");
assert(!host.has("agt_future"), "the out-of-compat package did NOT load");
assert((futureLoad.reason ?? "").includes("2.0.0"), "the rejection reason names the required engine range");
const compatReject = tracer.trace("agt_future").find((e) => e.type === "package.load.rejected" && field(e.payload, "rejectReason") === "engine.incompat");
assert(compatReject !== undefined, "the compat rejection is audited (package.load.rejected)");
ops.op_log("  [P3 compat] future-skill@3.0.0 requires engine >=2.0.0 but engine is " + ENGINE_VERSION + " -> REJECTED at load, not loaded, audited");

// ===========================================================================
// FALSIFIABILITY — each gate is load-bearing (asserts FAIL if a gate is stubbed).
// ===========================================================================
// (i) COMPAT is the ONLY thing rejecting the out-of-bounds version: its caps are
//     within grant (admit would PASS) and an identical entry with an in-bounds
//     range DOES load. Remove the compat check -> the bad version loads.
const futurePkg = packages.get("future-skill@3.0.0");
assert(futurePkg !== undefined, "future-skill@3.0.0 is installed");
assert(satisfies(ENGINE_VERSION, futurePkg.manifest.engineCompat) === false, "engine " + ENGINE_VERSION + " does NOT satisfy >=2.0.0");
assert(packages.checkCompat(futurePkg.manifest).ok === false, "checkCompat rejects the out-of-bounds engine range");
const futureAdmit = registry.admitPackageLoad({ agentId: "probe", sessionId: "probe", pkg: "future-skill@3.0.0", declaredCaps: futurePkg.manifest.declaredCapabilities, grantedCaps: [...resolveProfile("player.limited")] });
assert(futureAdmit.allow === true, "the out-of-compat package's caps are WITHIN grant — admit would PASS; ONLY the compat gate rejects it");
packages.install({ ...futureManifest, version: "3.0.1", engineCompat: ">=1.0.0" });
const wouldLoad = packages.load("future-skill@3.0.1", { agentId: "agt_future_ok", sessionId: "ses_future_ok", profile: "player.limited" });
assert(wouldLoad.ok && host.has("agt_future_ok"), "FALSIFIABILITY: the SAME entry with an in-bounds compat range LOADS — the compat check is what rejects 3.0.0");
host.destroy("agt_future_ok");
ops.op_log("  [falsifiable] out-of-bounds 3.0.0 admittable + only compat rejects it; identical entry @3.0.1 (>=1.0.0) loads -> compat gate is load-bearing");

// (ii) admitPackageLoad is the ONLY thing containing the over-claim at load: it
//      PASSES compat, and its raw entry loads when host.create is called directly.
//      Remove admitPackageLoad -> the over-claim slips into the sandbox.
const evilPkg = packages.get("evil-spawner@0.9.0");
assert(evilPkg !== undefined && packages.checkCompat(evilPkg.manifest).ok === true, "the over-claim package PASSES compat — compat is NOT what stops it");
host.create({ agentId: "agt_overclaim_bypass", sessionId: "ses_bypass", profile: "player.limited", code: evilPkg.manifest.entry });
assert(host.has("agt_overclaim_bypass"), "FALSIFIABILITY: bypassing admitPackageLoad, the over-claiming entry loads into the sandbox — only the admit gate contains it at load");
host.destroy("agt_overclaim_bypass");
const evilAdmit = registry.admitPackageLoad({ agentId: "probe2", sessionId: "probe2", pkg: "evil-spawner@0.9.0", declaredCaps: evilPkg.manifest.declaredCapabilities, grantedCaps: [...resolveProfile("player.limited")] });
assert(evilAdmit.allow === false && evilAdmit.rule === "package.overclaim", "the real admit gate DENIES the over-claim — removing it would let the over-claim slip");
ops.op_log("  [falsifiable] over-claim passes compat + its raw entry loads directly; admitPackageLoad is the ONLY load-time container -> admit gate is load-bearing");

// ---- the package.list skill surfaces provenance for every installed package ----
const listRes = ok(await registry.invoke("package.list", {}, builderBase));
const listed = arr(field(listRes, "packages"));
assert(listed.length >= 4, "package.list returns the installed packages (>=4), got " + listed.length);
const orbitListed = listed.find((p) => field(p, "ref") === "orbit-mover@1.2.0");
assert(orbitListed !== undefined && field(orbitListed, "attested") === true && typeof field(orbitListed, "contentHash") === "string", "package.list surfaces attestation + content-hash provenance");

// ---- teardown: every sandbox the loader created is freed ----
for (const id of ["agt_orbit", "agt_sneaky"]) assert(host.destroy(id), "destroy " + id);
assert(host.liveCount() === 0, "all package sandboxes must be freed after teardown, got " + host.liveCount());

ops.op_log("p4_packaging OK: a versioned manifest-declared third-party package loads ISOLATED (M6), is POLICY-GOVERNED (M7 quota + revocation), and is fully AUDITED (M8 provenance + decisions); an over-claim is contained at load AND at runtime with zero side effect; an out-of-compat version is rejected; compat + admitPackageLoad gates proven load-bearing (falsifiable)");
