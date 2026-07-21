import { z } from "../../../build/zod.bundle.mjs";
import type {
  AuthoringAdapter,
  AuthoringAdapterContext,
  AuthoringCapture,
} from "../adapter.ts";
import { canonicalStringify } from "../canonical.ts";
import type { AuthoringOperation } from "../schema.ts";
import {
  WorldProjectRefsPatchSchema,
  WorldProjectRefsSchema,
  WorldProjectIdSchema,
  createWorldProjectStateReader,
  WorldProjectStateStore,
  type WorldProjectRefs,
  type WorldProjectRefsPatch,
  type WorldProjectState,
  type WorldProjectStateReader,
} from "../project-state.ts";

export const WORLD_PROJECT_STATE_ADAPTER_ID = "project-state";
export const WORLD_PROJECT_STATE_ADAPTER_VERSION = "1.0.0";

const ReplaceInputSchema = z.object({
  projectId: WorldProjectIdSchema,
  refs: WorldProjectRefsSchema,
}).strict();

const PatchInputSchema = z.object({
  projectId: WorldProjectIdSchema,
  patch: WorldProjectRefsPatchSchema,
}).strict();

type ParsedOperation =
  | { action: "refs.replace"; projectId: string; refs: WorldProjectRefs }
  | { action: "refs.patch"; projectId: string; patch: WorldProjectRefsPatch };

function parseExact<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const canonical = canonicalStringify(input);
  const parsed = schema.safeParse(JSON.parse(canonical));
  if (!parsed.success) {
    throw new Error(`${label} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  if (canonicalStringify(parsed.data) !== canonical) throw new Error(`${label} is not exact`);
  return parsed.data;
}

/** Version-pinned transactional adapter over the authoritative project-source projection. */
export class WorldProjectStateAdapter implements AuthoringAdapter<WorldProjectState> {
  readonly id = WORLD_PROJECT_STATE_ADAPTER_ID;
  readonly version = WORLD_PROJECT_STATE_ADAPTER_VERSION;
  readonly #store: WorldProjectStateStore;
  readonly #parsed = new WeakMap<object, ParsedOperation>();

  constructor(store: WorldProjectStateStore) {
    this.#store = store;
  }

  stateKey(operation: AuthoringOperation): string {
    this.#parse(operation);
    return `world-project:${this.#store.projectId}:refs`;
  }

  preflight(operation: AuthoringOperation, context: AuthoringAdapterContext): void {
    const parsed = this.#parse(operation);
    if (parsed.projectId !== this.#store.projectId || parsed.projectId !== context.transaction.projectId) {
      throw new Error(`project-state operation targets '${parsed.projectId}', expected '${this.#store.projectId}'`);
    }
  }

  capture(_operation: AuthoringOperation): AuthoringCapture<WorldProjectState> {
    return { snapshot: this.#store.state, stateHash: this.#store.state.stateHash };
  }

  apply(operation: AuthoringOperation): void {
    const parsed = this.#parse(operation);
    if (parsed.action === "refs.replace") this.#store.replace(parsed.refs);
    else this.#store.patch(parsed.patch);
  }

  stateHash(): `sha256:${string}` {
    return this.#store.state.stateHash;
  }

  rollback(_operation: AuthoringOperation, capture: WorldProjectState): void {
    this.#store.restore(capture);
  }

  compensate(_operation: AuthoringOperation, originalCapture: WorldProjectState): void {
    this.#store.restore(originalCapture);
  }

  #parse(operation: AuthoringOperation): ParsedOperation {
    const cached = this.#parsed.get(operation);
    if (cached !== undefined) return cached;
    let parsed: ParsedOperation;
    switch (operation.action) {
      case "refs.replace": {
        const input = parseExact(ReplaceInputSchema, operation.input, "project-state refs.replace input");
        parsed = { action: operation.action, ...input };
        break;
      }
      case "refs.patch": {
        const input = parseExact(PatchInputSchema, operation.input, "project-state refs.patch input");
        parsed = { action: operation.action, ...input };
        break;
      }
      default:
        throw new Error(`unsupported project-state action '${operation.action}'`);
    }
    this.#parsed.set(operation, parsed);
    return parsed;
  }
}

export function createWorldProjectStateAuthoring(projectId: string, sha256: (canonical: string) => string): {
  readonly projectState: WorldProjectStateReader;
  readonly adapter: WorldProjectStateAdapter;
} {
  const store = new WorldProjectStateStore(projectId, sha256);
  return Object.freeze({ projectState: createWorldProjectStateReader(store), adapter: new WorldProjectStateAdapter(store) });
}
