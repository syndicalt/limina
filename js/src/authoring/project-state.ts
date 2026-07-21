import { z } from "../../build/zod.bundle.mjs";
import {
  canonicalHash,
  canonicalStringify,
  utf8ByteLength,
  type ContentHash,
  type Sha256Function,
} from "./canonical.ts";
import { AuthoringError } from "./errors.ts";

export const WORLD_PROJECT_STATE_SCHEMA = "limina.world-project-state/v1" as const;
export const MAX_WORLD_PROJECT_ASSET_ID_LENGTH = 256;
export const MAX_WORLD_PROJECT_TERRAIN_EDIT_LAYERS = 256;
export const MAX_WORLD_PROJECT_ASSET_REFS = 2_048;
export const MAX_WORLD_PROJECT_STATE_BYTES = 1_048_576;

export const WorldProjectIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
export function isWorldProjectAssetId(value: string): boolean {
  if (value.length < 1 || value.length > MAX_WORLD_PROJECT_ASSET_ID_LENGTH || value.includes("\\") || value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && /^[A-Za-z0-9._-]+$/.test(segment)
  );
}

export const WorldProjectAssetIdSchema = z.string().refine(
  isWorldProjectAssetId,
  `assetId must be a project-relative identifier of at most ${MAX_WORLD_PROJECT_ASSET_ID_LENGTH} characters without traversal`,
);
const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/) as z.ZodType<ContentHash>;

export const WorldProjectAssetReferenceSchema = z.object({
  assetId: WorldProjectAssetIdSchema,
  hash: ContentHashSchema,
}).strict();

export const WorldProjectTerrainEditLayerSchema = WorldProjectAssetReferenceSchema.extend({
  layerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  baseTopologyHash: ContentHashSchema,
}).strict();

function uniqueReferenceIds(
  references: readonly { assetId: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < references.length; index++) {
    const assetId = references[index].assetId;
    if (seen.has(assetId)) {
      context.addIssue({ code: "custom", path: [index, "assetId"], message: `duplicate assetId '${assetId}'` });
    }
    seen.add(assetId);
  }
}

const TerrainEditLayersSchema = z.array(WorldProjectTerrainEditLayerSchema)
  .max(MAX_WORLD_PROJECT_TERRAIN_EDIT_LAYERS)
  .superRefine((layers, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < layers.length; index++) {
      const layerId = layers[index].layerId;
      if (seen.has(layerId)) {
        context.addIssue({ code: "custom", path: [index, "layerId"], message: `duplicate layerId '${layerId}'` });
      }
      seen.add(layerId);
    }
  });

const ProjectAssetsSchema = z.array(WorldProjectAssetReferenceSchema)
  .max(MAX_WORLD_PROJECT_ASSET_REFS)
  .superRefine(uniqueReferenceIds)
  .superRefine((references, context) => {
    for (let index = 1; index < references.length; index++) {
      if (references[index - 1].assetId >= references[index].assetId) {
        context.addIssue({ code: "custom", path: [index, "assetId"], message: "asset refs must be sorted by assetId" });
      }
    }
  });

export const WorldProjectRefsSchema = z.object({
  mapDoc: WorldProjectAssetReferenceSchema.nullable(),
  terrainEditLayers: TerrainEditLayersSchema,
  scene: WorldProjectAssetReferenceSchema.nullable(),
  assets: ProjectAssetsSchema,
  lookProfile: WorldProjectAssetReferenceSchema.nullable(),
}).strict();

export const WorldProjectRefsPatchSchema = z.object({
  mapDoc: WorldProjectAssetReferenceSchema.nullable().optional(),
  terrainEditLayers: TerrainEditLayersSchema.optional(),
  scene: WorldProjectAssetReferenceSchema.nullable().optional(),
  assets: ProjectAssetsSchema.optional(),
  lookProfile: WorldProjectAssetReferenceSchema.nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "project refs patch must change at least one field");

export const WorldProjectStateSchema = z.object({
  schema: z.literal(WORLD_PROJECT_STATE_SCHEMA),
  projectId: WorldProjectIdSchema,
  refs: WorldProjectRefsSchema,
  stateHash: ContentHashSchema,
}).strict();

export type WorldProjectAssetReference = z.infer<typeof WorldProjectAssetReferenceSchema>;
export type WorldProjectTerrainEditLayer = z.infer<typeof WorldProjectTerrainEditLayerSchema>;
export type WorldProjectRefs = z.infer<typeof WorldProjectRefsSchema>;
export type WorldProjectRefsPatch = z.infer<typeof WorldProjectRefsPatchSchema>;
export type WorldProjectState = z.infer<typeof WorldProjectStateSchema>;

export interface WorldProjectStateReader {
  readonly projectId: string;
  readonly state: WorldProjectState;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function parseCanonical<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  let canonical: string;
  try {
    canonical = canonicalStringify(input);
  } catch (error) {
    throw new AuthoringError("invalid_transaction", `${label} cannot be canonicalized`, {}, { cause: error });
  }
  const byteLength = utf8ByteLength(canonical);
  if (byteLength > MAX_WORLD_PROJECT_STATE_BYTES) {
    throw new AuthoringError("transaction_too_large", `${label} exceeds ${MAX_WORLD_PROJECT_STATE_BYTES} bytes`, {
      byteLength,
      maximum: MAX_WORLD_PROJECT_STATE_BYTES,
    });
  }
  const parsed = schema.safeParse(JSON.parse(canonical));
  if (!parsed.success) {
    throw new AuthoringError("invalid_transaction", `${label} failed schema validation`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (canonicalStringify(parsed.data) !== canonical) {
    throw new AuthoringError("invalid_transaction", `${label} contains fields not preserved by its wire schema`);
  }
  return immutable(parsed.data);
}

export function parseWorldProjectRefs(input: unknown): WorldProjectRefs {
  return parseCanonical(WorldProjectRefsSchema, input, "WorldProject refs");
}

export function parseWorldProjectRefsPatch(input: unknown): WorldProjectRefsPatch {
  return parseCanonical(WorldProjectRefsPatchSchema, input, "WorldProject refs patch");
}

function stateCore(projectId: string, refs: WorldProjectRefs) {
  return { schema: WORLD_PROJECT_STATE_SCHEMA, projectId, refs };
}

export function parseWorldProjectState(input: unknown, sha256: Sha256Function): WorldProjectState {
  const state = parseCanonical(WorldProjectStateSchema, input, "WorldProject state");
  const expected = canonicalHash(sha256, stateCore(state.projectId, state.refs));
  if (state.stateHash !== expected) {
    throw new AuthoringError("invalid_hash", "WorldProject state hash mismatch", {
      expectedStateHash: expected,
      actualStateHash: state.stateHash,
    });
  }
  return state;
}

/** In-memory WorldLog projection. Persistence is exclusively the recorded adapter operations. */
export class WorldProjectStateStore {
  readonly projectId: string;
  readonly #sha256: Sha256Function;
  #state: WorldProjectState;

  constructor(projectId: string, sha256: Sha256Function) {
    const parsedProjectId = WorldProjectIdSchema.parse(projectId);
    this.projectId = parsedProjectId;
    this.#sha256 = sha256;
    this.#state = this.#build({
      mapDoc: null,
      terrainEditLayers: [],
      scene: null,
      assets: [],
      lookProfile: null,
    });
  }

  get state(): WorldProjectState {
    return this.#state;
  }

  replace(refsInput: unknown): void {
    this.#state = this.#build(parseWorldProjectRefs(refsInput));
  }

  patch(patchInput: unknown): void {
    const patch = parseWorldProjectRefsPatch(patchInput);
    this.#state = this.#build({ ...this.#state.refs, ...patch });
  }

  restore(snapshotInput: unknown): void {
    const snapshot = parseWorldProjectState(snapshotInput, this.#sha256);
    if (snapshot.projectId !== this.projectId) {
      throw new AuthoringError("project_mismatch", "captured WorldProject state targets another project", {
        expectedProjectId: this.projectId,
        actualProjectId: snapshot.projectId,
      });
    }
    this.#state = snapshot;
  }

  #build(refsInput: unknown): WorldProjectState {
    const refs = parseWorldProjectRefs(refsInput);
    const core = stateCore(this.projectId, refs);
    return immutable(WorldProjectStateSchema.parse({ ...core, stateHash: canonicalHash(this.#sha256, core) }));
  }
}

export function createWorldProjectStateReader(store: WorldProjectStateStore): WorldProjectStateReader {
  return Object.freeze({
    get projectId(): string { return store.projectId; },
    get state(): WorldProjectState { return store.state; },
  });
}
