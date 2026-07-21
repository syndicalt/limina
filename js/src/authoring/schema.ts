import { z } from "../../build/zod.bundle.mjs";
import { canonicalStringify, utf8ByteLength, type ContentHash, type JsonValue } from "./canonical.ts";
import { AuthoringError } from "./errors.ts";

export const WORLD_PROJECT_HEAD_SCHEMA = "limina.world-project-head/v1" as const;
export const AUTHORING_TRANSACTION_SCHEMA = "limina.authoring-transaction/v1" as const;
export const AUTHORING_RECEIPT_SCHEMA = "limina.authoring-receipt/v1" as const;
export const MAX_AUTHORING_OPERATIONS = 256;
export const MAX_AUTHORING_TRANSACTION_BYTES = 1_048_576;

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const AdapterIdSchema = z.string().min(1).max(96).regex(/^[a-z][a-z0-9.-]*$/);
const AdapterVersionSchema = z.string().min(1).max(64).regex(/^[0-9][A-Za-z0-9._+-]*$/);
const ActionSchema = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/) as z.ZodType<ContentHash>;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export const WorldProjectHeadSchema = z.object({
  schema: z.literal(WORLD_PROJECT_HEAD_SCHEMA),
  projectId: IdSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  headHash: ContentHashSchema,
}).strict();

export type WorldProjectHead = z.infer<typeof WorldProjectHeadSchema>;

export const AuthoringOperationSchema = z.object({
  adapter: AdapterIdSchema,
  adapterVersion: AdapterVersionSchema,
  action: ActionSchema,
  input: JsonValueSchema,
  guard: z.object({
    beforeHash: ContentHashSchema,
    afterHash: ContentHashSchema.optional(),
  }).strict().optional(),
}).strict();

export type AuthoringOperation = z.infer<typeof AuthoringOperationSchema>;

const CompensationSchema = z.object({
  transactionId: IdSchema,
}).strict();

export const AuthoringTransactionSchema = z.object({
  schema: z.literal(AUTHORING_TRANSACTION_SCHEMA),
  transactionId: IdSchema,
  projectId: IdSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseHeadHash: ContentHashSchema,
  operations: z.array(AuthoringOperationSchema).max(MAX_AUTHORING_OPERATIONS),
  compensates: CompensationSchema.optional(),
}).strict().superRefine((transaction, context) => {
  if (transaction.compensates === undefined && transaction.operations.length === 0) {
    context.addIssue({ code: "custom", path: ["operations"], message: "a normal transaction requires at least one operation" });
  }
  if (transaction.compensates !== undefined && transaction.operations.length !== 0) {
    context.addIssue({ code: "custom", path: ["operations"], message: "a compensation transaction derives operations from its target" });
  }
  if (transaction.compensates?.transactionId === transaction.transactionId) {
    context.addIssue({ code: "custom", path: ["compensates", "transactionId"], message: "a transaction cannot compensate itself" });
  }
});

export type AuthoringTransaction = z.infer<typeof AuthoringTransactionSchema>;

export const CommittedOperationReceiptSchema = z.object({
  index: z.number().int().nonnegative().max(MAX_AUTHORING_OPERATIONS - 1),
  adapter: AdapterIdSchema,
  action: ActionSchema,
  stateKey: z.string().min(1).max(256),
  beforeStateHash: ContentHashSchema,
  afterStateHash: ContentHashSchema,
}).strict();

export const CommittedAuthoringReceiptSchema = z.object({
  schema: z.literal(AUTHORING_RECEIPT_SCHEMA),
  transactionId: IdSchema,
  projectId: IdSchema,
  transactionHash: ContentHashSchema,
  previousRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  committedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousHeadHash: ContentHashSchema,
  headHash: ContentHashSchema,
  operations: z.array(CommittedOperationReceiptSchema).max(MAX_AUTHORING_OPERATIONS),
  compensates: IdSchema.optional(),
}).strict();

export type CommittedOperationReceipt = z.infer<typeof CommittedOperationReceiptSchema>;
export type CommittedAuthoringReceipt = z.infer<typeof CommittedAuthoringReceiptSchema>;

export interface ParsedAuthoringTransaction {
  transaction: AuthoringTransaction;
  canonical: string;
  byteLength: number;
}

/** Validate, clone, and size a transaction before it enters the serialized writer. */
export function parseAuthoringTransaction(input: unknown): ParsedAuthoringTransaction {
  // Canonicalize before schema traversal. Besides producing stable bytes, this rejects getters,
  // cycles, and exotic prototypes before a validator could execute or coerce them.
  let canonicalInput: string;
  try {
    canonicalInput = canonicalStringify(input);
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    throw new AuthoringError("invalid_transaction", "authoring transaction cannot be canonicalized", {}, { cause: error });
  }
  const inputByteLength = utf8ByteLength(canonicalInput);
  if (inputByteLength > MAX_AUTHORING_TRANSACTION_BYTES) {
    throw new AuthoringError(
      "transaction_too_large",
      `authoring transaction is ${inputByteLength} bytes; maximum is ${MAX_AUTHORING_TRANSACTION_BYTES}`,
      { byteLength: inputByteLength, maximum: MAX_AUTHORING_TRANSACTION_BYTES },
    );
  }
  let parsed: ReturnType<typeof AuthoringTransactionSchema.safeParse>;
  try {
    parsed = AuthoringTransactionSchema.safeParse(JSON.parse(canonicalInput));
  } catch (error) {
    throw new AuthoringError("invalid_transaction", "authoring transaction validation failed", {}, { cause: error });
  }
  if (!parsed.success) {
    throw new AuthoringError("invalid_transaction", "authoring transaction failed schema validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const canonical = canonicalStringify(parsed.data);
  if (canonical !== canonicalInput) {
    throw new AuthoringError(
      "invalid_transaction",
      "authoring transaction contains fields that cannot be preserved by the wire schema",
    );
  }
  const byteLength = utf8ByteLength(canonical);
  if (byteLength > MAX_AUTHORING_TRANSACTION_BYTES) {
    throw new AuthoringError(
      "transaction_too_large",
      `authoring transaction is ${byteLength} bytes; maximum is ${MAX_AUTHORING_TRANSACTION_BYTES}`,
      { byteLength, maximum: MAX_AUTHORING_TRANSACTION_BYTES },
    );
  }
  return { transaction: parsed.data, canonical, byteLength };
}
