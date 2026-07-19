import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";
import {
  AUTHORING_TRANSACTION_SCHEMA,
  MAX_DURABLE_AUTHORING_RECORD_BYTES,
  MAX_DURABLE_AUTHORING_RECORDS,
  AuthoringError,
  AuthoringTransactionKernel,
  StaticAuthoringAdapterAllowlist,
  canonicalHash,
  createDurableAuthoringRecord,
  createWorldProjectHead,
  type AuthoringAdapter,
  type AuthoringAdapterContext,
  type AuthoringCapture,
  type AuthoringOperation,
  type AuthoringTransaction,
  type CommittedAuthoringReceipt,
  type DurableAuthoringReplayEntry,
  type JsonValue,
  type WorldProjectHead,
} from "../src/authoring/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_durable: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AuthoringError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof AuthoringError, `expected AuthoringError, got ${String(error)}`);
    assert(error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`p_authoring_durable: expected ${code}`);
}

interface Capture {
  key: string;
  exists: boolean;
  value: JsonValue;
}

function inputOf(operation: AuthoringOperation): { key: string; value?: JsonValue } {
  return operation.input as { key: string; value?: JsonValue };
}

class ReplayAdapter implements AuthoringAdapter<Capture> {
  readonly id = "scene";
  readonly version = "1.0.0";
  readonly values = new Map<string, JsonValue>();
  applyCount = 0;
  readonly drift: boolean;

  constructor(drift = false) {
    this.drift = drift;
  }

  stateKey(operation: AuthoringOperation): string {
    return inputOf(operation).key;
  }

  preflight(operation: AuthoringOperation): void {
    const input = inputOf(operation);
    if (operation.action !== "set" || typeof input.key !== "string" || input.value === undefined) {
      throw new Error("only keyed set is supported");
    }
  }

  capture(operation: AuthoringOperation, context: AuthoringAdapterContext): AuthoringCapture<Capture> {
    const key = inputOf(operation).key;
    const exists = this.values.has(key);
    const snapshot = { key, exists, value: exists ? this.values.get(key)! : null };
    return { snapshot, stateHash: context.hashJson(snapshot) };
  }

  apply(operation: AuthoringOperation): void {
    const { key, value } = inputOf(operation);
    this.applyCount++;
    this.values.set(key, this.drift && typeof value === "number" ? value + 1 : value!);
  }

  stateHash(operation: AuthoringOperation, context: AuthoringAdapterContext): `sha256:${string}` {
    const key = inputOf(operation).key;
    const exists = this.values.has(key);
    return context.hashJson({ key, exists, value: exists ? this.values.get(key)! : null });
  }

  rollback(_operation: AuthoringOperation, capture: Capture): void {
    this.restore(capture);
  }

  compensate(_operation: AuthoringOperation, capture: Capture): void {
    this.restore(capture);
  }

  private restore(capture: Capture): void {
    if (capture.exists) this.values.set(capture.key, capture.value);
    else this.values.delete(capture.key);
  }
}

const hash = (input: string): string => sha256(input);
const PROJECT_ID = "project.durable-authoring";
const genesis = createWorldProjectHead(PROJECT_ID, hash);

function options(
  adapter: ReplayAdapter,
  head: WorldProjectHead = genesis,
  durabilityLimits?: { maxRecords?: number; maxBytes?: number },
) {
  return { head, sha256: hash, adapters: new StaticAuthoringAdapterAllowlist([adapter]), durabilityLimits };
}

function transaction(id: string, head: WorldProjectHead, key: string, value: JsonValue): AuthoringTransaction {
  return {
    schema: AUTHORING_TRANSACTION_SCHEMA,
    transactionId: id,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [{ adapter: "scene", adapterVersion: "1.0.0", action: "set", input: { key, value } }],
  };
}

function compensation(id: string, head: WorldProjectHead, target: string): AuthoringTransaction {
  return {
    schema: AUTHORING_TRANSACTION_SCHEMA,
    transactionId: id,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [],
    compensates: { transactionId: target },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function forgeCompensationEntry(
  id: string,
  target: string,
  previous: DurableAuthoringReplayEntry | undefined,
  operations: CommittedAuthoringReceipt["operations"] = [],
): DurableAuthoringReplayEntry {
  const previousHead = previous === undefined
    ? genesis
    : {
      schema: genesis.schema,
      projectId: genesis.projectId,
      revision: previous.commit.receipt.committedRevision,
      headHash: previous.commit.receipt.headHash,
    } satisfies WorldProjectHead;
  const transactionValue = compensation(id, previousHead, target);
  const transactionHash = canonicalHash(hash, transactionValue);
  const headHash = canonicalHash(hash, {
    schema: genesis.schema,
    projectId: genesis.projectId,
    revision: previousHead.revision + 1,
    parentHash: previousHead.headHash,
    transactionHash,
    operations,
  });
  const receipt: CommittedAuthoringReceipt = {
    schema: "limina.authoring-receipt/v1",
    transactionId: id,
    projectId: genesis.projectId,
    transactionHash,
    previousRevision: previousHead.revision,
    committedRevision: previousHead.revision + 1,
    previousHeadHash: previousHead.headHash,
    headHash,
    operations: [...operations],
    compensates: target,
  };
  return {
    transaction: transactionValue,
    commit: createDurableAuthoringRecord(hash, previous?.commit.recordHash ?? null, receipt),
  };
}

// Restart reconstructs state, head, the idempotency ledger, and original undo captures.
const initialAdapter = new ReplayAdapter();
const initial = new AuthoringTransactionKernel(options(initialAdapter));
const original = transaction("tx.original", initial.head, "tower", 7);
const originalCommit = await initial.commitWithRecord(original);
const originalReceipt = originalCommit.receipt;
assert(originalCommit.committed && originalCommit.record.receipt === originalReceipt, "new commit must return its exact envelope atomically");
const originalRetry = await initial.commitWithRecord(original);
assert(!originalRetry.committed && originalRetry.record === originalCommit.record, "exact retry must identify a non-recordable no-op");
const second = transaction("tx.second", initial.head, "gate", "open");
await initial.commit(second);
const checkpoint = initial.exportReplayCheckpoint();
assert(checkpoint.length === 2 && Object.isFrozen(checkpoint), "diagnostic checkpoint must be immutable and complete");
assert(initial.latestDurableRecord === checkpoint[1].commit, "latest envelope accessor must be O(1) and exact");
assert(
  initial.durableRecordForTransaction("tx.original") === checkpoint[0].commit,
  "transaction envelope accessor must be O(1) and exact",
);

const restartedAdapter = new ReplayAdapter();
const restarted = await AuthoringTransactionKernel.replayCheckpoint(options(restartedAdapter), clone(checkpoint));
assert(restarted.head.headHash === initial.head.headHash, "restart must reconstruct the exact committed head");
assert(restartedAdapter.values.get("tower") === 7 && restartedAdapter.values.get("gate") === "open", "restart must rebuild domain state");
const applicationsBeforeRetry = restartedAdapter.applyCount;
const recordCountBeforeRetry = restarted.durableRecordCount;
const retryReceipt = await restarted.commit(original);
assert(retryReceipt.headHash === originalReceipt.headHash, "restart duplicate retry must return the original receipt");
assert(restartedAdapter.applyCount === applicationsBeforeRetry, "restart duplicate retry must not reapply the transaction");
assert(restarted.durableRecordCount === recordCountBeforeRetry, "restart duplicate retry must not append a durable record");

const undo = compensation("tx.undo", restarted.head, "tx.original");
await restarted.commit(undo);
assert(!restartedAdapter.values.has("tower"), "restart compensation must use the reconstructed original capture");
assert(restartedAdapter.values.get("gate") === "open", "compensation must preserve unrelated later state");

// Replaying the compensation itself rebuilds compensatedBy metadata, preventing a second undo.
const compensatedCheckpoint = restarted.exportReplayCheckpoint();
const compensatedAdapter = new ReplayAdapter();
const compensatedRestart = await AuthoringTransactionKernel.replayCheckpoint(options(compensatedAdapter), clone(compensatedCheckpoint));
await expectCode(
  compensatedRestart.commit(compensation("tx.undo-again", compensatedRestart.head, "tx.original")),
  "already_compensated",
);
assert(!compensatedAdapter.values.has("tower"), "replayed compensation must preserve compensated state");

// Compensation graph corruption is rejected during checkpoint validation, before any replay apply.
const missingTargetAdapter = new ReplayAdapter();
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(
    options(missingTargetAdapter),
    [forgeCompensationEntry("tx.missing-target", "tx.absent", undefined)],
  ),
  "durable_chain_corrupt",
);
assert(missingTargetAdapter.applyCount === 0, "missing compensation target must fail before replay mutation");
const compensationOps = compensatedCheckpoint[2].commit.receipt.operations;
const compensatesCompensation = forgeCompensationEntry(
  "tx.compensates-compensation",
  "tx.undo",
  compensatedCheckpoint[2],
  compensationOps,
);
const compensationTargetAdapter = new ReplayAdapter();
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(
    options(compensationTargetAdapter),
    [...clone(compensatedCheckpoint), compensatesCompensation],
  ),
  "durable_chain_corrupt",
);
assert(compensationTargetAdapter.applyCount === 0, "compensation-of-compensation must fail before replay mutation");
const duplicateCompensation = forgeCompensationEntry(
  "tx.duplicate-undo",
  "tx.original",
  compensatedCheckpoint[2],
  compensationOps,
);
const duplicateCompensationAdapter = new ReplayAdapter();
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(
    options(duplicateCompensationAdapter),
    [...clone(compensatedCheckpoint), duplicateCompensation],
  ),
  "durable_chain_corrupt",
);
assert(duplicateCompensationAdapter.applyCount === 0, "duplicate compensation must fail before replay mutation");

// A tail-truncated valid prefix is a recoverable earlier authority state; a suffix is not.
const prefixAdapter = new ReplayAdapter();
const prefix = await AuthoringTransactionKernel.replayCheckpoint(options(prefixAdapter), clone(checkpoint.slice(0, 1)));
assert(prefix.head.revision === 1 && prefixAdapter.values.get("tower") === 7, "valid prefix must replay to its own head");
assert(!prefixAdapter.values.has("gate"), "tail-truncated prefix must not invent missing commits");
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), clone(checkpoint.slice(1))),
  "durable_chain_corrupt",
);

// Strict version/schema validation rejects unknown fields before adapters run.
const malformed = clone(checkpoint) as Array<DurableAuthoringReplayEntry & { unexpected?: boolean }>;
malformed[0].unexpected = true;
const malformedAdapter = new ReplayAdapter();
await expectCode(AuthoringTransactionKernel.replayCheckpoint(options(malformedAdapter), malformed), "invalid_durable_record");
assert(malformedAdapter.applyCount === 0, "schema-invalid log must fail before adapter mutation");

const wrongVersion = clone(checkpoint) as unknown as Array<{ commit: { schema: string } }>;
wrongVersion[0].commit.schema = "limina.authoring-commit-record/v2";
await expectCode(AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), wrongVersion), "invalid_durable_record");

// Content tampering and ordering corruption are detected before replay.
const tampered = clone(checkpoint);
(tampered[0].transaction.operations[0].input as { value: JsonValue }).value = 99;
const tamperedAdapter = new ReplayAdapter();
await expectCode(AuthoringTransactionKernel.replayCheckpoint(options(tamperedAdapter), tampered), "durable_chain_corrupt");
assert(tamperedAdapter.applyCount === 0, "tampered log must fail before adapter mutation");
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), clone([...checkpoint].reverse())),
  "durable_chain_corrupt",
);

// Rehashing an invalid receipt cannot bypass exact head-chain verification.
const badHeadEntry = clone(checkpoint[0]);
const badReceipt = { ...badHeadEntry.commit.receipt, headHash: `sha256:${"f".repeat(64)}` } as CommittedAuthoringReceipt;
const rehashedBadHead = createDurableAuthoringRecord(hash, null, badReceipt);
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), [{ transaction: badHeadEntry.transaction, commit: rehashedBadHead }]),
  "durable_chain_corrupt",
);

// A correctly rehashed transaction with a stale base still fails the genesis anchor.
const staleTransaction = { ...badHeadEntry.transaction, baseRevision: 1 };
const staleHash = canonicalHash(hash, staleTransaction);
const staleReceipt = { ...badHeadEntry.commit.receipt, transactionHash: staleHash };
const staleRecord = createDurableAuthoringRecord(hash, null, staleReceipt);
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), [{ transaction: staleTransaction, commit: staleRecord }]),
  "durable_chain_corrupt",
);

// Duplicate/colliding ids are explicit corruption, not idempotent replay entries.
const collisionTransaction = { ...checkpoint[1].transaction, transactionId: checkpoint[0].transaction.transactionId };
const collisionHash = canonicalHash(hash, collisionTransaction);
const collisionReceipt = { ...checkpoint[1].commit.receipt, transactionId: collisionTransaction.transactionId, transactionHash: collisionHash };
const collisionHeadHash = canonicalHash(hash, {
  schema: genesis.schema,
  projectId: genesis.projectId,
  revision: collisionReceipt.committedRevision,
  parentHash: collisionReceipt.previousHeadHash,
  transactionHash: collisionHash,
  operations: collisionReceipt.operations,
});
const collisionRecord = createDurableAuthoringRecord(
  hash,
  checkpoint[0].commit.recordHash,
  { ...collisionReceipt, headHash: collisionHeadHash },
);
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter()), [
    checkpoint[0],
    { transaction: collisionTransaction, commit: collisionRecord },
  ]),
  "durable_chain_corrupt",
);

// Adapter implementation drift is detected after structural validation and poisons replay.
await expectCode(
  AuthoringTransactionKernel.replayCheckpoint(options(new ReplayAdapter(true)), clone(checkpoint)),
  "replay_diverged",
);
const driftAdapter = new ReplayAdapter(true);
const divergence = await expectCode(
  new AuthoringTransactionKernel(options(driftAdapter)).commitRecorded(checkpoint[0].transaction, checkpoint[0].commit),
  "replay_diverged",
);
const divergenceWindow = divergence.message.match(/^recorded authoring commit diverged from its embedded commitFields \(first divergence @(\d+): recorded …([\s\S]{1,760})… vs replayed …([\s\S]{1,760})…\)$/);
assert(divergenceWindow !== null, `replay divergence lost its bounded record window: ${divergence.message}`);
const divergenceAt = Number(divergenceWindow[1]), windowPrefix = Math.min(60, divergenceAt), recordedWindow = divergenceWindow[2]!, replayedWindow = divergenceWindow[3]!;
assert(recordedWindow.slice(0, windowPrefix) === replayedWindow.slice(0, windowPrefix), "replay divergence window is not centered on shared pre-divergence context");
assert(recordedWindow[windowPrefix] !== replayedWindow[windowPrefix], "replay divergence window does not expose the first differing record byte");
assert(driftAdapter.values.size === 0, "embedded-record divergence must roll back before publishing authority state");

// Resource bounds reject work before record traversal or adapter mutation.
const tooMany = new Array(MAX_DURABLE_AUTHORING_RECORDS + 1).fill(checkpoint[0]);
const countBoundAdapter = new ReplayAdapter();
await expectCode(AuthoringTransactionKernel.replayCheckpoint(options(countBoundAdapter), tooMany), "durable_log_too_large");
assert(countBoundAdapter.applyCount === 0, "record-count bound must precede replay");
const oversized = { ...clone(checkpoint[0].commit), padding: "x".repeat(MAX_DURABLE_AUTHORING_RECORD_BYTES + 1) };
await expectCode(
  Promise.resolve().then(() =>
    new AuthoringTransactionKernel(options(new ReplayAdapter())).commitRecorded(checkpoint[0].transaction, oversized)
  ),
  "durable_log_too_large",
);

// Live ceilings apply before authority publication. Record count rejects before apply; byte count
// rolls back the applied operation because its exact receipt size is only known after stateHash.
const countLimitedAdapter = new ReplayAdapter();
const countLimited = new AuthoringTransactionKernel(options(countLimitedAdapter, genesis, { maxRecords: 1 }));
await countLimited.commit(transaction("tx.count-1", countLimited.head, "a", 1));
const countHead = countLimited.head;
const countApplies = countLimitedAdapter.applyCount;
await expectCode(countLimited.commit(transaction("tx.count-2", countLimited.head, "b", 2)), "durable_log_too_large");
assert(countLimited.head === countHead && countLimitedAdapter.applyCount === countApplies, "record limit must reject before mutation");
assert(!countLimitedAdapter.values.has("b"), "record limit must preserve domain state");

const byteLimitedAdapter = new ReplayAdapter();
const byteLimited = new AuthoringTransactionKernel(options(byteLimitedAdapter, genesis, { maxBytes: 64 }));
await expectCode(byteLimited.commit(transaction("tx.byte", byteLimited.head, "a", 1)), "durable_log_too_large");
assert(byteLimited.head.revision === 0 && byteLimited.durableRecordCount === 0, "byte refusal must not advance head or ledger");
assert(byteLimitedAdapter.values.size === 0 && !byteLimited.poisoned, "byte refusal must roll back cleanly without poisoning");
const retainedBytesAdapter = new ReplayAdapter();
const retainedBytesKernel = new AuthoringTransactionKernel(options(retainedBytesAdapter, genesis, { maxBytes: 8_192 }));
await expectCode(
  retainedBytesKernel.commit(transaction("tx.retained-bytes", retainedBytesKernel.head, "large", "x".repeat(32_768))),
  "durable_log_too_large",
);
assert(
  retainedBytesKernel.head.revision === 0 && retainedBytesKernel.durableByteLength === 2,
  "full retained transaction bytes must be bounded without head or ledger advance",
);
assert(retainedBytesAdapter.values.size === 0, "retained-byte refusal must roll back the large mutation");

// Recorded adapter semantics are mandatory; an unavailable version fails before capture or apply.
const versionAdapter = new ReplayAdapter();
const versionKernel = new AuthoringTransactionKernel(options(versionAdapter));
const wrongAdapterVersion = clone(original);
wrongAdapterVersion.transactionId = "tx.wrong-adapter-version";
wrongAdapterVersion.operations[0].adapterVersion = "2.0.0";
await expectCode(versionKernel.commit(wrongAdapterVersion), "adapter_version_mismatch");
assert(versionAdapter.applyCount === 0 && versionKernel.head.revision === 0, "adapter version drift must fail before mutation");

ops.op_log(
  "p_authoring_durable OK: restart idempotency/undo, compensation metadata, strict hash-chain validation, prefix recovery, drift and resource bounds",
);
