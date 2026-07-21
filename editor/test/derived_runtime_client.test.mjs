import assert from "node:assert/strict";
import test from "node:test";

import {
  DERIVED_RUNTIME_DISCOVERY_SCHEMA,
  DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
  DERIVED_RUNTIME_WORKER_SCHEMA,
  DERIVED_TERRAIN_RESIDENCY_SCHEMA,
  createDerivedRuntimeClient,
} from "../src/derived-runtime-client.js";

const hash = (character) => `sha256:${character.repeat(64)}`;
const token = "A".repeat(43);
const residency = (center = [0, 0], radius = 7) => ({ schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center, lod: 0, radius });

function discovery() {
  return {
    schema: DERIVED_RUNTIME_DISCOVERY_SCHEMA,
    baseUrl: "http://127.0.0.1:5174",
    token,
    projectId: "grey-field",
    branchId: "main",
  };
}

function snapshot(revision = 7, resident = residency()) {
  const source = {
    revision,
    headHash: hash("a"),
    contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/grey-field.json", contentHash: hash("b") }],
  };
  const manifestHash = hash("c");
  const chunk = { chunkId: "surface:grey-field.surface:l0:x0:z0", lod: 0, tx: 0, tz: 0 };
  const manifest = {
    schema: "limina.derived-revision-manifest/v2",
    projectId: "grey-field",
    branchId: "main",
    source,
    compiler: {},
    grid: {},
    globalArtifacts: [],
    chunks: [chunk],
    manifestHash,
  };
  return {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: "grey-field",
    branchId: "main",
    manifestHash,
    source,
    manifest,
    residency: resident,
    chunks: [{ chunkId: chunk.chunkId, chunk, resource: {} }],
    globals: [],
  };
}

class FakeWorker {
  onmessage = null;
  onerror = null;
  sent = [];
  terminated = 0;

  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated++; }
  emit(message) { this.onmessage?.({ data: message }); }
  fail(message = "contains-secret") { this.onerror?.({ message }); }
}

function harness({ activate = async () => {}, closeTimeoutMs = 50 } = {}) {
  const worker = new FakeWorker();
  const statuses = [];
  const client = createDerivedRuntimeClient({
    activate,
    onStatus: (status) => statuses.push(status),
    workerFactory: () => worker,
    closeTimeoutMs,
  });
  return { worker, statuses, client };
}

function ready(state, mode) {
  const init = state.worker.sent[0];
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "ready", requestId: init.requestId, mode });
}

function activation(state, value = snapshot(), id = "derived-activation-1", requestId) {
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "activate", activationId: id,
    ...(requestId === undefined ? {} : { requestId }), snapshot: value });
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

test("watch initialization sends the capability only to one worker and exposes bounded metadata", () => {
  const state = harness();
  state.client.start(discovery(), { mode: "watch", residency: residency([12, -8], 3) });
  assert.equal(state.worker.sent.length, 1);
  assert.equal(state.worker.sent[0].type, "init");
  assert.equal(state.worker.sent[0].config.token, token);
  assert.equal(state.worker.sent[0].mode, "watch");
  assert.deepEqual(state.worker.sent[0].residency, residency([12, -8], 3));
  assert.equal("pinnedSource" in state.worker.sent[0], false);
  ready(state, "watch");
  assert.equal(state.client.phase, "ready");
  assert.deepEqual(state.statuses.map(({ phase }) => phase), ["starting", "ready"]);
  assert.equal(state.statuses.every(Object.isFrozen), true);
  assert.equal(JSON.stringify(state.client).includes(token), false);
  assert.equal(JSON.stringify(state.statuses).includes(token), false);
  assert.equal(JSON.stringify(state.statuses).includes("127.0.0.1"), false);
});

test("pinned initialization requires and forwards the exact source", () => {
  const state = harness();
  const pinnedSource = { revision: 7, headHash: hash("a"), manifestHash: hash("c") };
  state.client.start(discovery(), { mode: "pinned", pinnedSource, residency: residency() });
  assert.deepEqual(state.worker.sent[0].pinnedSource, pinnedSource);
  ready(state, "pinned");
  assert.equal(state.client.mode, "pinned");
  assert.throws(() => harness().client.start(discovery(), { mode: "pinned", residency: residency() }), /requires pinnedSource/);
  assert.throws(() => harness().client.start(discovery(), { mode: "watch", pinnedSource, residency: residency() }), /forbids/);
  assert.throws(() => harness().client.start(discovery(), { mode: "watch", residency: residency([0, 0], 8) }), /terrain residency/);
  assert.throws(() => harness().client.start(discovery(), { mode: "watch" }), /terrain residency/);
});

test("residency updates wait for an exact acknowledgement and coalesce to one latest pending request", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  const beforeReady = state.client.setResidency(residency([64, 0]));
  const coalescedBeforeReady = state.client.setResidency(residency([128, 0]));
  assert.equal(beforeReady, coalescedBeforeReady);
  assert.equal(state.worker.sent.filter(({ type }) => type === "set-residency").length, 0);

  ready(state, "watch");
  const first = state.worker.sent.at(-1);
  assert.deepEqual(first.residency, residency([128, 0]));
  const duplicate = state.client.setResidency(residency([128, 0]));
  assert.equal(duplicate, beforeReady);
  const pending = state.client.setResidency(residency([192, 0]));
  const latestPending = state.client.setResidency(residency([256, 0]));
  assert.equal(pending, latestPending);
  assert.equal(state.worker.sent.filter(({ type }) => type === "set-residency").length, 1);

  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "residency-ack",
    requestId: first.requestId,
    residency: first.residency,
  });
  await beforeReady;
  const second = state.worker.sent.at(-1);
  assert.equal(second.type, "set-residency");
  assert.deepEqual(second.residency, residency([256, 0]));
  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "residency-ack",
    requestId: second.requestId,
    residency: second.residency,
  });
  await pending;
  activation(state, snapshot(7, residency([256, 0])));
  await tick();
  assert.equal(state.worker.sent.at(-1).type, "activation-ack");
  assert.equal(state.statuses.filter(({ phase }) => phase === "residency").length, 2);
});

test("residency coalescing preserves the final camera window when it returns to the in-flight value", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const windowA = state.client.setResidency(residency([64, 0]));
  const first = state.worker.sent.at(-1);
  const coalesced = state.client.setResidency(residency([128, 0]));
  const returnedToA = state.client.setResidency(residency([64, 0]));
  assert.equal(returnedToA, coalesced, "the final update must remain behind the in-flight serialization boundary");

  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "residency-ack",
    requestId: first.requestId,
    residency: first.residency,
  });
  await Promise.all([windowA, coalesced]);
  assert.equal(state.worker.sent.filter(({ type }) => type === "set-residency").length, 1,
    "returning to the accepted in-flight window must not send a stale intermediate window");
});

test("an older activation remains valid until the worker acknowledges the new residency", async () => {
  let release;
  let calls = 0;
  const state = harness({ activate: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve() });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const update = state.client.setResidency(residency([64, 0]));
  const request = state.worker.sent.at(-1);
  activation(state, snapshot());
  await tick();
  assert.equal(state.client.phase, "ready");
  release();
  await tick();
  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "residency-ack",
    requestId: request.requestId,
    residency: request.residency,
  });
  await update;
  activation(state, snapshot(7, residency([64, 0])), "derived-activation-2");
  await tick();
  assert.equal(state.client.phase, "ready");
  assert.equal(state.worker.sent.at(-1).activationId, "derived-activation-2");
});

test("malformed residency acknowledgements fail closed without advancing expected residency", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const update = state.client.setResidency(residency([64, 0]));
  update.catch(() => {});
  const request = state.worker.sent.at(-1);
  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "residency-ack",
    requestId: `${request.requestId}-wrong`,
    residency: request.residency,
  });
  await tick();
  assert.equal(state.client.phase, "closing");
  assert.equal(state.statuses.some(({ code }) => code === "PROTOCOL_ERROR"), true);
});

test("close rejects sent and pending residency work and emits no late update", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const sent = state.client.setResidency(residency([64, 0]));
  const pending = state.client.setResidency(residency([128, 0]));
  const sentRejected = assert.rejects(sent, /closed before residency/);
  const pendingRejected = assert.rejects(pending, /closed before residency/);
  const closing = state.client.close();
  await Promise.all([sentRejected, pendingRejected]);
  const closeRequest = state.worker.sent.at(-1);
  assert.equal(closeRequest.type, "close");
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "closed", requestId: closeRequest.requestId });
  await closing;
  assert.equal(state.worker.sent.filter(({ type }) => type === "set-residency").length, 1);
});

test("successful activation awaits the adapter before accepting", async () => {
  let release;
  const applied = [];
  const state = harness({ activate: (value) => new Promise((resolve) => { applied.push(value); release = resolve; }) });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const value = snapshot();
  activation(state, value);
  await tick();
  assert.equal(applied[0], value);
  assert.equal(state.worker.sent.some(({ type }) => type === "activation-ack"), false);
  release();
  await tick();
  assert.deepEqual(state.worker.sent.at(-1), {
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: "derived-activation-1",
    accepted: true,
  });
});

test("explicit reconciliation resolves in the activation microtask and later revision validates it", async () => {
  let release;
  const state = harness({ activate: () => new Promise((resolve) => { release = resolve; }) });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const requested = residency([256, -128]);
  const result = state.client.reconcileResidency(requested);
  const request = state.worker.sent.at(-1);
  assert.equal(request.type, "reconcile-residency");
  assert.deepEqual(request.residency, requested);

  activation(state, snapshot(7, requested), "derived-activation-10", request.requestId);
  let settled = false;
  result.finally(() => { settled = true; });
  await tick();
  assert.equal(settled, false, "reconciliation settled before the activation callback completed");
  release();
  await tick();
  assert.deepEqual(state.worker.sent.at(-1), {
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: "derived-activation-10",
    requestId: request.requestId,
    accepted: true,
  });
  assert.equal(settled, true, "reconciliation did not settle immediately after exact main-thread activation");
  assert.deepEqual(await result, { status: "activated", manifestHash: hash("c"), revision: 7 });
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "activated", manifestHash: hash("c"), revision: 7 });
  await tick();
  assert.equal(state.client.phase, "ready");
});

test("explicit unchanged reconciliation resolves without activation and exact correlation is mandatory", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const result = state.client.reconcileResidency(residency());
  const request = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "unchanged", manifestHash: hash("c"), revision: 7 });
  assert.deepEqual(await result, { status: "unchanged", manifestHash: hash("c"), revision: 7 });
  assert.equal(state.worker.sent.some(({ type }) => type === "activation-ack"), false);

  const malformed = harness();
  malformed.client.start(discovery(), { residency: residency() });
  ready(malformed, "watch");
  const pending = malformed.client.reconcileResidency(residency([64, 0]));
  pending.catch(() => {});
  malformed.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: "derived-reconcile-wrong",
    status: "unchanged", manifestHash: hash("c"), revision: 7 });
  await tick();
  assert.equal(malformed.client.phase, "closing");
  assert.equal(malformed.statuses.some(({ code }) => code === "PROTOCOL_ERROR"), true);
});

test("a worker revision cannot contradict an already activated reconciliation", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const requested = residency([64, 0]);
  const result = state.client.reconcileResidency(requested);
  const request = state.worker.sent.at(-1);
  activation(state, snapshot(7, requested), "derived-activation-12", request.requestId);
  assert.deepEqual(await result, { status: "activated", manifestHash: hash("c"), revision: 7 });

  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "unchanged", manifestHash: hash("c"), revision: 7 });
  await tick();
  assert.equal(state.client.phase, "closing");
  assert.equal(state.statuses.some(({ code }) => code === "PROTOCOL_ERROR"), true);
});

test("an exact superseded reconciliation rejects with a stable public error", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const result = state.client.reconcileResidency(residency([64, 0]));
  const request = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "superseded", manifestHash: hash("c"), revision: 7 });
  await assert.rejects(result, (error) => error.code === "DERIVED_RESIDENCY_SUPERSEDED");
  assert.equal(state.client.phase, "ready");
});

test("an older generic activation cannot satisfy a queued explicit reconciliation", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const requested = residency([64, 0]);
  const result = state.client.reconcileResidency(requested);
  const request = state.worker.sent.at(-1);
  let settled = false;
  result.finally(() => { settled = true; });
  activation(state, snapshot(), "derived-activation-20");
  await tick();
  assert.equal(state.worker.sent.at(-1).activationId, "derived-activation-20");
  assert.equal("requestId" in state.worker.sent.at(-1), false);
  assert.equal(settled, false, "an uncorrelated older activation satisfied the reconciliation");
  activation(state, snapshot(7, requested), "derived-activation-21", request.requestId);
  await tick();
  assert.deepEqual(await result, { status: "activated", manifestHash: hash("c"), revision: 7 });
});

test("reconciliation retains transient retries but rejects outside-domain and fatal outcomes", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const requested = residency([64, 0]);
  const result = state.client.reconcileResidency(requested);
  const request = state.worker.sent.at(-1);
  let settled = false;
  result.finally(() => { settled = true; });
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "error", requestId: request.requestId,
    code: "STALE_SOURCE_HEAD", classification: "transient", message: `redacted by client ${token}` });
  await tick();
  assert.equal(settled, false, "transient correlated failure discarded the reconciliation");
  assert.equal(JSON.stringify(state.statuses).includes(token), false);
  activation(state, snapshot(7, requested), "derived-activation-11", request.requestId);
  await tick();
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "activated", manifestHash: hash("c"), revision: 7 });
  await result;

  const outside = state.client.reconcileResidency(residency([100_000, 100_000]));
  const outsideRequest = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "error", requestId: outsideRequest.requestId,
    code: "RESIDENCY_OUTSIDE_DOMAIN", classification: "transient", message: "outside" });
  await assert.rejects(outside, (error) => error.code === "RESIDENCY_OUTSIDE_DOMAIN");
  assert.equal(state.client.phase, "ready", "outside-domain reconciliation closed the healthy prior runtime");

  const fatalState = harness();
  fatalState.client.start(discovery(), { residency: residency() });
  ready(fatalState, "watch");
  const fatalResult = fatalState.client.reconcileResidency(residency([64, 0]));
  const fatalRequest = fatalState.worker.sent.at(-1);
  fatalState.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "error", requestId: fatalRequest.requestId,
    code: "BROKEN_ARTIFACT", classification: "fatal", message: `private ${token}` });
  await assert.rejects(fatalResult, (error) => error.code === "BROKEN_ARTIFACT" && !error.message.includes(token));
  assert.equal(fatalState.client.phase, "closing");
});

test("rapid reconciliation coalescing preserves exact A to B to A last-write-wins behavior", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const a = residency([64, 0]);
  const firstA = state.client.reconcileResidency(a);
  const requestA = state.worker.sent.at(-1);
  const b = state.client.reconcileResidency(residency([128, 0]));
  const finalA = state.client.reconcileResidency(a);
  assert.equal(finalA, firstA);
  await assert.rejects(b, (error) => error.code === "DERIVED_RESIDENCY_SUPERSEDED");
  assert.equal(state.worker.sent.filter(({ type }) => type === "reconcile-residency").length, 1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: requestA.requestId,
    status: "unchanged", manifestHash: hash("c"), revision: 7 });
  await Promise.all([firstA, finalA]);
});

test("continuous residency forwarding serializes behind explicit reconciliation", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const jump = residency([64, 0]);
  const reconciliation = state.client.reconcileResidency(jump);
  const request = state.worker.sent.at(-1);
  const forwarding = state.client.setResidency(residency([128, 0]));
  assert.equal(state.worker.sent.filter(({ type }) => type === "set-residency").length, 0,
    "continuous forwarding overtook an explicit reconciliation");
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", requestId: request.requestId,
    status: "unchanged", manifestHash: hash("c"), revision: 7 });
  await reconciliation;
  const forwarded = state.worker.sent.at(-1);
  assert.equal(forwarded.type, "set-residency");
  assert.deepEqual(forwarded.residency, residency([128, 0]));
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "residency-ack", requestId: forwarded.requestId, residency: forwarded.residency });
  await forwarding;
});

test("close rejects sent and pending explicit reconciliations", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const sent = state.client.reconcileResidency(residency([64, 0]));
  const pending = state.client.reconcileResidency(residency([128, 0]));
  const closing = state.client.close();
  await Promise.all([
    assert.rejects(sent, /closed before residency work completed/),
    assert.rejects(pending, /closed before residency work completed/),
  ]);
  const closeRequest = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "closed", requestId: closeRequest.requestId });
  await closing;
});

test("activation failure returns one stable secret-free rejection", async () => {
  const state = harness({ activate: async () => { throw new Error(`adapter leaked ${token}`); } });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  activation(state);
  await tick();
  assert.deepEqual(state.worker.sent.at(-1), {
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: "derived-activation-1",
    accepted: false,
    errorCode: "VIEWPORT_ACTIVATION_FAILED",
  });
  assert.equal(JSON.stringify(state.statuses).includes(token), false);
  assert.equal(state.statuses.at(-1).code, "VIEWPORT_ACTIVATION_FAILED");
});

test("close aborts an in-flight activation and no late acknowledgement escapes", async () => {
  let signal;
  let release;
  const state = harness({ activate: (_snapshot, options) => {
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  activation(state);
  await tick();
  assert.equal(signal.aborted, false);
  const closing = state.client.close();
  assert.equal(signal.aborted, true);
  release();
  await tick();
  assert.equal(state.worker.sent.filter(({ type }) => type === "activation-ack").length, 0);
  const request = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "closed", requestId: request.requestId });
  await closing;
});

test("malformed output fails closed and late output cannot reactivate", async () => {
  let activations = 0;
  const state = harness({ activate: async () => { activations++; } });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "revision", status: "activated", manifestHash: hash("d"), revision: 1, extra: true });
  await tick();
  assert.equal(state.client.phase, "closing");
  assert.equal(state.statuses.some(({ code }) => code === "PROTOCOL_ERROR"), true);
  activation(state);
  await tick();
  assert.equal(activations, 0);
  const close = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "closed", requestId: close.requestId });
  await state.client.close();
  assert.equal(state.worker.terminated, 1);
});

test("snapshot source, manifest envelope, and pin mismatches are rejected", async () => {
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.source = { ...value.source, extra: true }; value.manifest.source = value.source; },
    (value) => { value.manifest = { ...value.manifest, manifestHash: hash("e") }; },
    (value) => { value.projectId = "another"; },
    (value) => { value.residency = residency([99, 99], 0); },
  ]) {
    const state = harness();
    state.client.start(discovery(), { residency: residency() });
    ready(state, "watch");
    const value = snapshot();
    mutate(value);
    activation(state, value);
    await tick();
    assert.equal(state.client.phase, "closing");
    assert.equal(state.statuses.some(({ code }) => code === "PROTOCOL_ERROR"), true);
  }

  const pinned = harness();
  pinned.client.start(discovery(), { mode: "pinned", pinnedSource: { revision: 8, headHash: hash("a") }, residency: residency() });
  ready(pinned, "pinned");
  activation(pinned, snapshot(7));
  await tick();
  assert.equal(pinned.client.phase, "closing");

  const manifestPinned = harness();
  manifestPinned.client.start(discovery(), {
    mode: "pinned",
    pinnedSource: { revision: 7, headHash: hash("a"), manifestHash: hash("e") },
    residency: residency(),
  });
  ready(manifestPinned, "pinned");
  activation(manifestPinned, snapshot(7));
  await tick();
  assert.equal(manifestPinned.client.phase, "closing");
});

test("fatal worker errors expose codes only and trigger bounded close", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "error",
    code: "BROKEN_ARTIFACT",
    classification: "fatal",
    message: `sensitive ${token}`,
  });
  await tick();
  assert.equal(JSON.stringify(state.statuses).includes(token), false);
  assert.deepEqual(state.statuses.at(-1), { phase: "error", mode: "watch", code: "BROKEN_ARTIFACT", classification: "fatal" });
  assert.equal(state.client.phase, "closing");
});

test("native worker errors cannot leak event text", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  state.worker.fail(`native worker included ${token}`);
  await tick();
  assert.equal(state.client.phase, "closing");
  assert.equal(JSON.stringify(state.statuses).includes(token), false);
  assert.equal(state.statuses.some(({ code }) => code === "WORKER_ERROR"), true);
});

test("matching close handshake terminates once and ignores later messages", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const closing = state.client.close();
  assert.equal(state.client.close(), closing);
  const request = state.worker.sent.at(-1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "closed", requestId: request.requestId });
  await closing;
  assert.equal(state.client.phase, "closed");
  assert.equal(state.worker.terminated, 1);
  state.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "activate", activationId: "derived-activation-9", snapshot: snapshot() });
  assert.equal(state.worker.terminated, 1);
});

test("close timeout forcibly terminates an unresponsive worker", async () => {
  const state = harness({ closeTimeoutMs: 10 });
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  await state.client.close();
  assert.equal(state.client.phase, "closed");
  assert.equal(state.worker.terminated, 1);
  assert.equal(state.statuses.at(-1).phase, "closed");
});

test("fetch progress forwards the exact loading-screen contract and rejects out-of-contract counts", async () => {
  const state = harness();
  state.client.start(discovery(), { residency: residency() });
  ready(state, "watch");
  const progress = (fetched, total, extra = {}) => state.worker.emit({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "fetch-progress", fetched, total, ...extra,
  });
  progress(0, 3);
  progress(1, 3);
  progress(3, 3);
  const events = state.statuses.filter(({ phase }) => phase === "fetch");
  assert.deepEqual(events, [
    { phase: "fetch", fetched: 0, total: 3 },
    { phase: "fetch", fetched: 1, total: 3 },
    { phase: "fetch", fetched: 3, total: 3 },
  ]);
  assert.equal(events.every(Object.isFrozen), true);
  progress(4, 3);
  await tick();
  assert.equal(state.client.phase, "closing", "fetched exceeding total was not a fatal protocol violation");
  const beforeError = state.statuses.filter(({ phase }) => phase === "fetch").length;
  assert.equal(beforeError, 3, "out-of-contract progress leaked into the loading screen");

  const malformed = harness();
  malformed.client.start(discovery(), { residency: residency() });
  ready(malformed, "watch");
  malformed.worker.emit({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "fetch-progress", fetched: 1, total: 2, manifest: {} });
  await tick();
  assert.equal(malformed.client.phase, "closing", "an extra progress field was not a fatal protocol violation");
});
