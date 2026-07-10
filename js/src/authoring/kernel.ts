import type { AuthoringAdapter, AuthoringAdapterAllowlist, AuthoringAdapterContext } from "./adapter.ts";
import {
  canonicalHash,
  canonicalStringify,
  normalizeSha256,
  utf8ByteLength,
  type ContentHash,
  type JsonValue,
  type Sha256Function,
} from "./canonical.ts";
import {
  MAX_DURABLE_AUTHORING_LOG_BYTES,
  MAX_DURABLE_AUTHORING_RECORD_BYTES,
  MAX_DURABLE_AUTHORING_RECORDS,
  createDurableAuthoringRecord,
  parseDurableAuthoringRecord,
  validateAuthoringReplayCheckpoint,
  validateDurableAuthoringRecord,
  type DurableAuthoringReplayEntry,
  type DurableAuthoringRecord,
} from "./durability.ts";
import { AuthoringError, errorMessage } from "./errors.ts";
import {
  AUTHORING_RECEIPT_SCHEMA,
  WORLD_PROJECT_HEAD_SCHEMA,
  WorldProjectHeadSchema,
  parseAuthoringTransaction,
  type AuthoringOperation,
  type AuthoringTransaction,
  type CommittedAuthoringReceipt,
  type CommittedOperationReceipt,
  type WorldProjectHead,
} from "./schema.ts";

interface AppliedOperation {
  readonly operation: AuthoringOperation;
  readonly adapter: AuthoringAdapter;
  readonly operationIndex: number;
  readonly stateKey: string;
  readonly capture: unknown;
  readonly beforeStateHash: ContentHash;
  readonly afterStateHash: ContentHash;
}

interface CommittedRecord {
  readonly transaction: AuthoringTransaction;
  readonly transactionHash: ContentHash;
  readonly receipt: CommittedAuthoringReceipt;
  readonly applied: readonly AppliedOperation[];
  readonly durableRecord: DurableAuthoringRecord;
  compensatedBy?: string;
}

export interface AuthoringDurabilityLimits {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

export interface AuthoringTransactionKernelOptions {
  readonly head: WorldProjectHead;
  readonly sha256: Sha256Function;
  readonly adapters: AuthoringAdapterAllowlist;
  /** Test/deployment ceilings may lower, but never raise, the protocol-wide bounds. */
  readonly durabilityLimits?: AuthoringDurabilityLimits;
}

export interface AuthoringCommitResult {
  readonly receipt: CommittedAuthoringReceipt;
  readonly record: DurableAuthoringRecord;
  /** False only for an exact transaction-id retry already present in the ledger. */
  readonly committed: boolean;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  }
  return value;
}

function validateStateHash(hash: string, adapter: string): ContentHash {
  try {
    return normalizeSha256(hash);
  } catch (error) {
    throw new AuthoringError("invalid_hash", `adapter '${adapter}' returned an invalid state hash`, { adapter, hash }, { cause: error });
  }
}

export function createWorldProjectHead(projectId: string, sha256: Sha256Function): WorldProjectHead {
  const candidate = {
    schema: WORLD_PROJECT_HEAD_SCHEMA,
    projectId,
    revision: 0,
    headHash: canonicalHash(sha256, {
      schema: WORLD_PROJECT_HEAD_SCHEMA,
      projectId,
      revision: 0,
      parentHash: null,
      transactionHash: null,
      operations: [],
    }),
  };
  return immutable(WorldProjectHeadSchema.parse(candidate));
}

/** Serialized, fail-stop authoring writer. One instance owns one WorldProject head. */
export class AuthoringTransactionKernel {
  readonly #sha256: Sha256Function;
  readonly #adapters: AuthoringAdapterAllowlist;
  readonly #ledger = new Map<string, CommittedRecord>();
  readonly #durableRecords: DurableAuthoringRecord[] = [];
  readonly #maxDurableRecords: number;
  readonly #maxDurableBytes: number;
  #head: WorldProjectHead;
  #durableTailHash: ContentHash | null = null;
  #durableByteLength = 2;
  #tail: Promise<void> = Promise.resolve();
  #poison?: AuthoringError;

  constructor(options: AuthoringTransactionKernelOptions) {
    this.#sha256 = options.sha256;
    this.#adapters = options.adapters;
    this.#head = immutable(WorldProjectHeadSchema.parse(options.head));
    this.#maxDurableRecords = this.#parseDurabilityLimit(
      options.durabilityLimits?.maxRecords,
      MAX_DURABLE_AUTHORING_RECORDS,
      "maxRecords",
    );
    this.#maxDurableBytes = this.#parseDurabilityLimit(
      options.durabilityLimits?.maxBytes,
      MAX_DURABLE_AUTHORING_LOG_BYTES,
      "maxBytes",
    );
  }

  get head(): WorldProjectHead {
    return this.#head;
  }

  get poisoned(): boolean {
    return this.#poison !== undefined;
  }

  get poisonReason(): AuthoringError | undefined {
    return this.#poison;
  }

  get durableRecordCount(): number {
    return this.#durableRecords.length;
  }

  get durableByteLength(): number {
    return this.#durableByteLength;
  }

  /** Run a synchronous authority read after prior commits and before later ones. */
  readCurrent<T>(reader: (head: WorldProjectHead) => T): Promise<T> {
    if (typeof reader !== "function") return Promise.reject(new TypeError("authoring readCurrent requires a reader"));
    const pending = this.#tail.then(() => reader(this.#head));
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  get latestDurableRecord(): DurableAuthoringRecord | undefined {
    return this.#durableRecords[this.#durableRecords.length - 1];
  }

  durableRecordForTransaction(transactionId: string): DurableAuthoringRecord | undefined {
    return this.#ledger.get(transactionId)?.durableRecord;
  }

  /**
   * Materialize a bounded diagnostic checkpoint from in-memory commits.
   * WorldLog remains authoritative; this convenience view must not be persisted as a second log.
   */
  exportReplayCheckpoint(): readonly DurableAuthoringReplayEntry[] {
    const entries: DurableAuthoringReplayEntry[] = [];
    let byteLength = 2;
    for (const commit of this.#durableRecords) {
      const entry = immutable({
        transaction: this.#ledger.get(commit.receipt.transactionId)!.transaction,
        commit,
      });
      byteLength += utf8ByteLength(canonicalStringify(entry)) + (entries.length === 0 ? 0 : 1);
      if (byteLength > MAX_DURABLE_AUTHORING_LOG_BYTES) {
        throw new AuthoringError("durable_log_too_large", "authoring replay checkpoint exceeds the byte limit", {
          byteLength,
          maximum: MAX_DURABLE_AUTHORING_LOG_BYTES,
          recordCount: entries.length + 1,
        });
      }
      entries.push(entry);
    }
    return immutable(entries);
  }

  /**
   * Rebuild authority state from a validated WorldLog-derived checkpoint on fresh adapters.
   *
   * All structural and chain validation finishes before the first adapter mutation. Reapplication
   * recreates the ledger and undo captures; each generated record must then equal its persisted
   * record exactly. Callers must discard the supplied adapters if replay throws because an adapter
   * implementation can diverge only after earlier valid records have already been applied.
   */
  static async replayCheckpoint(
    options: AuthoringTransactionKernelOptions,
    input: unknown,
  ): Promise<AuthoringTransactionKernel> {
    const validated = validateAuthoringReplayCheckpoint(input, options.head, options.sha256);
    const kernel = new AuthoringTransactionKernel(options);
    if (validated.entries.length > kernel.#maxDurableRecords || validated.byteLength > kernel.#maxDurableBytes) {
      throw new AuthoringError("durable_log_too_large", "authoring replay checkpoint exceeds configured limits", {
        recordCount: validated.entries.length,
        byteLength: validated.byteLength,
        maxRecords: kernel.#maxDurableRecords,
        maxBytes: kernel.#maxDurableBytes,
      });
    }
    for (let index = 0; index < validated.entries.length; index++) {
      const expected = validated.entries[index];
      try {
        await kernel.commitRecorded(expected.transaction, expected.commit);
      } catch (error) {
        kernel.#poison = new AuthoringError(
          "replay_diverged",
          `durable authoring replay failed while applying record ${index}: ${errorMessage(error)}`,
          { index, transactionId: expected.transaction.transactionId },
          { cause: error },
        );
        throw kernel.#poison;
      }
    }
    if (
      kernel.#head.revision !== validated.head.revision ||
      kernel.#head.headHash !== validated.head.headHash ||
      kernel.#durableTailHash !== validated.tailRecordHash
    ) {
      kernel.#poison = new AuthoringError("replay_diverged", "durable authoring replay did not reconstruct the validated head", {
        expectedRevision: validated.head.revision,
        actualRevision: kernel.#head.revision,
        expectedHeadHash: validated.head.headHash,
        actualHeadHash: kernel.#head.headHash,
      });
      throw kernel.#poison;
    }
    return kernel;
  }

  #parseDurabilityLimit(value: number | undefined, protocolMaximum: number, name: string): number {
    const resolved = value ?? protocolMaximum;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > protocolMaximum) {
      throw new AuthoringError("invalid_durable_record", `invalid authoring durability limit '${name}'`, {
        name,
        value: resolved,
        minimum: 1,
        maximum: protocolMaximum,
      });
    }
    return resolved;
  }

  /** All commit attempts are serialized so concurrent retries cannot apply twice. */
  commit(input: unknown): Promise<CommittedAuthoringReceipt> {
    const prepared = parseAuthoringTransaction(input);
    const transactionHash = normalizeSha256(this.#sha256(prepared.canonical));
    const transaction = immutable(prepared.transaction);
    const pending = this.#tail.then(() => this.#commitExclusive(transaction, transactionHash));
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /** Commit and return the exact compact commitFields envelope without a racy latest lookup. */
  commitWithRecord(input: unknown): Promise<AuthoringCommitResult> {
    const prepared = parseAuthoringTransaction(input);
    const transactionHash = normalizeSha256(this.#sha256(prepared.canonical));
    const transaction = immutable(prepared.transaction);
    const pending = this.#tail.then(async () => {
      const committed = !this.#ledger.has(transaction.transactionId);
      const receipt = await this.#commitExclusive(transaction, transactionHash);
      const record = this.#ledger.get(transaction.transactionId)?.durableRecord;
      if (record === undefined) {
        throw new AuthoringError("replay_diverged", "committed authoring transaction has no commit envelope", {
          transactionId: transaction.transactionId,
        });
      }
      return immutable({ receipt, record, committed });
    });
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /** Replay one authoritative WorldLog command and verify its embedded commitFields atomically. */
  commitRecorded(input: unknown, expectedRecordInput: unknown): Promise<CommittedAuthoringReceipt> {
    const prepared = parseAuthoringTransaction(input);
    const transactionHash = normalizeSha256(this.#sha256(prepared.canonical));
    const transaction = immutable(prepared.transaction);
    const expectedRecord = parseDurableAuthoringRecord(expectedRecordInput, this.#sha256).record;
    const pending = this.#tail.then(() => this.#commitExclusive(transaction, transactionHash, expectedRecord));
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #hashJson = (value: JsonValue | unknown): ContentHash => canonicalHash(this.#sha256, value);

  #context(
    transaction: AuthoringTransaction,
    operationIndex: number,
    mode: AuthoringAdapterContext["mode"],
  ): AuthoringAdapterContext {
    return { transaction, operationIndex, head: this.#head, mode, hashJson: this.#hashJson };
  }

  #resolveAdapter(operation: AuthoringOperation, operationIndex: number): AuthoringAdapter {
    const adapter = this.#adapters.get(operation.adapter);
    if (adapter === undefined) {
      throw new AuthoringError("unknown_adapter", `unknown authoring adapter '${operation.adapter}'`, {
        adapter: operation.adapter,
        operationIndex,
      });
    }
    if (!this.#adapters.isAllowed(operation.adapter)) {
      throw new AuthoringError("adapter_not_allowed", `authoring adapter '${operation.adapter}' is not allowed`, {
        adapter: operation.adapter,
        operationIndex,
      });
    }
    if (operation.adapterVersion !== adapter.version) {
      throw new AuthoringError(
        "adapter_version_mismatch",
        `authoring adapter '${operation.adapter}' version '${operation.adapterVersion}' is unavailable`,
        {
          adapter: operation.adapter,
          operationIndex,
          recordedVersion: operation.adapterVersion,
          availableVersion: adapter.version,
        },
      );
    }
    return adapter;
  }

  #stateKey(adapter: AuthoringAdapter, operation: AuthoringOperation, operationIndex: number): string {
    let stateKey: string;
    try {
      stateKey = adapter.stateKey(operation);
    } catch (error) {
      throw new AuthoringError("preflight_failed", `adapter '${adapter.id}' could not identify guarded state`, {
        adapter: adapter.id,
        operationIndex,
      }, { cause: error });
    }
    if (typeof stateKey !== "string" || stateKey.length === 0 || stateKey.length > 256) {
      throw new AuthoringError("preflight_failed", `adapter '${adapter.id}' returned an invalid state key`, {
        adapter: adapter.id,
        operationIndex,
        stateKey,
      });
    }
    return stateKey;
  }

  async #commitExclusive(
    transaction: AuthoringTransaction,
    transactionHash: ContentHash,
    expectedRecord?: DurableAuthoringRecord,
  ): Promise<CommittedAuthoringReceipt> {
    const existing = this.#ledger.get(transaction.transactionId);
    if (existing !== undefined) {
      if (existing.transactionHash === transactionHash) {
        if (expectedRecord !== undefined && canonicalStringify(existing.durableRecord) !== canonicalStringify(expectedRecord)) {
          throw new AuthoringError("replay_diverged", "recorded retry does not match the committed authoring envelope", {
            transactionId: transaction.transactionId,
            committedRecordHash: existing.durableRecord.recordHash,
            attemptedRecordHash: expectedRecord.recordHash,
          });
        }
        return existing.receipt;
      }
      throw new AuthoringError(
        "transaction_id_collision",
        `transaction id '${transaction.transactionId}' is already committed with different content`,
        { transactionId: transaction.transactionId, committedHash: existing.transactionHash, attemptedHash: transactionHash },
      );
    }
    if (this.#poison !== undefined) {
      throw new AuthoringError("writer_poisoned", "authoring writer is poisoned after an incomplete rollback", {
        poisonCode: this.#poison.code,
        poisonMessage: this.#poison.message,
      }, { cause: this.#poison });
    }
    if (expectedRecord !== undefined) {
      validateDurableAuthoringRecord(
        expectedRecord,
        transaction,
        this.#head,
        this.#durableTailHash,
        this.#sha256,
      );
    }
    if (this.#durableRecords.length >= this.#maxDurableRecords) {
      throw new AuthoringError("durable_log_too_large", "durable authoring record limit has been reached", {
        recordCount: this.#durableRecords.length,
        maximum: this.#maxDurableRecords,
      });
    }
    if (transaction.projectId !== this.#head.projectId) {
      throw new AuthoringError("project_mismatch", "transaction targets a different WorldProject", {
        expectedProjectId: this.#head.projectId,
        actualProjectId: transaction.projectId,
      });
    }
    if (transaction.baseRevision !== this.#head.revision || transaction.baseHeadHash !== this.#head.headHash) {
      throw new AuthoringError("stale_head", "transaction base does not match the current WorldProject head", {
        expectedRevision: this.#head.revision,
        actualRevision: transaction.baseRevision,
        expectedHeadHash: this.#head.headHash,
        actualHeadHash: transaction.baseHeadHash,
      });
    }
    if (this.#head.revision >= Number.MAX_SAFE_INTEGER) {
      throw new AuthoringError("apply_failed", "WorldProject revision exhausted the safe integer range");
    }
    return transaction.compensates === undefined
      ? this.#applyNormal(transaction, transactionHash, expectedRecord)
      : this.#applyCompensation(transaction, transactionHash, transaction.compensates.transactionId, expectedRecord);
  }

  async #preflight(
    entries: readonly { operation: AuthoringOperation; adapter: AuthoringAdapter; operationIndex: number }[],
    transaction: AuthoringTransaction,
    mode: "apply" | "compensate",
  ): Promise<void> {
    for (const entry of entries) {
      try {
        await entry.adapter.preflight(entry.operation, this.#context(transaction, entry.operationIndex, mode));
      } catch (error) {
        throw new AuthoringError("preflight_failed", `authoring operation ${entry.operationIndex} failed preflight: ${errorMessage(error)}`, {
          adapter: entry.operation.adapter,
          operationIndex: entry.operationIndex,
        }, { cause: error });
      }
    }
  }

  async #applyNormal(
    transaction: AuthoringTransaction,
    transactionHash: ContentHash,
    expectedRecord?: DurableAuthoringRecord,
  ): Promise<CommittedAuthoringReceipt> {
    const entries = transaction.operations.map((operation, operationIndex) => ({
      operation,
      operationIndex,
      adapter: this.#resolveAdapter(operation, operationIndex),
    })).map((entry) => ({
      ...entry,
      stateKey: this.#stateKey(entry.adapter, entry.operation, entry.operationIndex),
    }));
    await this.#preflight(entries, transaction, "apply");

    const applied: AppliedOperation[] = [];
    try {
      for (const entry of entries) {
        const context = this.#context(transaction, entry.operationIndex, "apply");
        let captured;
        try {
          captured = await entry.adapter.capture(entry.operation, context);
        } catch (error) {
          throw new AuthoringError("capture_failed", `authoring operation ${entry.operationIndex} could not capture state: ${errorMessage(error)}`, {
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
          }, { cause: error });
        }
        const beforeStateHash = validateStateHash(captured.stateHash, entry.operation.adapter);
        if (entry.operation.guard !== undefined && entry.operation.guard.beforeHash !== beforeStateHash) {
          throw new AuthoringError("state_guard_conflict", `authoring operation ${entry.operationIndex} state guard does not match`, {
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
            expectedStateHash: entry.operation.guard.beforeHash,
            actualStateHash: beforeStateHash,
          });
        }

        const appliedEntry: AppliedOperation = {
          ...entry,
          capture: captured.snapshot,
          beforeStateHash,
          afterStateHash: beforeStateHash,
        };
        applied.push(appliedEntry);
        try {
          await entry.adapter.apply(entry.operation, captured.snapshot, context);
          const afterStateHash = validateStateHash(await entry.adapter.stateHash(entry.operation, context), entry.operation.adapter);
          applied[applied.length - 1] = { ...appliedEntry, afterStateHash };
          if (entry.operation.guard?.afterHash !== undefined && entry.operation.guard.afterHash !== afterStateHash) {
            throw new AuthoringError("state_guard_conflict", `authoring operation ${entry.operationIndex} result guard does not match`, {
              adapter: entry.operation.adapter,
              operationIndex: entry.operationIndex,
              expectedStateHash: entry.operation.guard.afterHash,
              actualStateHash: afterStateHash,
            });
          }
        } catch (error) {
          if (error instanceof AuthoringError) throw error;
          throw new AuthoringError("apply_failed", `authoring operation ${entry.operationIndex} failed: ${errorMessage(error)}`, {
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
          }, { cause: error });
        }
      }
    } catch (error) {
      if (applied.length > 0) await this.#rollback(applied, transaction, error);
      throw error;
    }

    try {
      return this.#commitRecord(transaction, transactionHash, applied, undefined, expectedRecord);
    } catch (error) {
      await this.#rollback(applied, transaction, error);
      throw error;
    }
  }

  async #applyCompensation(
    transaction: AuthoringTransaction,
    transactionHash: ContentHash,
    targetId: string,
    expectedRecord?: DurableAuthoringRecord,
  ): Promise<CommittedAuthoringReceipt> {
    const target = this.#ledger.get(targetId);
    if (target === undefined || target.transaction.projectId !== transaction.projectId) {
      throw new AuthoringError("compensation_not_found", `compensated transaction '${targetId}' was not found`, { transactionId: targetId });
    }
    if (target.transaction.compensates !== undefined) {
      throw new AuthoringError("compensation_not_supported", "compensating a compensation transaction is not supported", { transactionId: targetId });
    }
    if (target.compensatedBy !== undefined) {
      throw new AuthoringError("already_compensated", `transaction '${targetId}' was already compensated`, {
        transactionId: targetId,
        compensatedBy: target.compensatedBy,
      });
    }

    const entries = [...target.applied].reverse().map((original) => {
      const adapter = this.#resolveAdapter(original.operation, original.operationIndex);
      if (adapter.compensate === undefined) {
        throw new AuthoringError("compensation_not_supported", `adapter '${adapter.id}' cannot compensate committed operations`, {
          adapter: adapter.id,
          transactionId: targetId,
        });
      }
      return { ...original, adapter, stateKey: this.#stateKey(adapter, original.operation, original.operationIndex) };
    });
    await this.#preflight(entries, transaction, "compensate");

    // Validate every guard before the first mutation. External or intervening domain changes are
    // therefore conflicts, never data overwritten by a blind inverse.
    const checkedState = new Set<string>();
    for (const entry of entries) {
      const scopedKey = `${entry.adapter.id}\u0000${entry.stateKey}`;
      if (checkedState.has(scopedKey)) continue;
      checkedState.add(scopedKey);
      const actual = validateStateHash(
        await entry.adapter.stateHash(entry.operation, this.#context(transaction, entry.operationIndex, "compensate")),
        entry.operation.adapter,
      );
      if (actual !== entry.afterStateHash) {
        throw new AuthoringError("compensation_conflict", `state changed after transaction '${targetId}' committed`, {
          transactionId: targetId,
          adapter: entry.operation.adapter,
          operationIndex: entry.operationIndex,
          expectedStateHash: entry.afterStateHash,
          actualStateHash: actual,
        });
      }
    }

    const compensated: AppliedOperation[] = [];
    try {
      for (const entry of entries) {
        const context = this.#context(transaction, entry.operationIndex, "compensate");
        let current;
        try {
          current = await entry.adapter.capture(entry.operation, context);
        } catch (error) {
          throw new AuthoringError("capture_failed", `compensation operation ${entry.operationIndex} could not capture state: ${errorMessage(error)}`, {
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
          }, { cause: error });
        }
        const beforeStateHash = validateStateHash(current.stateHash, entry.operation.adapter);
        if (beforeStateHash !== entry.afterStateHash) {
          throw new AuthoringError("compensation_conflict", `state changed while compensating transaction '${targetId}'`, {
            transactionId: targetId,
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
            expectedStateHash: entry.afterStateHash,
            actualStateHash: beforeStateHash,
          });
        }
        const rollbackEntry: AppliedOperation = {
          operation: entry.operation,
          adapter: entry.adapter,
          operationIndex: entry.operationIndex,
          stateKey: entry.stateKey,
          capture: current.snapshot,
          beforeStateHash,
          afterStateHash: beforeStateHash,
        };
        compensated.push(rollbackEntry);
        try {
          await entry.adapter.compensate!(entry.operation, entry.capture, context);
          const afterStateHash = validateStateHash(await entry.adapter.stateHash(entry.operation, context), entry.operation.adapter);
          compensated[compensated.length - 1] = { ...rollbackEntry, afterStateHash };
          if (afterStateHash !== entry.beforeStateHash) {
            throw new AuthoringError("compensation_conflict", `adapter '${entry.adapter.id}' did not restore the guarded pre-transaction state`, {
              transactionId: targetId,
              adapter: entry.adapter.id,
              operationIndex: entry.operationIndex,
              expectedStateHash: entry.beforeStateHash,
              actualStateHash: afterStateHash,
            });
          }
        } catch (error) {
          if (error instanceof AuthoringError) throw error;
          throw new AuthoringError("apply_failed", `compensation operation ${entry.operationIndex} failed: ${errorMessage(error)}`, {
            adapter: entry.operation.adapter,
            operationIndex: entry.operationIndex,
          }, { cause: error });
        }
      }
    } catch (error) {
      if (compensated.length > 0) await this.#rollback(compensated, transaction, error);
      throw error;
    }

    let receipt: CommittedAuthoringReceipt;
    try {
      receipt = this.#commitRecord(transaction, transactionHash, compensated, targetId, expectedRecord);
    } catch (error) {
      await this.#rollback(compensated, transaction, error);
      throw error;
    }
    target.compensatedBy = transaction.transactionId;
    return receipt;
  }

  async #rollback(applied: readonly AppliedOperation[], transaction: AuthoringTransaction, originalError: unknown): Promise<void> {
    const failures: { adapter: string; operationIndex: number; message: string }[] = [];
    for (let index = applied.length - 1; index >= 0; index--) {
      const entry = applied[index];
      try {
        await entry.adapter.rollback(
          entry.operation,
          entry.capture,
          this.#context(transaction, entry.operationIndex, "rollback"),
        );
        const restoredHash = validateStateHash(
          await entry.adapter.stateHash(entry.operation, this.#context(transaction, entry.operationIndex, "rollback")),
          entry.adapter.id,
        );
        if (restoredHash !== entry.beforeStateHash) {
          throw new Error(`rollback restored ${restoredHash}; expected ${entry.beforeStateHash}`);
        }
      } catch (error) {
        failures.push({ adapter: entry.adapter.id, operationIndex: entry.operationIndex, message: errorMessage(error) });
      }
    }
    if (failures.length > 0) {
      this.#poison = new AuthoringError("rollback_failed", "one or more authoring operations could not be rolled back", {
        originalError: errorMessage(originalError),
        failures,
      }, { cause: originalError });
      throw this.#poison;
    }
  }

  #commitRecord(
    transaction: AuthoringTransaction,
    transactionHash: ContentHash,
    applied: readonly AppliedOperation[],
    compensates?: string,
    expectedRecord?: DurableAuthoringRecord,
  ): CommittedAuthoringReceipt {
    const previous = this.#head;
    const committedRevision = previous.revision + 1;
    const operations: CommittedOperationReceipt[] = applied.map((entry) => ({
      index: entry.operationIndex,
      adapter: entry.operation.adapter,
      action: entry.operation.action,
      stateKey: entry.stateKey,
      beforeStateHash: entry.beforeStateHash,
      afterStateHash: entry.afterStateHash,
    }));
    const headHash = this.#hashJson({
      schema: WORLD_PROJECT_HEAD_SCHEMA,
      projectId: previous.projectId,
      revision: committedRevision,
      parentHash: previous.headHash,
      transactionHash,
      operations,
    });
    const receipt = immutable({
      schema: AUTHORING_RECEIPT_SCHEMA,
      transactionId: transaction.transactionId,
      projectId: transaction.projectId,
      transactionHash,
      previousRevision: previous.revision,
      committedRevision,
      previousHeadHash: previous.headHash,
      headHash,
      operations,
      ...(compensates === undefined ? {} : { compensates }),
    } satisfies CommittedAuthoringReceipt);
    const durableRecord = createDurableAuthoringRecord(
      this.#sha256,
      this.#durableTailHash,
      receipt,
    );
    if (expectedRecord !== undefined && canonicalStringify(durableRecord) !== canonicalStringify(expectedRecord)) {
      throw new AuthoringError("replay_diverged", "recorded authoring commit diverged from its embedded commitFields", {
        transactionId: transaction.transactionId,
        expectedRecordHash: expectedRecord.recordHash,
        actualRecordHash: durableRecord.recordHash,
      });
    }
    const durableRecordBytes = utf8ByteLength(canonicalStringify(durableRecord));
    if (durableRecordBytes > MAX_DURABLE_AUTHORING_RECORD_BYTES) {
      throw new AuthoringError("durable_log_too_large", "committed authoring record exceeds the protocol byte limit", {
        transactionId: transaction.transactionId,
        byteLength: durableRecordBytes,
        maximum: MAX_DURABLE_AUTHORING_RECORD_BYTES,
      });
    }
    // The ledger retains the transaction as well as the compact envelope. Account for the exact
    // replay-entry representation so a stream of near-limit transactions cannot evade the cap.
    const durableEntryBytes = utf8ByteLength(canonicalStringify({ transaction, commit: durableRecord }));
    const nextDurableByteLength = this.#durableByteLength + durableEntryBytes + (this.#durableRecords.length === 0 ? 0 : 1);
    if (nextDurableByteLength > this.#maxDurableBytes) {
      throw new AuthoringError("durable_log_too_large", "durable authoring byte limit would be exceeded", {
        transactionId: transaction.transactionId,
        byteLength: nextDurableByteLength,
        maximum: this.#maxDurableBytes,
      });
    }
    const nextHead = immutable({
      schema: WORLD_PROJECT_HEAD_SCHEMA,
      projectId: previous.projectId,
      revision: committedRevision,
      headHash,
    });
    this.#head = nextHead;
    this.#ledger.set(transaction.transactionId, {
      transaction,
      transactionHash,
      receipt,
      applied: [...applied],
      durableRecord,
    });
    this.#durableRecords.push(durableRecord);
    this.#durableTailHash = durableRecord.recordHash;
    this.#durableByteLength = nextDurableByteLength;
    return receipt;
  }
}
