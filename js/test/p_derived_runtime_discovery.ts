import { createHeadlessContext } from "../src/game/context.ts";
import {
  DERIVED_RUNTIME_DISCOVERY_SCHEMA,
  derivedRuntimeDiscovery,
  registerDerivedRuntimeDiscoverySkill,
} from "../src/skills/derived-runtime-discovery.ts";
import { DERIVED_RUNTIME_DISCOVERY_PERMISSION, resolveProfile } from "../src/skills/permissions.ts";
import { skillEffect } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime_discovery FAIL: ${message}`);
}

const TOKEN = "A".repeat(43);
const expected = derivedRuntimeDiscovery({
  baseUrl: "http://127.0.0.1:5174",
  token: TOKEN,
  projectId: "demo.project",
  branchId: "main",
});
assert(Object.isFrozen(expected), "validated discovery must be frozen");
assert(expected.schema === DERIVED_RUNTIME_DISCOVERY_SCHEMA, "discovery schema mismatch");

for (const invalid of [
  { ...expected, baseUrl: "http://localhost:5174" },
  { ...expected, baseUrl: "https://127.0.0.1:5174" },
  { ...expected, baseUrl: "http://127.0.0.1:5174/path" },
  { ...expected, token: "A".repeat(42) },
  { ...expected, token: "A".repeat(42) + "B" },
  { ...expected, projectId: "Bad Project" },
  { ...expected, branchId: "../other" },
] as const) {
  const { schema: _schema, ...config } = invalid;
  let rejected = false;
  try { derivedRuntimeDiscovery(config); } catch { rejected = true; }
  assert(rejected, `invalid discovery config was accepted: ${JSON.stringify(config)}`);
}
let extraRejected = false;
try {
  derivedRuntimeDiscovery({ ...expected, extra: true } as unknown as Parameters<typeof derivedRuntimeDiscovery>[0]);
} catch { extraRejected = true; }
assert(extraRejected, "extra discovery config fields must be rejected");

const ctx = createHeadlessContext({ session: "ses_derived_runtime_discovery" });
registerDerivedRuntimeDiscoverySkill(ctx.registry, expected);
const definition = ctx.registry.describe("runtime.derivedDiscovery");
assert(definition !== undefined, "discovery skill was not registered");
assert(skillEffect(definition) === "read", "discovery skill must be read-only and excluded from the world log");
assert(definition.permissions.length === 1 && definition.permissions[0] === DERIVED_RUNTIME_DISCOVERY_PERMISSION,
  "discovery skill must require its dedicated capability");

const invoke = (profile: string, permissions = resolveProfile(profile)) => ctx.registry.invoke(
  "runtime.derivedDiscovery",
  {},
  { agentId: `agent_${profile}`, sessionId: "ses_derived_runtime_discovery", profile, permissions, tick: 0, world: ctx.world },
);

for (const profile of ["reviewer", "system.readonly"]) {
  const permissions = resolveProfile(profile);
  assert(permissions.has(DERIVED_RUNTIME_DISCOVERY_PERMISSION), `${profile} is missing the discovery capability`);
  assert(ctx.registry.list(permissions).some((tool) => tool.name === "runtime.derivedDiscovery"), `${profile} cannot discover the tool`);
  const response = await invoke(profile, permissions);
  assert(response.success && JSON.stringify(response.result) === JSON.stringify(expected), `${profile} did not receive the exact discovery contract`);
  assert(Object.isFrozen(response.result), `${profile} received mutable discovery data`);
}

for (const profile of ["builder.readWrite", "builder.review", "player.full", "player.limited", "reviewer.coordinator", "system.admin", "system.derived-build"]) {
  const permissions = resolveProfile(profile);
  assert(!permissions.has(DERIVED_RUNTIME_DISCOVERY_PERMISSION), `${profile} must not hold the discovery capability`);
  assert(!ctx.registry.list(permissions).some((tool) => tool.name === "runtime.derivedDiscovery"), `${profile} can see the discovery tool`);
  const response = await invoke(profile, permissions);
  assert(!response.success && response.error?.code === "forbidden", `${profile} invocation must be forbidden`);
}

const forged = await invoke("builder.readWrite", new Set([DERIVED_RUNTIME_DISCOVERY_PERMISSION]));
assert(!forged.success && forged.error?.code === "forbidden", "a builder with a forged capability bypassed the exact-profile guard");

const trace = ctx.tracer.exportJsonl();
assert(!trace.includes(TOKEN), "derived bearer token leaked into a trace payload");
assert(!trace.includes(expected.baseUrl), "derived base URL leaked into a trace payload");

console.log("p_derived_runtime_discovery OK: strict config, exact profiles, read-only effect, and trace-secret exclusion");
