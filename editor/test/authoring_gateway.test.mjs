import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectAuthoringGateway,
  sceneMaterialOperation,
  sceneTagsOperation,
  sceneTransformOperation,
} from "../src/authoring-gateway.js";

const hash = (digit) => `sha256:${digit.repeat(64)}`;
const randomBytes = () => Uint8Array.from({ length: 16 }, (_, index) => index);

function receipt(transaction, headHash = hash("b")) {
  return {
    schema: "limina.authoring-receipt/v1",
    transactionId: transaction.transactionId,
    projectId: transaction.projectId,
    transactionHash: hash("c"),
    previousRevision: transaction.baseRevision,
    committedRevision: transaction.baseRevision + 1,
    previousHeadHash: transaction.baseHeadHash,
    headHash,
    operations: transaction.operations.map((operation, index) => ({
      index,
      adapter: operation.adapter,
      action: operation.action,
      stateKey: `scene:${operation.action}:${operation.input.entity}`,
      beforeStateHash: hash("e"),
      afterStateHash: hash("f"),
    })),
    ...(transaction.compensates ? { compensates: transaction.compensates.transactionId } : {}),
  };
}

function commitResult(transaction, headHash) {
  const committedReceipt = receipt(transaction, headHash);
  return {
    receipt: committedReceipt,
    commitRecord: {
      schema: "limina.authoring-commit-record/v1",
      previousRecordHash: null,
      receipt: structuredClone(committedReceipt),
      recordHash: hash("9"),
    },
    committed: true,
  };
}

function fakeClient(options = {}) {
  const calls = [];
  let head = { schema: "limina.world-project-head/v1", projectId: "grey-field", revision: 7, headHash: hash("a") };
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    get maxInFlight() { return maxInFlight; },
    setHead(next) { head = next; },
    async callTool(name, input) {
      calls.push({ name, input: structuredClone(input) });
      if (name === "authoring.head") return structuredClone(head);
      assert.equal(name, "authoring.commit");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
        if (options.commit) return await options.commit(input.transaction, calls.length);
        const next = receipt(input.transaction, hash((input.transaction.baseRevision % 8 + 1).toString()));
        head = { schema: "limina.world-project-head/v1", projectId: next.projectId, revision: next.committedRevision, headHash: next.headHash };
        return commitResult(input.transaction, next.headHash);
      } finally {
        inFlight--;
      }
    },
  };
}

test("gizmo transform is one exact scene transaction", async () => {
  const client = fakeClient();
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
  const operation = sceneTransformOperation("entity.root", {
    position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2],
  });
  await gateway.commit([operation]);
  const wire = client.calls.find((call) => call.name === "authoring.commit").input.transaction;
  assert.equal(wire.schema, "limina.authoring-transaction/v1");
  assert.equal(wire.projectId, "grey-field");
  assert.equal(wire.baseRevision, 7);
  assert.equal(wire.baseHeadHash, hash("a"));
  assert.deepEqual(wire.operations, [operation]);
  assert.equal(wire.operations[0].adapter, "scene");
  assert.equal(wire.operations[0].adapterVersion, "1.0.0");
  assert.deepEqual(Object.keys(wire.operations[0].input), ["entity", "position", "rotation", "scale"]);
});

test("inspector operations group into one commit", async () => {
  const client = fakeClient();
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
  await gateway.commit([
    sceneTransformOperation("root", { position: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
    sceneTagsOperation("root", ["cover", "rock"]),
    sceneMaterialOperation("root", { color: 0x123456, roughness: 0.4, metalness: 0.1 }),
  ]);
  assert.equal(client.calls.filter((call) => call.name === "authoring.commit").length, 1);
  assert.equal(client.calls.at(-1).input.transaction.operations.length, 3);
});

test("stale head refreshes and never falls back or mutates history", async () => {
  let client;
  const conflict = Object.assign(new Error("stale authoring head"), { code: -32009 });
  client = fakeClient({
    commit: async () => {
      client.setHead({ schema: "limina.world-project-head/v1", projectId: "grey-field", revision: 8, headHash: hash("d") });
      throw conflict;
    },
  });
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
  await assert.rejects(gateway.commit([sceneTagsOperation("root", ["a"])]), conflict);
  assert.deepEqual(client.calls.map((call) => call.name), ["authoring.head", "authoring.commit", "authoring.head"]);
  assert.equal(gateway.historySnapshot().undo.length, 0);
  assert.equal(gateway.historySnapshot().head.revision, 8);
  assert.equal(client.calls.some((call) => call.name.startsWith("ecs.") || call.name.startsWith("three.")), false);
});

test("undo compensates and redo creates a new transaction", async () => {
  const client = fakeClient();
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
  const operation = sceneTagsOperation("root", ["edited"]);
  const first = await gateway.commit([operation]);
  const undone = await gateway.undo();
  const redone = await gateway.redo();
  const transactions = client.calls.filter((call) => call.name === "authoring.commit").map((call) => call.input.transaction);
  assert.deepEqual(transactions[1].operations, []);
  assert.deepEqual(transactions[1].compensates, { transactionId: first.transactionId });
  assert.equal(undone.compensates, first.transactionId);
  assert.deepEqual(transactions[2].operations, [operation]);
  assert.notEqual(redone.transactionId, first.transactionId);
  assert.equal(gateway.historySnapshot().undo.length, 1);
  assert.equal(gateway.historySnapshot().redo.length, 0);
});

test("commits are FIFO, ids are unique and bounded, history is bounded", async () => {
  const client = fakeClient({ delay: 5 });
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes, historyLimit: 2 });
  await Promise.all([1, 2, 3].map((value) => gateway.commit([
    sceneTransformOperation("root", { position: [value, 0, 0] }),
  ])));
  const transactions = client.calls.filter((call) => call.name === "authoring.commit").map((call) => call.input.transaction);
  assert.equal(client.maxInFlight, 1);
  assert.deepEqual(transactions.map((tx) => tx.baseRevision), [7, 8, 9]);
  const ids = transactions.map((tx) => tx.transactionId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every((id) => id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)), true);
  assert.equal(gateway.historySnapshot().undo.length, 2);
});

test("failed commits leave undo and redo history unchanged", async () => {
  let fail = false;
  const client = fakeClient({ commit: async (transaction) => {
    if (fail) throw new Error("write failed");
    return commitResult(transaction);
  } });
  const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
  await gateway.commit([sceneTagsOperation("root", ["one"])]);
  fail = true;
  const before = gateway.historySnapshot();
  await assert.rejects(gateway.commit([sceneTagsOperation("root", ["two"])]), /write failed/);
  const after = gateway.historySnapshot();
  assert.deepEqual(after.undo, before.undo);
  assert.deepEqual(after.redo, before.redo);
  assert.equal(after.head, undefined);
});

test("malformed commit evidence is rejected without entering history", async () => {
  const cases = [
    (transaction) => ({ ...commitResult(transaction), committed: false }),
    (transaction) => {
      const result = commitResult(transaction);
      result.receipt.compensates = "tx.wrong";
      result.commitRecord.receipt.compensates = "tx.wrong";
      return result;
    },
    (transaction) => {
      const result = commitResult(transaction);
      result.receipt.operations[0].action = "material.patch";
      result.commitRecord.receipt.operations[0].action = "material.patch";
      return result;
    },
    (transaction) => {
      const result = commitResult(transaction);
      result.commitRecord.receipt.headHash = hash("0");
      return result;
    },
  ];
  for (const malformed of cases) {
    const client = fakeClient({ commit: async (transaction) => malformed(transaction) });
    const gateway = new ProjectAuthoringGateway({ getClient: async () => client, randomBytes });
    await assert.rejects(gateway.commit([sceneTagsOperation("root", ["one"])]), /authoring\.commit/);
    assert.equal(gateway.historySnapshot().undo.length, 0);
  }
});

test("scene operation builders enforce the adapter contract", () => {
  assert.throws(() => sceneTransformOperation("root", { rotation: [0, 0, 0, 0] }), /normalized/);
  assert.throws(() => sceneTransformOperation("root", { scale: [1, 0, 1] }), /finite numbers/);
  assert.throws(() => sceneTagsOperation("root", ["same", "same"]), /duplicate/);
  assert.throws(() => sceneTagsOperation("root", ["bad tag"]), /valid tags/);
  assert.throws(() => sceneMaterialOperation("root", { roughness: 2 }), /roughness/);
  assert.throws(() => sceneMaterialOperation("root", { color: 1.5 }), /color/);
});
