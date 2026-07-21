import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";
import {
  AUTHORING_TRANSACTION_SCHEMA,
  AuthoringError,
  AuthoringTransactionKernel,
  StaticAuthoringAdapterAllowlist,
  createWorldProjectHead,
  type AuthoringAdapter,
  type AuthoringAdapterContext,
  type AuthoringCapture,
  type AuthoringOperation,
  type AuthoringTransaction,
  type JsonValue,
  type WorldProjectHead,
} from "../src/authoring/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_kernel: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AuthoringError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof AuthoringError, `expected AuthoringError, got ${String(error)}`);
    assert(error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`p_authoring_kernel: expected ${code}`);
}

interface ModelCapture {
  key: string;
  exists: boolean;
  value: JsonValue;
}

function inputOf(operation: AuthoringOperation): { key: string; value?: JsonValue } {
  return operation.input as { key: string; value?: JsonValue };
}

class MemoryAdapter implements AuthoringAdapter<ModelCapture> {
  readonly id: string;
  readonly version = "1.0.0";
  readonly values = new Map<string, JsonValue>();
  readonly order: string[] = [];
  readonly rollbackFailures = new Set<string>();
  readonly corruptRollbacks = new Set<string>();
  applyCount = 0;
  compensateCount = 0;

  constructor(id = "scene") { this.id = id; }

  stateKey(operation: AuthoringOperation): string {
    return inputOf(operation).key;
  }

  preflight(operation: AuthoringOperation): void {
    const input = inputOf(operation);
    if (typeof input.key !== "string" || input.key.length === 0) throw new Error("key is required");
    if (!["set", "delete", "fail", "partial-fail"].includes(operation.action)) throw new Error(`unsupported action ${operation.action}`);
    if (operation.action === "set" && input.value === undefined) throw new Error("set requires value");
  }

  capture(operation: AuthoringOperation, context: AuthoringAdapterContext): AuthoringCapture<ModelCapture> {
    const key = inputOf(operation).key;
    const exists = this.values.has(key);
    const snapshot = { key, exists, value: exists ? this.values.get(key)! : null };
    return { snapshot, stateHash: context.hashJson(snapshot) };
  }

  apply(operation: AuthoringOperation): void {
    const input = inputOf(operation);
    this.applyCount++;
    this.order.push(`apply:${input.key}`);
    switch (operation.action) {
      case "set": this.values.set(input.key, input.value!); return;
      case "delete": this.values.delete(input.key); return;
      case "fail": throw new Error("injected apply failure");
      case "partial-fail":
        this.values.set(input.key, input.value ?? "partial");
        throw new Error("injected partial apply failure");
    }
  }

  stateHash(operation: AuthoringOperation, context: AuthoringAdapterContext): `sha256:${string}` {
    const key = inputOf(operation).key;
    const exists = this.values.has(key);
    return context.hashJson({ key, exists, value: exists ? this.values.get(key)! : null });
  }

  rollback(_operation: AuthoringOperation, capture: ModelCapture): void {
    this.order.push(`rollback:${capture.key}`);
    if (this.rollbackFailures.has(capture.key)) throw new Error(`injected rollback failure for ${capture.key}`);
    if (this.corruptRollbacks.has(capture.key)) return;
    this.restore(capture);
  }

  compensate(_operation: AuthoringOperation, originalCapture: ModelCapture): void {
    this.compensateCount++;
    this.order.push(`compensate:${originalCapture.key}`);
    this.restore(originalCapture);
  }

  directSet(key: string, value: JsonValue): void {
    this.values.set(key, value);
  }

  private restore(capture: ModelCapture): void {
    if (capture.exists) this.values.set(capture.key, capture.value);
    else this.values.delete(capture.key);
  }
}

const hash = (input: string): string => sha256(input);
const PROJECT_ID = "project.authoring-test";

function setup(adapter = new MemoryAdapter(), allowed: readonly string[] = [adapter.id]): {
  adapter: MemoryAdapter;
  kernel: AuthoringTransactionKernel;
  genesis: WorldProjectHead;
} {
  const genesis = createWorldProjectHead(PROJECT_ID, hash);
  return {
    adapter,
    genesis,
    kernel: new AuthoringTransactionKernel({
      head: genesis,
      sha256: hash,
      adapters: new StaticAuthoringAdapterAllowlist([adapter], allowed),
    }),
  };
}

function transaction(
  id: string,
  head: WorldProjectHead,
  operations: AuthoringTransaction["operations"],
  compensates?: string,
): AuthoringTransaction {
  return {
    schema: AUTHORING_TRANSACTION_SCHEMA,
    transactionId: id,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations,
    ...(compensates === undefined ? {} : { compensates: { transactionId: compensates } }),
  };
}

const set = (key: string, value: JsonValue): AuthoringOperation => ({
  adapter: "scene",
  adapterVersion: "1.0.0",
  action: "set",
  input: { key, value },
});

// Atomic success and a deterministic head advance.
{
  const { adapter, kernel, genesis } = setup();
  const receipt = await kernel.commit(transaction("tx.success", genesis, [set("a", 1), set("b", 2)]));
  assert(adapter.values.get("a") === 1 && adapter.values.get("b") === 2, "successful transaction must apply every operation");
  assert(receipt.committedRevision === 1 && kernel.head.revision === 1, "successful transaction must advance the head exactly once");
  assert(receipt.previousHeadHash === genesis.headHash && receipt.headHash === kernel.head.headHash, "receipt must bind both heads");
  assert(Object.isFrozen(receipt) && Object.isFrozen(receipt.operations), "receipt must be immutable");
}

// Invalid operation N is rejected during whole-batch preflight, before operation 0 mutates.
{
  const { adapter, kernel, genesis } = setup();
  const invalid = { adapter: "scene", adapterVersion: "1.0.0", action: "unsupported", input: { key: "b" } } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx.preflight", genesis, [set("a", 1), invalid])), "preflight_failed");
  assert(adapter.applyCount === 0 && adapter.values.size === 0, "preflight failure must leave all state untouched");
  assert(
    kernel.head.revision === genesis.revision && kernel.head.headHash === genesis.headHash,
    "preflight failure must not advance the head",
  );
}

// Concurrent duplicate delivery is serialized and applied once.
{
  const { adapter, kernel, genesis } = setup();
  const tx = transaction("tx.concurrent-duplicate", genesis, [set("a", 1)]);
  const [first, second] = await Promise.all([kernel.commit(tx), kernel.commit(tx)]);
  assert(first === second, "idempotent retry must return the original immutable receipt");
  assert(adapter.applyCount === 1 && kernel.head.revision === 1, "concurrent duplicate must apply and advance once");
}

// Stale base and transaction-id collisions are distinct conflicts.
{
  const { adapter, kernel, genesis } = setup();
  await kernel.commit(transaction("tx.first", genesis, [set("a", 1)]));
  await expectCode(kernel.commit(transaction("tx.stale", genesis, [set("b", 2)])), "stale_head");
  await expectCode(kernel.commit(transaction("tx.first", kernel.head, [set("a", 99)])), "transaction_id_collision");
  assert(adapter.values.get("a") === 1 && !adapter.values.has("b") && kernel.head.revision === 1, "conflicts must not mutate state");
}

// Unknown and known-but-not-allowlisted adapters are rejected before preflight.
{
  const { adapter, kernel, genesis } = setup();
  const unknown = { adapter: "terrain", adapterVersion: "1.0.0", action: "set", input: { key: "a", value: 1 } } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx.unknown", genesis, [unknown])), "unknown_adapter");
  assert(adapter.applyCount === 0, "unknown adapter must not invoke another adapter");
}
{
  const { adapter, kernel, genesis } = setup(new MemoryAdapter(), []);
  await expectCode(kernel.commit(transaction("tx.denied", genesis, [set("a", 1)])), "adapter_not_allowed");
  assert(adapter.applyCount === 0, "disabled adapter must not be invoked");
}

// A partially mutating failure rolls the failed operation and all prior operations back in reverse.
{
  const { adapter, kernel, genesis } = setup();
  const partial = { adapter: "scene", adapterVersion: "1.0.0", action: "partial-fail", input: { key: "b", value: 2 } } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx.rollback", genesis, [set("a", 1), partial])), "apply_failed");
  assert(adapter.values.size === 0 && kernel.head.revision === 0, "successful rollback must restore state and preserve head");
  assert(adapter.order.slice(-2).join(",") === "rollback:b,rollback:a", "rollback order must be exact reverse application order");
}

// Any rollback failure poisons the writer and blocks subsequent mutations.
{
  const { adapter, kernel, genesis } = setup();
  adapter.rollbackFailures.add("a");
  const partial = { adapter: "scene", adapterVersion: "1.0.0", action: "partial-fail", input: { key: "b", value: 2 } } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx.poison", genesis, [set("a", 1), partial])), "rollback_failed");
  assert(kernel.poisoned, "rollback failure must poison the writer");
  const count = adapter.applyCount;
  await expectCode(kernel.commit(transaction("tx.after-poison", genesis, [set("c", 3)])), "writer_poisoned");
  assert(adapter.applyCount === count && kernel.head.revision === 0, "poisoned writer must reject before mutation or head advance");
}

// A rollback that returns without restoring the captured state also poisons the writer.
{
  const { adapter, kernel, genesis } = setup();
  adapter.corruptRollbacks.add("a");
  const partial = { adapter: "scene", adapterVersion: "1.0.0", action: "partial-fail", input: { key: "b", value: 2 } } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx-corrupt-rollback", genesis, [set("a", 1), partial])), "rollback_failed");
  assert(kernel.poisoned && adapter.values.get("a") === 1, "state-hash mismatch after rollback must poison the writer");
}

// Per-operation optimistic state guards reject stale domain state before apply.
{
  const { adapter, kernel, genesis } = setup();
  const guarded = {
    ...set("a", 1),
    guard: { beforeHash: `sha256:${"0".repeat(64)}` },
  } as AuthoringOperation;
  await expectCode(kernel.commit(transaction("tx-state-guard", genesis, [guarded])), "state_guard_conflict");
  assert(adapter.applyCount === 0 && kernel.head.revision === 0, "state guard failure must precede mutation");
}

// Compensation reverses overlapping state scopes in reverse order and advances as a new commit.
{
  const { adapter, kernel, genesis } = setup();
  await kernel.commit(transaction("tx.original", genesis, [set("a", 1), set("a", 2)]));
  const compensation = transaction("tx.undo", kernel.head, [], "tx.original");
  const [first, retry] = await Promise.all([kernel.commit(compensation), kernel.commit(compensation)]);
  assert(first === retry && first.compensates === "tx.original", "compensation retry must be idempotent and identify its target");
  assert(!adapter.values.has("a") && adapter.compensateCount === 2, "compensation must restore each original capture in reverse order exactly once");
  assert(kernel.head.revision === 2, "compensation is a committed revision, not hidden history mutation");
}

// Compensation guard detects out-of-band state change before the first inverse mutates.
{
  const { adapter, kernel, genesis } = setup();
  await kernel.commit(transaction("tx.guard-original", genesis, [set("a", 1)]));
  adapter.directSet("a", 99);
  const beforeCount = adapter.compensateCount;
  await expectCode(kernel.commit(transaction("tx.guard-undo", kernel.head, [], "tx.guard-original")), "compensation_conflict");
  assert(adapter.values.get("a") === 99 && adapter.compensateCount === beforeCount, "guard conflict must preserve externally changed state");
  assert(kernel.head.revision === 1, "guard conflict must not advance the head");
}

ops.op_log("p_authoring_kernel OK: atomic commit, idempotency, stale/collision/allowlist rejection, reverse rollback, poison, guarded compensation");
