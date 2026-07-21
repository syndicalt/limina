import { ops, type Transformable } from "../src/engine.ts";
import { Position, spawnRenderable } from "../src/ecs/world.ts";
import {
  WorldProjectStateAdapter,
  WORLD_PROJECT_STATE_ADAPTER_VERSION,
} from "../src/authoring/adapters/project-state.ts";
import { SceneAuthoringAdapter } from "../src/authoring/adapters/scene.ts";
import {
  MAX_WORLD_PROJECT_TERRAIN_EDIT_LAYERS,
  MAX_WORLD_PROJECT_ASSET_ID_LENGTH,
  MAX_WORLD_PROJECT_ASSET_REFS,
  WORLD_PROJECT_STATE_SCHEMA,
  WorldProjectStateStore,
  canonicalHash,
  type AuthoringOperation,
  type AuthoringTransaction,
  type WorldProjectHead,
  type WorldProjectRefs,
  type WorldProjectState,
} from "../src/authoring/index.ts";
import {
  ACCEPT_CLOSED,
  AuthoritativeServer,
  type AuthoritativeInvocationContext,
  type NetServerTransport,
} from "../src/net/server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_project_state FAIL: ${message}`);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

class CaptureTransport extends IdleTransport {
  readonly sent: string[] = [];
  override async send(_connId: number, line: string): Promise<void> { this.sent.push(line); }
}

const projectId = "project.grey-field";
const sha256 = (canonical: string): string => ops.op_sha256(canonical);
const hash = (label: string): `sha256:${string}` => canonicalHash(sha256, { label });
const context: AuthoritativeInvocationContext = {
  agentId: "agt_project_state",
  sessionId: "ses_project_state",
  profile: "builder.readWrite",
  permissions: new Set(["authoring.read", "authoring.write", "scene.read", "ecs.modify"]),
};

function bootstrapEntity({ world }: { world: AuthoritativeServer["world"] }): void {
  const object: Transformable = {
    position: { x: 0, y: 0, z: 0, set() {} },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set() {} },
    scale: { x: 1, y: 1, z: 1, set() {} },
  };
  const eid = spawnRenderable(world.ecs, object, 1, 2, 3);
  assert(world.entities.create({ eid }) === "ent_0", "bootstrap entity identity changed");
}

function createServer(logName: string, transport: NetServerTransport = new IdleTransport()): AuthoritativeServer {
  return new AuthoritativeServer(transport, {
    sessionId: `p_authoring_project_state:${logName}`,
    tickMs: 1_000,
    worldLog: { name: logName },
    authoring: { projectId },
    bootstrap: bootstrapEntity,
  });
}

function transaction(
  transactionId: string,
  head: WorldProjectHead,
  operations: AuthoringOperation[],
  compensates?: string,
  targetProjectId = head.projectId,
): AuthoringTransaction {
  return {
    schema: "limina.authoring-transaction/v1",
    transactionId,
    projectId: targetProjectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations,
    ...(compensates === undefined ? {} : { compensates: { transactionId: compensates } }),
  };
}

function projectOperation(action: "refs.replace" | "refs.patch", input: unknown): AuthoringOperation {
  return {
    adapter: "project-state",
    adapterVersion: WORLD_PROJECT_STATE_ADAPTER_VERSION,
    action,
    input: input as AuthoringOperation["input"],
  };
}

function sceneOperation(position: [number, number, number]): AuthoringOperation {
  return {
    adapter: "scene",
    adapterVersion: "1.0.0",
    action: "transform.set",
    input: { entity: "ent_0", position },
  };
}

function refs(): WorldProjectRefs {
  return {
    mapDoc: { assetId: "maps/grey-field/mapdoc.json", hash: hash("mapdoc") },
    terrainEditLayers: [
      {
        layerId: "terrain.paint",
        assetId: "terrain/layers/paint.layer.json",
        hash: hash("paint-layer"),
        baseTopologyHash: hash("surface-topology"),
      },
      {
        layerId: "terrain.sculpt",
        assetId: "terrain/layers/sculpt.layer.json",
        hash: hash("sculpt-layer"),
        baseTopologyHash: hash("surface-topology"),
      },
    ],
    scene: { assetId: "scenes/grey-field.scene.json", hash: hash("scene") },
    assets: [
      { assetId: "assets/models/church.glb", hash: hash("church") },
      { assetId: "assets/textures/ground.ktx2", hash: hash("ground") },
    ],
    lookProfile: { assetId: "looks/grey-field.look.json", hash: hash("look") },
  };
}

async function readHead(server: AuthoritativeServer): Promise<WorldProjectHead> {
  const response = await server.invokeAuthoritatively("authoring.head", {}, context);
  assert(response.success, `authoring.head failed: ${JSON.stringify(response.error)}`);
  return response.result as WorldProjectHead;
}

async function readState(server: AuthoritativeServer): Promise<WorldProjectState> {
  const response = await server.invokeAuthoritatively("authoring.projectState", {}, context);
  assert(response.success, `authoring.projectState failed: ${JSON.stringify(response.error)}`);
  return response.result as WorldProjectState;
}

async function commit(server: AuthoritativeServer, tx: AuthoringTransaction) {
  return server.invokeAuthoritatively("authoring.commit", { transaction: tx }, context);
}

// Valid refs commit through one WorldLog, remain ordered, compensate exactly, and replay on restart.
const LOG = "p_authoring_project_state.jsonl";
ops.op_write_trace(LOG, "");
const live = createServer(LOG);
await live.ready;
const genesis = await readHead(live);
const initialState = await readState(live);
assert(initialState.schema === WORLD_PROJECT_STATE_SCHEMA && initialState.projectId === projectId, "initial projection identity is wrong");
assert(initialState.refs.mapDoc === null && initialState.refs.terrainEditLayers.length === 0, "new project did not start with explicit empty refs");

const replaceTx = transaction("tx.project-state.replace", genesis, [projectOperation("refs.replace", { projectId, refs: refs() })]);
const replaced = await commit(live, replaceTx);
assert(replaced.success, `valid refs.replace failed: ${JSON.stringify(replaced.error)}`);
const replacedHead = live.authoring!.kernel.head;
const replacedState = await readState(live);
assert(replacedState.refs.mapDoc?.assetId === "maps/grey-field/mapdoc.json", "safe project-relative mapDoc id was not retained");
assert(replacedState.refs.terrainEditLayers.map((layer) => layer.layerId).join(",") === "terrain.paint,terrain.sculpt", "terrain edit layer order changed");
assert(replacedState.stateHash === canonicalHash(sha256, {
  schema: WORLD_PROJECT_STATE_SCHEMA,
  projectId,
  refs: replacedState.refs,
}), "project state hash does not cover the strict projection core");

const denied = await live.invokeAuthoritatively("authoring.projectState", {}, {
  ...context,
  permissions: new Set(["authoring.write"]),
});
assert(!denied.success && denied.error?.code === "forbidden", "project-state read ignored authoring.read permission");

const writerA = transaction("tx.project-state.writer-a", replacedHead, [projectOperation("refs.patch", {
  projectId,
  patch: { scene: { assetId: "scenes/grey-field-v2.scene.json", hash: hash("scene-v2") } },
})]);
const writerB = transaction("tx.project-state.writer-b", replacedHead, [projectOperation("refs.patch", {
  projectId,
  patch: { lookProfile: { assetId: "looks/night.look.json", hash: hash("night") } },
})]);
const [writerAResult, writerBResult] = await Promise.all([commit(live, writerA), commit(live, writerB)]);
assert(writerAResult.success, "first exact-base source writer failed");
assert(!writerBResult.success && writerBResult.error?.code === "conflict", "stale source writer did not conflict");

const wrongProject = await commit(live, transaction(
  "tx.project-state.wrong-project",
  live.authoring!.kernel.head,
  [projectOperation("refs.patch", { projectId: "project.other", patch: { mapDoc: null } })],
  undefined,
  "project.other",
));
assert(!wrongProject.success && wrongProject.error?.code === "invalid_input", "wrong-project transaction was accepted");
const mismatchedOperation = await commit(live, transaction(
  "tx.project-state.mismatched-operation",
  live.authoring!.kernel.head,
  [projectOperation("refs.patch", { projectId: "project.other", patch: { mapDoc: null } })],
));
assert(!mismatchedOperation.success && mismatchedOperation.error?.code === "invalid_input", "operation-level project mismatch was accepted");

const compensation = transaction(
  "tx.project-state.writer-a.undo",
  live.authoring!.kernel.head,
  [],
  "tx.project-state.writer-a",
);
const compensated = await commit(live, compensation);
assert(compensated.success, `project-state compensation failed: ${JSON.stringify(compensated.error)}`);
const restoredState = await readState(live);
assert(restoredState.stateHash === replacedState.stateHash, "compensation did not restore the exact source projection");

// Invalid refs fail before mutation: hashes, traversal, layer identity/guards, ordering, and bounds.
const invalidRefs: Array<{ name: string; mutate(candidate: WorldProjectRefs): void }> = [
  { name: "absolute", mutate: (candidate) => { candidate.mapDoc!.assetId = "/etc/passwd"; } },
  { name: "backslash", mutate: (candidate) => { candidate.mapDoc!.assetId = "maps\\escape.json"; } },
  { name: "traversal", mutate: (candidate) => { candidate.mapDoc!.assetId = "maps/../escape.json"; } },
  { name: "drive", mutate: (candidate) => { candidate.mapDoc!.assetId = "C:/outside.json"; } },
  { name: "dot-segment", mutate: (candidate) => { candidate.mapDoc!.assetId = "maps/./escape.json"; } },
  { name: "empty-segment", mutate: (candidate) => { candidate.mapDoc!.assetId = "maps//escape.json"; } },
  { name: "hash", mutate: (candidate) => { candidate.mapDoc!.hash = `sha256:${"A".repeat(64)}` as `sha256:${string}`; } },
  { name: "duplicate-layer", mutate: (candidate) => { candidate.terrainEditLayers[1].layerId = candidate.terrainEditLayers[0].layerId; } },
  { name: "duplicate-asset", mutate: (candidate) => { candidate.assets[1] = { ...candidate.assets[0] }; } },
  { name: "unsorted-assets", mutate: (candidate) => { candidate.assets.reverse(); } },
  { name: "asset-id-length", mutate: (candidate) => { candidate.mapDoc!.assetId = "a".repeat(MAX_WORLD_PROJECT_ASSET_ID_LENGTH + 1); } },
];
for (const invalid of invalidRefs) {
  const candidate = JSON.parse(JSON.stringify(refs())) as WorldProjectRefs;
  invalid.mutate(candidate);
  const before = live.authoring!.projectState!.state.stateHash;
  const response = await commit(live, transaction(
    `tx.project-state.invalid-${invalid.name}`,
    live.authoring!.kernel.head,
    [projectOperation("refs.replace", { projectId, refs: candidate })],
  ));
  assert(!response.success && response.error?.code === "invalid_input", `${invalid.name} ref was accepted`);
  assert(live.authoring!.projectState!.state.stateHash === before, `${invalid.name} ref mutated project state`);
}
const missingGuard = JSON.parse(JSON.stringify(refs())) as Record<string, unknown>;
delete (missingGuard.terrainEditLayers as Array<Record<string, unknown>>)[0].baseTopologyHash;
assert(!(await commit(live, transaction(
  "tx.project-state.missing-topology-guard",
  live.authoring!.kernel.head,
  [projectOperation("refs.replace", { projectId, refs: missingGuard })],
))).success, "terrain edit layer without required topology guard was accepted");
const tooManyLayers = Array.from({ length: MAX_WORLD_PROJECT_TERRAIN_EDIT_LAYERS + 1 }, (_, index) => ({
  layerId: `layer.${index}`,
  assetId: `terrain/layers/${index}.json`,
  hash: hash(`layer:${index}`),
  baseTopologyHash: hash("surface-topology"),
}));
const oversized = await commit(live, transaction(
  "tx.project-state.too-many-layers",
  live.authoring!.kernel.head,
  [projectOperation("refs.patch", { projectId, patch: { terrainEditLayers: tooManyLayers } })],
));
assert(!oversized.success && oversized.error?.code === "invalid_input", "terrain edit layer count bound was not enforced");
const tooManyAssets = Array.from({ length: MAX_WORLD_PROJECT_ASSET_REFS + 1 }, (_, index) => ({
  assetId: `assets/generated/${String(index).padStart(5, "0")}.bin`,
  hash: hash(`asset:${index}`),
}));
const excessiveAssets = await commit(live, transaction(
  "tx.project-state.too-many-assets",
  live.authoring!.kernel.head,
  [projectOperation("refs.patch", { projectId, patch: { assets: tooManyAssets } })],
));
assert(!excessiveAssets.success && excessiveAssets.error?.code === "invalid_input", "project asset ref count bound was not enforced");
const emptyPatch = await commit(live, transaction(
  "tx.project-state.empty-patch",
  live.authoring!.kernel.head,
  [projectOperation("refs.patch", { projectId, patch: {} })],
));
assert(!emptyPatch.success && emptyPatch.error?.code === "invalid_input", "empty refs patch was accepted");
let invalidProjectRejected = false;
try { new WorldProjectStateStore("Project:Bad", sha256); } catch { invalidProjectRejected = true; }
assert(invalidProjectRejected, "non-canonical uppercase/colon project identity was accepted");

const durableHead = live.authoring!.kernel.head;
const durableState = live.authoring!.projectState!.state;
await live.shutdown();
const reboot = createServer(LOG);
await reboot.ready;
assert(reboot.authoring!.kernel.head.headHash === durableHead.headHash, "restart reconstructed a different project head");
assert(reboot.authoring!.projectState!.state.stateHash === durableState.stateHash, "restart reconstructed different source refs");
assert(reboot.authoring!.projectState!.state.refs.terrainEditLayers[0].layerId === "terrain.paint", "replay changed edit-layer order");
await reboot.shutdown();

// Adapter-version drift in the sole WorldLog fails recovery instead of reinterpreting source refs.
const DRIFT_LOG = "p_authoring_project_state_drift.jsonl";
const durableText = ops.op_read_trace(LOG);
const driftText = durableText.replace(
  '"adapter":"project-state","adapterVersion":"1.0.0"',
  '"adapter":"project-state","adapterVersion":"9.0.0"',
);
assert(driftText !== durableText, "drift fixture did not find a project-state adapter version");
ops.op_write_trace(DRIFT_LOG, driftText);
const drift = createServer(DRIFT_LOG);
let driftRejected = false;
try { await drift.ready; } catch (error) { driftRejected = error instanceof Error && error.message.includes("authoring.commit failed"); }
assert(driftRejected, "version-drifted source adapter did not reject WorldLog replay");
await drift.shutdown();

// A network read shares the authority FIFO and cannot observe a yielded half-commit.
const LINEAR_LOG = "p_authoring_project_state_linearizable.jsonl";
ops.op_write_trace(LINEAR_LOG, "");
const transport = new CaptureTransport();
const linear = createServer(LINEAR_LOG, transport);
await linear.ready;
const linearHead = await readHead(linear);
let releaseApply!: () => void;
const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
let announceApply!: () => void;
const applyStarted = new Promise<void>((resolve) => { announceApply = resolve; });
const originalProjectApply = WorldProjectStateAdapter.prototype.apply;
WorldProjectStateAdapter.prototype.apply = async function gatedApply(...args): Promise<void> {
  originalProjectApply.apply(this, args);
  announceApply();
  await applyGate;
};
const connection = {
  connId: 91,
  session: { agentId: context.agentId, sessionId: context.sessionId, profile: context.profile!, permissions: context.permissions },
  subscribed: false,
  closing: false,
  queuedIntents: 0,
  worldlogCursor: undefined as number | undefined,
};
const linearInternals = linear as unknown as {
  conns: Map<number, typeof connection>;
  handleLine(connection: typeof connection, line: string): Promise<void>;
};
linearInternals.conns.set(connection.connId, connection);
try {
  const pendingCommit = commit(linear, transaction(
    "tx.project-state.linear",
    linearHead,
    [projectOperation("refs.replace", { projectId, refs: refs() })],
  ));
  await applyStarted;
  const pendingRead = linearInternals.handleLine(connection, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "authoring.projectState", arguments: {} },
  }));
  await ops.op_sleep_ms(5);
  assert(transport.sent.length === 0, "project-state read escaped during a yielded transaction");
  releaseApply();
  assert((await pendingCommit).success, "gated source commit failed");
  await pendingRead;
  const wire = JSON.parse(transport.sent[0]) as { result?: { result?: WorldProjectState } };
  assert(wire.result?.result?.refs.mapDoc?.assetId === "maps/grey-field/mapdoc.json", "serialized read did not observe the committed projection");
} finally {
  WorldProjectStateAdapter.prototype.apply = originalProjectApply;
  await linear.shutdown();
}

// Mixed source+scene batches roll back atomically; failed rollback poisons the whole authority.
const MIXED_LOG = "p_authoring_project_state_mixed.jsonl";
ops.op_write_trace(MIXED_LOG, "");
const mixed = createServer(MIXED_LOG);
await mixed.ready;
const mixedInitialState = mixed.authoring!.projectState!.state;
const mixedInitialHead = await readHead(mixed);
const originalSceneApply = SceneAuthoringAdapter.prototype.apply;
SceneAuthoringAdapter.prototype.apply = function injectedSceneFailure(): never {
  throw new Error("injected scene failure after source mutation");
};
try {
  const failed = await commit(mixed, transaction(
    "tx.project-state.mixed-rollback",
    mixedInitialHead,
    [projectOperation("refs.replace", { projectId, refs: refs() }), sceneOperation([9, 8, 7])],
  ));
  assert(!failed.success && failed.error?.code === "handler_error", "mixed apply failure returned success");
  assert(!mixed.authoring!.kernel.poisoned, "successful mixed rollback poisoned the writer");
  assert(mixed.authoring!.projectState!.state.stateHash === mixedInitialState.stateHash, "mixed rollback left source refs changed");
  assert(Position.x[mixed.world.entities.resolve("ent_0")!.eid] === 1, "mixed rollback changed scene state");
  assert(mixed.authoring!.kernel.head.headHash === mixedInitialHead.headHash, "failed mixed batch advanced the head");
} finally {
  SceneAuthoringAdapter.prototype.apply = originalSceneApply;
}

const beforePoisonDisk = ops.op_read_trace(MIXED_LOG);
const originalProjectRollback = WorldProjectStateAdapter.prototype.rollback;
WorldProjectStateAdapter.prototype.rollback = function injectedProjectRollbackFailure(): never {
  throw new Error("injected project-state rollback failure");
};
SceneAuthoringAdapter.prototype.apply = function injectedSecondSceneFailure(): never {
  throw new Error("injected scene failure requiring project rollback");
};
try {
  const poisoned = await commit(mixed, transaction(
    "tx.project-state.mixed-poison",
    mixed.authoring!.kernel.head,
    [projectOperation("refs.replace", { projectId, refs: refs() }), sceneOperation([7, 7, 7])],
  ));
  assert(!poisoned.success && poisoned.error?.code === "handler_error", "rollback poison returned a normal commit outcome");
  assert(mixed.authoring!.kernel.poisoned, "failed project-state rollback did not poison the writer");
  const hidden = await mixed.invokeAuthoritatively("authoring.projectState", {}, context);
  assert(!hidden.success, "poisoned authority exposed dirty source refs");
  assert(ops.op_read_trace(MIXED_LOG) === beforePoisonDisk, "poisoned mixed batch reached the WorldLog");
} finally {
  WorldProjectStateAdapter.prototype.rollback = originalProjectRollback;
  SceneAuthoringAdapter.prototype.apply = originalSceneApply;
  await mixed.shutdown();
}
assert(ops.op_read_trace(MIXED_LOG) === beforePoisonDisk, "poisoned shutdown appended dirty source state");

ops.op_log(
  "p_authoring_project_state OK: strict content refs, ordered guarded edit layers, deterministic projection hashes, exact rollback/compensation, linearizable permissioned reads, stale/project isolation, replay/version drift, mixed atomicity, poison, and resource bounds are proven.",
);
