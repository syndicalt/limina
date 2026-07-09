import { z } from "../../build/zod.bundle.mjs";
import type { Sha256Function } from "./canonical.ts";
import { DurableAuthoringRecordSchema } from "./durability.ts";
import { AuthoringError, type AuthoringErrorCode } from "./errors.ts";
import { AuthoringTransactionKernel, createWorldProjectHead } from "./kernel.ts";
import { AuthoringTransactionSchema, CommittedAuthoringReceiptSchema, WorldProjectHeadSchema } from "./schema.ts";
import type { AuthoringAdapterAllowlist } from "./adapter.ts";
import { SkillInvocationError, type SkillDefinition, type SkillRegistry } from "../skills/registry.ts";

export interface AuthoringSkillOptions {
  readonly projectId: string;
  readonly sha256: Sha256Function;
  readonly adapters: AuthoringAdapterAllowlist;
}

export interface AuthoringSkillRuntime {
  readonly kernel: AuthoringTransactionKernel;
}

const commitInputSchema = z.object({
  transaction: AuthoringTransactionSchema,
  /** Recorder-populated replay proof. Live callers omit this field. */
  commitRecord: DurableAuthoringRecordSchema.optional(),
}).strict();

const commitOutputSchema = z.object({
  receipt: CommittedAuthoringReceiptSchema,
  commitRecord: DurableAuthoringRecordSchema,
  committed: z.boolean(),
}).strict();

type CommitInput = z.infer<typeof commitInputSchema>;
type CommitOutput = z.infer<typeof commitOutputSchema>;

const CONFLICT_CODES = new Set<AuthoringErrorCode>([
  "stale_head",
  "transaction_id_collision",
  "state_guard_conflict",
  "compensation_conflict",
  "already_compensated",
]);

function mapAuthoringError(error: unknown): never {
  if (!(error instanceof AuthoringError)) throw error;
  if (CONFLICT_CODES.has(error.code)) throw new SkillInvocationError("conflict", error.message, { cause: error });
  switch (error.code) {
    case "adapter_not_allowed":
      throw new SkillInvocationError("forbidden", error.message, { cause: error });
    case "compensation_not_found":
      throw new SkillInvocationError("not_found", error.message, { cause: error });
    case "transaction_too_large":
    case "durable_log_too_large":
      throw new SkillInvocationError("resource_exhausted", error.message, { cause: error });
    case "invalid_transaction":
    case "invalid_hash":
    case "project_mismatch":
    case "unknown_adapter":
    case "adapter_version_mismatch":
    case "preflight_failed":
    case "compensation_not_supported":
      throw new SkillInvocationError("invalid_input", error.message, { cause: error });
    default:
      throw new SkillInvocationError("handler_error", error.message, { cause: error });
  }
}

export function registerAuthoringSkills(registry: SkillRegistry, options: AuthoringSkillOptions): AuthoringSkillRuntime {
  const kernel = new AuthoringTransactionKernel({
    head: createWorldProjectHead(options.projectId, options.sha256),
    sha256: options.sha256,
    adapters: options.adapters,
  });

  const commit: SkillDefinition<CommitInput, CommitOutput> = {
    name: "authoring.commit",
    version: "1.0.0",
    description: "Atomically commit a version-pinned WorldProject transaction against an exact base head. Returns the immutable receipt and replay proof. Stale heads fail; retries with identical transaction content are idempotent.",
    category: "world",
    permissions: ["authoring.write"],
    effect: "write",
    priority: "core",
    input: commitInputSchema,
    output: commitOutputSchema,
    commitFields: ["commitRecord"],
    shouldRecordResult: (result) => result.committed,
    handler: async (input) => {
      try {
        if (input.commitRecord !== undefined) {
          const existed = kernel.durableRecordForTransaction(input.transaction.transactionId) !== undefined;
          const receipt = await kernel.commitRecorded(input.transaction, input.commitRecord);
          const commitRecord = kernel.durableRecordForTransaction(input.transaction.transactionId);
          if (commitRecord === undefined) throw new AuthoringError("replay_diverged", "replayed transaction has no commit record");
          return { receipt, commitRecord, committed: !existed };
        }
        const result = await kernel.commitWithRecord(input.transaction);
        return { receipt: result.receipt, commitRecord: result.record, committed: result.committed };
      } catch (error) {
        return mapAuthoringError(error);
      }
    },
  };

  const head: SkillDefinition<Record<string, never>, z.infer<typeof WorldProjectHeadSchema>> = {
    name: "authoring.head",
    version: "1.0.0",
    description: "Read the current authoritative WorldProject revision and content hash used as the exact base for the next transaction.",
    category: "world",
    permissions: ["authoring.read"],
    effect: "read",
    priority: "core",
    input: z.object({}).strict(),
    output: WorldProjectHeadSchema,
    handler: () => kernel.head,
  };

  registry.register(commit);
  registry.register(head);
  return { kernel };
}
