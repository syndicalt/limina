import { z } from "../../build/zod.bundle.mjs";
import { canonicalHash, canonicalStringify, utf8ByteLength, type ContentHash, type Sha256Function } from "./canonical.ts";
import { AuthoringError } from "./errors.ts";
import {
  AuthoringTransactionSchema,
  CommittedAuthoringReceiptSchema,
  WorldProjectHeadSchema,
  parseAuthoringTransaction,
  type AuthoringTransaction,
  type CommittedAuthoringReceipt,
  type WorldProjectHead,
} from "./schema.ts";

export const DURABLE_AUTHORING_RECORD_SCHEMA = "limina.authoring-commit-record/v1" as const;
export const MAX_DURABLE_AUTHORING_RECORDS = 65_536;
export const MAX_DURABLE_AUTHORING_RECORD_BYTES = 524_288;
export const MAX_DURABLE_AUTHORING_LOG_BYTES = 67_108_864;

const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/) as z.ZodType<ContentHash>;

/** Compact commitFields payload embedded in the authoritative authoring.commit WorldLog command. */
export const DurableAuthoringRecordSchema = z.object({
  schema: z.literal(DURABLE_AUTHORING_RECORD_SCHEMA),
  previousRecordHash: ContentHashSchema.nullable(),
  receipt: CommittedAuthoringReceiptSchema,
  recordHash: ContentHashSchema,
}).strict();

export type DurableAuthoringRecord = z.infer<typeof DurableAuthoringRecordSchema>;

export const DurableAuthoringReplayEntrySchema = z.object({
  transaction: AuthoringTransactionSchema,
  commit: DurableAuthoringRecordSchema,
}).strict();

export interface DurableAuthoringReplayEntry {
  readonly transaction: AuthoringTransaction;
  readonly commit: DurableAuthoringRecord;
}

export interface ValidatedAuthoringReplayCheckpoint {
  readonly entries: readonly DurableAuthoringReplayEntry[];
  readonly head: WorldProjectHead;
  readonly tailRecordHash: ContentHash | null;
  readonly byteLength: number;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function recordPayload(record: Omit<DurableAuthoringRecord, "recordHash">): Omit<DurableAuthoringRecord, "recordHash"> {
  return {
    schema: DURABLE_AUTHORING_RECORD_SCHEMA,
    previousRecordHash: record.previousRecordHash,
    receipt: record.receipt,
  };
}

/** Build the compact envelope pinned by a recorded authoring.commit command. */
export function createDurableAuthoringRecord(
  sha256: Sha256Function,
  previousRecordHash: ContentHash | null,
  receipt: CommittedAuthoringReceipt,
): DurableAuthoringRecord {
  const payload = recordPayload({ schema: DURABLE_AUTHORING_RECORD_SCHEMA, previousRecordHash, receipt });
  return immutable({ ...payload, recordHash: canonicalHash(sha256, payload) });
}

function reject(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new AuthoringError("durable_chain_corrupt", message, details);
}

/** Strictly clone, bound, schema-check, and self-hash-check one embedded commit envelope. */
export function parseDurableAuthoringRecord(
  input: unknown,
  sha256: Sha256Function,
  index?: number,
): { record: DurableAuthoringRecord; canonical: string; byteLength: number } {
  const label = index === undefined ? "durable authoring record" : `durable authoring record ${index}`;
  let canonical: string;
  try {
    canonical = canonicalStringify(input);
  } catch (error) {
    throw new AuthoringError("invalid_durable_record", `${label} cannot be canonicalized`, { index }, { cause: error });
  }
  const byteLength = utf8ByteLength(canonical);
  if (byteLength > MAX_DURABLE_AUTHORING_RECORD_BYTES) {
    throw new AuthoringError(
      "durable_log_too_large",
      `${label} is ${byteLength} bytes; maximum is ${MAX_DURABLE_AUTHORING_RECORD_BYTES}`,
      { index, byteLength, maximum: MAX_DURABLE_AUTHORING_RECORD_BYTES },
    );
  }
  let parsed: ReturnType<typeof DurableAuthoringRecordSchema.safeParse>;
  try {
    parsed = DurableAuthoringRecordSchema.safeParse(JSON.parse(canonical));
  } catch (error) {
    throw new AuthoringError("invalid_durable_record", `${label} validation failed`, { index }, { cause: error });
  }
  if (!parsed.success) {
    throw new AuthoringError("invalid_durable_record", `${label} failed schema validation`, {
      index,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (canonicalStringify(parsed.data) !== canonical) {
    throw new AuthoringError("invalid_durable_record", `${label} contains fields not preserved by its schema`, { index });
  }
  const expectedRecordHash = canonicalHash(sha256, recordPayload(parsed.data));
  if (parsed.data.recordHash !== expectedRecordHash) {
    reject(`${label} hash does not match its content`, {
      index,
      expectedRecordHash,
      actualRecordHash: parsed.data.recordHash,
    });
  }
  return { record: immutable(parsed.data), canonical, byteLength };
}

/** Validate an embedded record against the separately recorded canonical transaction and prior head. */
export function validateDurableAuthoringRecord(
  recordInput: unknown,
  transactionInput: unknown,
  previousHeadInput: WorldProjectHead,
  previousRecordHash: ContentHash | null,
  sha256: Sha256Function,
  index?: number,
): DurableAuthoringRecord {
  const { record } = parseDurableAuthoringRecord(recordInput, sha256, index);
  const previousHead = WorldProjectHeadSchema.parse(previousHeadInput);
  const prepared = parseAuthoringTransaction(transactionInput);
  const transaction = prepared.transaction;
  const transactionHash = canonicalHash(sha256, transaction);
  const label = index === undefined ? "durable authoring record" : `durable authoring record ${index}`;

  if (record.previousRecordHash !== previousRecordHash) {
    reject(`${label} is not contiguous with the preceding record`, {
      index,
      expectedPreviousRecordHash: previousRecordHash,
      actualPreviousRecordHash: record.previousRecordHash,
    });
  }
  const { receipt } = record;
  if (transaction.projectId !== previousHead.projectId || receipt.projectId !== previousHead.projectId) {
    reject(`${label} targets a different WorldProject`, {
      index,
      expectedProjectId: previousHead.projectId,
      transactionProjectId: transaction.projectId,
      receiptProjectId: receipt.projectId,
    });
  }
  if (transaction.baseRevision !== previousHead.revision || transaction.baseHeadHash !== previousHead.headHash) {
    reject(`${label} transaction base does not match the preceding head`, {
      index,
      expectedRevision: previousHead.revision,
      actualRevision: transaction.baseRevision,
      expectedHeadHash: previousHead.headHash,
      actualHeadHash: transaction.baseHeadHash,
    });
  }
  if (
    receipt.transactionId !== transaction.transactionId ||
    receipt.transactionHash !== transactionHash ||
    receipt.previousRevision !== previousHead.revision ||
    receipt.committedRevision !== previousHead.revision + 1 ||
    receipt.previousHeadHash !== previousHead.headHash
  ) {
    reject(`${label} receipt does not bind its transaction and preceding head`, {
      index,
      transactionId: transaction.transactionId,
    });
  }
  const compensationTarget = transaction.compensates?.transactionId;
  if (receipt.compensates !== compensationTarget) {
    reject(`${label} compensation metadata is inconsistent`, {
      index,
      transactionCompensates: compensationTarget,
      receiptCompensates: receipt.compensates,
    });
  }
  if (compensationTarget === undefined) {
    if (receipt.operations.length !== transaction.operations.length) {
      reject(`${label} receipt operation count does not match its transaction`, {
        index,
        transactionOperations: transaction.operations.length,
        receiptOperations: receipt.operations.length,
      });
    }
    for (let operationIndex = 0; operationIndex < transaction.operations.length; operationIndex++) {
      const operation = transaction.operations[operationIndex];
      const committed = receipt.operations[operationIndex];
      if (
        committed.index !== operationIndex ||
        committed.adapter !== operation.adapter ||
        committed.action !== operation.action
      ) {
        reject(`${label} receipt operation ${operationIndex} does not match its transaction`, {
          index,
          operationIndex,
        });
      }
    }
  }
  const expectedHeadHash = canonicalHash(sha256, {
    schema: previousHead.schema,
    projectId: previousHead.projectId,
    revision: receipt.committedRevision,
    parentHash: previousHead.headHash,
    transactionHash,
    operations: receipt.operations,
  });
  if (receipt.headHash !== expectedHeadHash) {
    reject(`${label} receipt head hash is invalid`, { index, expectedHeadHash, actualHeadHash: receipt.headHash });
  }
  return record;
}

function canonicalGenesis(head: WorldProjectHead, sha256: Sha256Function): void {
  const expectedHeadHash = canonicalHash(sha256, {
    schema: head.schema,
    projectId: head.projectId,
    revision: 0,
    parentHash: null,
    transactionHash: null,
    operations: [],
  });
  if (head.revision !== 0 || head.headHash !== expectedHeadHash) {
    reject("authoring replay checkpoint must be anchored to the canonical project genesis", {
      projectId: head.projectId,
      revision: head.revision,
      expectedHeadHash,
      actualHeadHash: head.headHash,
    });
  }
}

/**
 * Validate a bounded diagnostic/checkpoint array extracted from authoritative WorldLog commands.
 * This array is not a second persistence authority; production replay consumes each WorldLog
 * transaction and its embedded commit envelope through `commitRecorded`.
 */
export function validateAuthoringReplayCheckpoint(
  input: unknown,
  genesisInput: WorldProjectHead,
  sha256: Sha256Function,
): ValidatedAuthoringReplayCheckpoint {
  const genesis = immutable(WorldProjectHeadSchema.parse(genesisInput));
  canonicalGenesis(genesis, sha256);
  if (!Array.isArray(input)) throw new AuthoringError("invalid_durable_record", "authoring replay checkpoint must be an array");
  if (input.length > MAX_DURABLE_AUTHORING_RECORDS) {
    throw new AuthoringError("durable_log_too_large", "authoring replay checkpoint exceeds the record-count limit", {
      recordCount: input.length,
      maximum: MAX_DURABLE_AUTHORING_RECORDS,
    });
  }

  const entries: DurableAuthoringReplayEntry[] = [];
  const transactions = new Map<string, {
    hash: ContentHash;
    transaction: AuthoringTransaction;
    commit: DurableAuthoringRecord;
    compensatedBy?: string;
  }>();
  let head = genesis;
  let previousRecordHash: ContentHash | null = null;
  let totalBytes = 2;

  for (let index = 0; index < input.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw new AuthoringError("invalid_durable_record", "authoring replay checkpoint must be a dense array", { index });
    }
    let canonical: string;
    try {
      canonical = canonicalStringify(input[index]);
    } catch (error) {
      throw new AuthoringError("invalid_durable_record", `authoring replay entry ${index} cannot be canonicalized`, { index }, { cause: error });
    }
    totalBytes += utf8ByteLength(canonical) + (index === 0 ? 0 : 1);
    if (totalBytes > MAX_DURABLE_AUTHORING_LOG_BYTES) {
      throw new AuthoringError("durable_log_too_large", "authoring replay checkpoint exceeds the byte limit", {
        index,
        byteLength: totalBytes,
        maximum: MAX_DURABLE_AUTHORING_LOG_BYTES,
      });
    }
    const parsed = DurableAuthoringReplayEntrySchema.safeParse(JSON.parse(canonical));
    if (!parsed.success || canonicalStringify(parsed.data) !== canonical) {
      throw new AuthoringError("invalid_durable_record", `authoring replay entry ${index} failed schema validation`, {
        index,
        issues: parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const transaction = immutable(parseAuthoringTransaction(parsed.data.transaction).transaction);
    const commit = validateDurableAuthoringRecord(
      parsed.data.commit,
      transaction,
      head,
      previousRecordHash,
      sha256,
      index,
    );
    const transactionHash = canonicalHash(sha256, transaction);
    const existing = transactions.get(transaction.transactionId);
    if (existing !== undefined) {
      reject(
        existing.hash === transactionHash
          ? `authoring replay entry ${index} duplicates transaction '${transaction.transactionId}'`
          : `authoring replay entry ${index} collides with transaction '${transaction.transactionId}'`,
        { index, transactionId: transaction.transactionId, priorHash: existing.hash, transactionHash },
      );
    }
    const compensationTarget = transaction.compensates?.transactionId;
    if (compensationTarget !== undefined) {
      const target = transactions.get(compensationTarget);
      if (target === undefined) {
        reject(`authoring replay entry ${index} compensates a transaction that does not precede it`, {
          index,
          transactionId: transaction.transactionId,
          compensationTarget,
        });
      }
      if (target.transaction.compensates !== undefined) {
        reject(`authoring replay entry ${index} attempts to compensate a compensation transaction`, {
          index,
          transactionId: transaction.transactionId,
          compensationTarget,
        });
      }
      if (target.compensatedBy !== undefined) {
        reject(`authoring replay entry ${index} compensates an already compensated transaction`, {
          index,
          transactionId: transaction.transactionId,
          compensationTarget,
          compensatedBy: target.compensatedBy,
        });
      }
      const expectedOperations = [...target.commit.receipt.operations].reverse();
      if (commit.receipt.operations.length !== expectedOperations.length) {
        reject(`authoring replay entry ${index} compensation receipt has the wrong operation count`, {
          index,
          compensationTarget,
          expectedOperations: expectedOperations.length,
          actualOperations: commit.receipt.operations.length,
        });
      }
      for (let operationIndex = 0; operationIndex < expectedOperations.length; operationIndex++) {
        const original = expectedOperations[operationIndex];
        const inverse = commit.receipt.operations[operationIndex];
        if (
          inverse.index !== original.index ||
          inverse.adapter !== original.adapter ||
          inverse.action !== original.action ||
          inverse.stateKey !== original.stateKey ||
          inverse.beforeStateHash !== original.afterStateHash ||
          inverse.afterStateHash !== original.beforeStateHash
        ) {
          reject(`authoring replay entry ${index} compensation receipt operation ${operationIndex} is inconsistent`, {
            index,
            compensationTarget,
            operationIndex,
          });
        }
      }
      target.compensatedBy = transaction.transactionId;
    }
    transactions.set(transaction.transactionId, { hash: transactionHash, transaction, commit });
    head = immutable({
      schema: head.schema,
      projectId: head.projectId,
      revision: commit.receipt.committedRevision,
      headHash: commit.receipt.headHash,
    });
    previousRecordHash = commit.recordHash;
    entries.push(immutable({ transaction, commit }));
  }

  return immutable({ entries, head, tailRecordHash: previousRecordHash, byteLength: totalBytes });
}
