import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";
import {
  MAX_AUTHORING_OPERATIONS,
  MAX_AUTHORING_TRANSACTION_BYTES,
  AuthoringError,
  canonicalHash,
  canonicalStringify,
  createWorldProjectHead,
  normalizeSha256,
  parseAuthoringTransaction,
} from "../src/authoring/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_canonical: ${message}`);
}

function expectCode(fn: () => unknown, code: string): AuthoringError {
  try {
    fn();
  } catch (error) {
    assert(error instanceof AuthoringError, `expected AuthoringError, got ${String(error)}`);
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    return error;
  }
  throw new Error(`p_authoring_canonical: expected ${code}`);
}

const hash = (input: string): string => sha256(input);
const prefixedUpperHash = (input: string): string => `sha256:${sha256(input).toUpperCase()}`;

assert(
  canonicalStringify({ z: 1, a: { y: -0, x: [true, null, "é"] } }) ===
    '{"a":{"x":[true,null,"é"],"y":0},"z":1}',
  "canonical form must recursively sort keys and normalize negative zero",
);
assert(
  canonicalHash(hash, { b: 2, a: 1 }) === canonicalHash(hash, { a: 1, b: 2 }),
  "logically equal objects must hash identically",
);
assert(normalizeSha256(prefixedUpperHash("x")) === `sha256:${sha256("x")}`, "host hash seam must normalize prefix and case");

expectCode(() => canonicalStringify({ n: Number.NaN }), "invalid_transaction");
expectCode(() => canonicalStringify({ n: Number.POSITIVE_INFINITY }), "invalid_transaction");
expectCode(() => canonicalStringify({ missing: undefined }), "invalid_transaction");
expectCode(() => canonicalStringify(new Date(0)), "invalid_transaction");
const sparse = new Array(2);
sparse[1] = 1;
expectCode(() => canonicalStringify(sparse), "invalid_transaction");
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
expectCode(() => canonicalStringify(cyclic), "invalid_transaction");
let getterCalls = 0;
const accessor = Object.defineProperty({}, "danger", {
  enumerable: true,
  get() { getterCalls++; return 1; },
});
expectCode(() => canonicalStringify(accessor), "invalid_transaction");
assert(getterCalls === 0, "canonical validation must reject accessors without executing them");
expectCode(() => normalizeSha256("sha256:not-a-digest"), "invalid_hash");

const headA = createWorldProjectHead("project.canonical", hash);
const headB = createWorldProjectHead("project.canonical", prefixedUpperHash);
assert(JSON.stringify(headA) === JSON.stringify(headB), "raw and prefixed host SHA-256 providers must produce the same head");
assert(Object.isFrozen(headA), "WorldProject heads must be immutable");

const operation = { adapter: "scene", action: "set", input: { key: "x", value: 1 } };
const base = {
  schema: "limina.authoring-transaction/v1",
  transactionId: "tx.bounds",
  projectId: headA.projectId,
  baseRevision: headA.revision,
  baseHeadHash: headA.headHash,
};
expectCode(
  () => parseAuthoringTransaction({ ...base, operations: Array.from({ length: MAX_AUTHORING_OPERATIONS + 1 }, () => operation) }),
  "invalid_transaction",
);
const huge = "x".repeat(MAX_AUTHORING_TRANSACTION_BYTES + 1);
expectCode(() => parseAuthoringTransaction({ ...base, operations: [{ ...operation, input: { huge } }] }), "transaction_too_large");
expectCode(
  () => parseAuthoringTransaction({ ...base, operations: [operation], unexpected: true }),
  "invalid_transaction",
);
expectCode(
  () => parseAuthoringTransaction({
    ...base,
    operations: [{ ...operation, input: JSON.parse('{"key":"x","__proto__":{"polluted":true}}') }],
  }),
  "invalid_transaction",
);

ops.op_log("p_authoring_canonical OK: strict canonical JSON, host SHA-256 normalization, immutable genesis heads, operation and byte bounds");
