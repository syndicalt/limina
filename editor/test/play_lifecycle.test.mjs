import assert from "node:assert/strict";

globalThis.document = { getElementById: () => null };

const {
  CoalescedTask,
  PlayLifecycleController,
  RetainedEditRestore,
  assertEditorAuthoringAllowed,
  createPlaySnapshot,
  playLifecycle,
} = await import("../src/play-lifecycle.js");
const { commitSceneOperations, deformTerrain } = await import("../src/write-client.js");

const hash = (char) => `sha256:${char.repeat(64)}`;
const head = { schema: "limina.world-project-head/v1", projectId: "grey-field", revision: 9, headHash: hash("a") };
const sourceCommands = [{ kind: "skill", tool: "scene.createEntity", input: { id: "a", position: [1, 2, 3] } }];
const snapshot = createPlaySnapshot(sourceCommands, head, 14);

sourceCommands[0].input.position[0] = 999;
head.revision = 99;
assert.equal(snapshot.commands[0].input.position[0], 1, "snapshot must not alias live commands");
assert.equal(snapshot.source.revision, 9, "snapshot must not alias the live project head");
assert.throws(() => { snapshot.commands[0].input.position[0] = 7; }, TypeError, "nested snapshot state must be frozen");

const phases = [];
const lifecycle = new PlayLifecycleController();
lifecycle.subscribe((view) => phases.push(view.phase));
const first = lifecycle.begin();
assert.equal(first.accepted, true);
const duplicate = lifecycle.begin();
assert.deepEqual(duplicate, { accepted: false, coalesced: true, token: first.token });
assert.equal(lifecycle.capture(first.token, snapshot), true);
assert.equal(lifecycle.started(first.token), true);
assert.equal(lifecycle.paused(first.token), true);
assert.equal(lifecycle.paused(first.token), false, "repeated pause is deterministic");
assert.equal(lifecycle.resumed(first.token), true);
assert.equal(lifecycle.markStale(14), false, "captured cursor is not stale");
assert.equal(lifecycle.markStale(15), true, "new command tip marks the isolated run stale");
assert.equal(lifecycle.requestStop().accepted, true);
assert.equal(lifecycle.requestStop().accepted, false, "repeated stop coalesces");
assert.equal(lifecycle.started(first.token), false, "a late start cannot escape stopping");
lifecycle.finishEdit();
assert.deepEqual(phases, ["starting", "starting", "playing", "paused", "playing", "playing", "stopping", "edit"]);

const recovery = new PlayLifecycleController();
const recoveryStart = recovery.begin();
recovery.capture(recoveryStart.token, snapshot);
recovery.started(recoveryStart.token);
recovery.requestStop();
assert.equal(recovery.restoreFailed(new Error("renderer unavailable")), true);
assert.equal(recovery.phase, "error");
assert.equal(recovery.isAuthoringLocked(), true, "failed restore must remain fail-closed");
assert.equal(recovery.requestStop().accepted, true, "Stop from Error must begin a deterministic restore retry");
recovery.finishEdit();
assert.equal(recovery.phase, "edit");
assert.equal(recovery.isAuthoringLocked(), false, "only a successful retry may unlock authoring");

const listenerSafe = new PlayLifecycleController();
let listenerErrors = 0;
const originalConsoleError = console.error;
console.error = () => { listenerErrors++; };
try {
  listenerSafe.subscribe(() => { throw new Error("broken UI observer"); });
  const listenerStart = listenerSafe.begin();
  assert.equal(listenerStart.accepted, true, "throwing observer must not abort begin");
  assert.equal(listenerSafe.capture(listenerStart.token, snapshot), true, "throwing observer must not abort capture");
  assert.equal(listenerSafe.started(listenerStart.token), true, "throwing observer must not abort started");
} finally {
  console.error = originalConsoleError;
}
assert.equal(listenerSafe.phase, "playing");
assert.equal(listenerErrors, 3, "every observer failure must remain observable");

let rejectPoll;
let polls = 0;
const pollTask = new CoalescedTask();
const failedPull = new Promise((_, reject) => { rejectPoll = reject; });
const nonStrict = pollTask.run(() => { polls++; return failedPull; }, { strict: false });
const strictJoin = pollTask.run(() => { polls++; return Promise.resolve(); }, { strict: true });
rejectPoll(new Error("authoritative pull failed"));
assert.equal(await nonStrict, undefined, "routine polling may surface a logged failure without rejecting its loop");
await assert.rejects(strictJoin, /authoritative pull failed/, "strict Play sync joining the same poll must retain its rejection");
assert.equal(polls, 1, "strict/non-strict poll race must coalesce to one authoritative pull");

const savedEditState = Object.freeze({ selection: "ent_7", camera: Object.freeze([1, 2, 3]), tool: "paint" });
const retainedRestore = new RetainedEditRestore();
retainedRestore.retain(savedEditState);
let restoreAttempts = 0;
await assert.rejects(retainedRestore.attempt(async (saved) => {
  restoreAttempts++;
  assert.equal(saved, savedEditState, "restore must receive the exact retained payload");
  throw new Error("renderer reboot failed");
}), /renderer reboot failed/);
assert.equal(retainedRestore.hasPending(), true, "failed real restore coordinator attempt must retain retry state");
assert.equal(retainedRestore.peek(), savedEditState);
await retainedRestore.attempt(async (saved) => {
  restoreAttempts++;
  assert.equal(saved, savedEditState, "retry must receive the same exact payload");
});
assert.equal(restoreAttempts, 2);
assert.equal(retainedRestore.hasPending(), false, "only successful reboot may release recovery state");

const failed = lifecycle.begin();
assert.equal(lifecycle.fail(failed.token, new Error("x".repeat(400))), true);
assert.equal(lifecycle.phase, "error");
assert.equal(lifecycle.error.length, 240, "diagnostic text must be bounded");
lifecycle.finishEdit();

const active = playLifecycle.begin();
assert.equal(active.accepted, true);
assert.throws(assertEditorAuthoringAllowed, /read-only while Play is starting/);
assert.throws(() => commitSceneOperations([{ adapter: "scene" }]), /read-only while Play is starting/,
  "transactional write must fail before opening a writer connection");
await assert.rejects(deformTerrain([0, 0], 1, 1, "raise", "smooth"), /read-only while Play is starting/,
  "legacy terrain write must fail before opening a writer connection");
playLifecycle.requestStop();
playLifecycle.finishEdit();
assert.doesNotThrow(assertEditorAuthoringAllowed);

console.log("play_lifecycle.test OK: immutable source snapshot, lifecycle races/failures/stale state, and write fail-closed proof");
