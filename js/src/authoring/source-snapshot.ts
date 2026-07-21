import { z } from "../../build/zod.bundle.mjs";
import { canonicalHash, canonicalStringify, utf8ByteLength, type ContentHash, type Sha256Function } from "./canonical.ts";
import { WorldProjectStateSchema, type WorldProjectState } from "./project-state.ts";
import { WorldProjectHeadSchema, type WorldProjectHead } from "./schema.ts";

export const WORLD_PROJECT_SOURCE_SNAPSHOT_SCHEMA = "limina.world-project-source-snapshot/v1" as const;
export const MAX_WORLD_PROJECT_SOURCE_SNAPSHOT_BYTES = 1_100_000;

const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/) as z.ZodType<ContentHash>;

export const WorldProjectSourceSnapshotSchema = z.object({
  schema: z.literal(WORLD_PROJECT_SOURCE_SNAPSHOT_SCHEMA),
  head: WorldProjectHeadSchema,
  projectState: WorldProjectStateSchema,
  snapshotHash: ContentHashSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.head.projectId !== snapshot.projectState.projectId) {
    context.addIssue({
      code: "custom",
      path: ["projectState", "projectId"],
      message: "source snapshot head and project state must belong to the same project",
    });
  }
});

export type WorldProjectSourceSnapshot = z.infer<typeof WorldProjectSourceSnapshotSchema>;

function snapshotCore(head: WorldProjectHead, projectState: WorldProjectState) {
  return {
    schema: WORLD_PROJECT_SOURCE_SNAPSHOT_SCHEMA,
    head,
    projectState,
  };
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Bind one synchronous authority read to an independently verifiable hash. */
export function createWorldProjectSourceSnapshot(
  sha256: Sha256Function,
  headInput: WorldProjectHead,
  projectStateInput: WorldProjectState,
): WorldProjectSourceSnapshot {
  const head = WorldProjectHeadSchema.parse(headInput);
  const projectState = WorldProjectStateSchema.parse(projectStateInput);
  if (head.projectId !== projectState.projectId) {
    throw new Error(`source snapshot project mismatch: head '${head.projectId}', state '${projectState.projectId}'`);
  }
  const core = snapshotCore(head, projectState);
  return immutable(WorldProjectSourceSnapshotSchema.parse({
    ...core,
    snapshotHash: canonicalHash(sha256, core),
  }));
}

/** Validate both the strict wire shape and its binding hash. */
export function parseWorldProjectSourceSnapshot(
  sha256: Sha256Function,
  input: unknown,
): WorldProjectSourceSnapshot {
  const canonical = canonicalStringify(input);
  if (utf8ByteLength(canonical) > MAX_WORLD_PROJECT_SOURCE_SNAPSHOT_BYTES) {
    throw new Error(`source snapshot exceeds ${MAX_WORLD_PROJECT_SOURCE_SNAPSHOT_BYTES} bytes`);
  }
  const snapshot = WorldProjectSourceSnapshotSchema.parse(JSON.parse(canonical));
  const expected = canonicalHash(sha256, snapshotCore(snapshot.head, snapshot.projectState));
  if (snapshot.snapshotHash !== expected) {
    throw new Error(`source snapshot hash mismatch: expected '${expected}', received '${snapshot.snapshotHash}'`);
  }
  return immutable(snapshot);
}
