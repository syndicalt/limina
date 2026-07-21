import { ops } from "../src/engine.ts";
import { StaticAuthoringAdapterAllowlist } from "../src/authoring/adapter.ts";
import { createWorldProjectStateAuthoring } from "../src/authoring/adapters/project-state.ts";
import { canonicalHash } from "../src/authoring/canonical.ts";
import { registerAuthoringSkills } from "../src/authoring/skills.ts";
import {
  WORLD_PROJECT_SOURCE_SNAPSHOT_SCHEMA,
  parseWorldProjectSourceSnapshot,
  type WorldProjectSourceSnapshot,
} from "../src/authoring/source-snapshot.ts";
import type { AuthoringTransaction, WorldProjectHead } from "../src/authoring/schema.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const projectId = "source-snapshot-fixture";
const sha256 = (canonical: string): string => ops.op_sha256(canonical);
const project = createWorldProjectStateAuthoring(projectId, sha256);
const headless = createHeadlessContext({ session: "ses_source_snapshot" });
const registry = headless.registry;
const runtime = registerAuthoringSkills(registry, {
  projectId,
  sha256,
  adapters: new StaticAuthoringAdapterAllowlist([project.adapter]),
  projectState: project.projectState,
});
const context = {
  ...headless.base,
  agentId: "agt_source_snapshot",
  permissions: new Set(["authoring.read", "authoring.write"]),
};

async function invoke(name: string, input: unknown = {}) {
  const result = await registry.invoke(name, input, context);
  assert(result.success, `${name} failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

const initial = await invoke("authoring.sourceSnapshot") as WorldProjectSourceSnapshot;
assert(initial.schema === WORLD_PROJECT_SOURCE_SNAPSHOT_SCHEMA, "source snapshot schema drifted");
assert(initial.head.revision === 0 && initial.projectState.refs.mapDoc === null, "source snapshot did not expose genesis authority");
assert(Object.isFrozen(initial) && Object.isFrozen(initial.head) && Object.isFrozen(initial.projectState.refs), "source snapshot is mutable");
parseWorldProjectSourceSnapshot(sha256, initial);

const asset = { assetId: "sources/map-doc/fixture.mapdoc.json", hash: canonicalHash(sha256, { fixture: true }) };
const transaction: AuthoringTransaction = {
  schema: "limina.authoring-transaction/v1",
  transactionId: "tx.source-snapshot.commit",
  projectId,
  baseRevision: initial.head.revision,
  baseHeadHash: initial.head.headHash,
  operations: [{
    adapter: "project-state",
    adapterVersion: "1.0.0",
    action: "refs.patch",
    input: { projectId, patch: { mapDoc: asset } },
  }],
};
await invoke("authoring.commit", { transaction });

const committed = await invoke("authoring.sourceSnapshot") as WorldProjectSourceSnapshot;
assert(committed.head.revision === 1, "source snapshot returned a stale head");
assert(committed.projectState.refs.mapDoc?.hash === asset.hash, "source snapshot returned stale source refs");
assert(committed.snapshotHash !== initial.snapshotHash, "authority mutation did not change source snapshot identity");
parseWorldProjectSourceSnapshot(sha256, committed);

// A commit may yield after its adapter mutates state but before the kernel publishes
// the next head. Authority reads must queue behind that whole transaction instead of
// exposing the impossible old-head/new-state combination.
let releaseApply!: () => void;
let reportApplied!: () => void;
const applyBlocked = new Promise<void>((resolve) => { releaseApply = resolve; });
const stateMutated = new Promise<void>((resolve) => { reportApplied = resolve; });
const originalApply = project.adapter.apply.bind(project.adapter);
project.adapter.apply = async (operation): Promise<void> => {
  originalApply(operation);
  reportApplied();
  await applyBlocked;
};
const nextAsset = { assetId: "sources/map-doc/next.mapdoc.json", hash: canonicalHash(sha256, { fixture: "next" }) };
const concurrentTransaction: AuthoringTransaction = {
  schema: "limina.authoring-transaction/v1",
  transactionId: "tx.source-snapshot.in-flight",
  projectId,
  baseRevision: committed.head.revision,
  baseHeadHash: committed.head.headHash,
  operations: [{
    adapter: "project-state",
    adapterVersion: "1.0.0",
    action: "refs.patch",
    input: { projectId, patch: { mapDoc: nextAsset } },
  }],
};
const concurrentCommit = invoke("authoring.commit", { transaction: concurrentTransaction });
await stateMutated;
let readSettled = false;
const queuedRead = invoke("authoring.sourceSnapshot").then((value) => { readSettled = true; return value as WorldProjectSourceSnapshot; });
await Promise.resolve();
await Promise.resolve();
assert(!readSettled, "source snapshot escaped while an adapter mutation was not yet bound to a head");
releaseApply();
await concurrentCommit;
const afterConcurrent = await queuedRead;
assert(afterConcurrent.head.revision === 2 && afterConcurrent.projectState.refs.mapDoc?.hash === nextAsset.hash,
  "serialized source snapshot did not bind the completed commit head and state");
parseWorldProjectSourceSnapshot(sha256, afterConcurrent);

const tamperedState = JSON.parse(JSON.stringify(committed)) as WorldProjectSourceSnapshot;
(tamperedState.projectState.refs as { mapDoc: typeof asset | null }).mapDoc = null;
let tamperRejected = false;
try { parseWorldProjectSourceSnapshot(sha256, tamperedState); } catch { tamperRejected = true; }
assert(tamperRejected, "source snapshot state tampering was accepted");

const tamperedHead = JSON.parse(JSON.stringify(committed)) as WorldProjectSourceSnapshot;
(tamperedHead.head as WorldProjectHead).revision = 0;
tamperRejected = false;
try { parseWorldProjectSourceSnapshot(sha256, tamperedHead); } catch { tamperRejected = true; }
assert(tamperRejected, "source snapshot head tampering was accepted");

const accessorSnapshot = JSON.parse(JSON.stringify(committed)) as Record<string, unknown>;
Object.defineProperty(accessorSnapshot, "head", { enumerable: true, get() { throw new Error("must not execute"); } });
tamperRejected = false;
try { parseWorldProjectSourceSnapshot(sha256, accessorSnapshot); } catch { tamperRejected = true; }
assert(tamperRejected, "source snapshot accessor was accepted or executed");

const forbidden = await registry.invoke("authoring.sourceSnapshot", {}, {
  ...context,
  permissions: new Set<string>(),
});
assert(!forbidden.success && forbidden.error?.code === "forbidden", "source snapshot bypassed authoring.read");

const withoutProjection = new SkillRegistry();
registerAuthoringSkills(withoutProjection, {
  projectId: "head-only",
  sha256,
  adapters: new StaticAuthoringAdapterAllowlist([]),
});
assert(!withoutProjection.has("authoring.sourceSnapshot"), "source snapshot registered without a source projection");

const restrictedProjectId = "derived-profile-fixture";
const restrictedProject = createWorldProjectStateAuthoring(restrictedProjectId, sha256);
const restrictedRegistry = createHeadlessContext({ session: "ses_derived_profile" });
const restrictedRuntime = registerAuthoringSkills(restrictedRegistry.registry, {
  projectId: restrictedProjectId,
  sha256,
  adapters: new StaticAuthoringAdapterAllowlist([restrictedProject.adapter]),
  projectState: restrictedProject.projectState,
});
const restrictedContext = {
  ...restrictedRegistry.base,
  agentId: "agt_derived_build",
  profile: "system.derived-build",
  permissions: new Set(["authoring.read", "authoring.write"]),
};
const forbiddenTransaction: AuthoringTransaction = {
  schema: "limina.authoring-transaction/v1",
  transactionId: "tx.derived-profile.arbitrary",
  projectId: restrictedProjectId,
  baseRevision: restrictedRuntime.kernel.head.revision,
  baseHeadHash: restrictedRuntime.kernel.head.headHash,
  operations: [{
    adapter: "project-state",
    adapterVersion: "1.0.0",
    action: "refs.patch",
    input: { projectId: restrictedProjectId, patch: { scene: asset } },
    guard: { beforeHash: restrictedProject.projectState.state.stateHash },
  }],
};
const forbiddenDerivedCommit = await restrictedRegistry.registry.invoke("authoring.commit", { transaction: forbiddenTransaction }, restrictedContext);
assert(!forbiddenDerivedCommit.success && forbiddenDerivedCommit.error?.code === "forbidden",
  "system.derived-build escaped its genesis MapDoc-only transaction boundary");
const bootstrapAsset = { assetId: "assets/sources/map-doc/bootstrap.json", hash: canonicalHash(sha256, { bootstrap: true }) };
const allowedBootstrap: AuthoringTransaction = {
  schema: "limina.authoring-transaction/v1",
  transactionId: `bootstrap-mapdoc-${bootstrapAsset.hash.slice(7, 39)}`,
  projectId: restrictedProjectId,
  baseRevision: restrictedRuntime.kernel.head.revision,
  baseHeadHash: restrictedRuntime.kernel.head.headHash,
  operations: [{
    adapter: "project-state",
    adapterVersion: "1.0.0",
    action: "refs.patch",
    input: { projectId: restrictedProjectId, patch: { mapDoc: bootstrapAsset } },
    guard: { beforeHash: restrictedProject.projectState.state.stateHash },
  }],
};
const allowedDerivedCommit = await restrictedRegistry.registry.invoke("authoring.commit", { transaction: allowedBootstrap }, restrictedContext);
assert(allowedDerivedCommit.success && restrictedRuntime.kernel.head.revision === 1
  && restrictedProject.projectState.state.refs.mapDoc?.hash === bootstrapAsset.hash,
"system.derived-build could not execute its one allowed guarded genesis MapDoc transaction");

ops.op_log(
  `p_authoring_source_snapshot OK: serialized authority reads bind revision ${afterConcurrent.head.revision}, head ${afterConcurrent.head.headHash}, and state ${afterConcurrent.projectState.stateHash} into ${afterConcurrent.snapshotHash}; in-flight mutation isolation, tampering, permissions, immutability, and missing-projection behavior are proven.`,
);
