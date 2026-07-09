import type { ContentHash, JsonValue } from "./canonical.ts";
import type { AuthoringOperation, AuthoringTransaction, WorldProjectHead } from "./schema.ts";

export type AuthoringAdapterMode = "apply" | "compensate" | "rollback";

export interface AuthoringAdapterContext {
  readonly transaction: AuthoringTransaction;
  readonly operationIndex: number;
  readonly head: WorldProjectHead;
  readonly mode: AuthoringAdapterMode;
  readonly hashJson: (value: JsonValue | unknown) => ContentHash;
}

export interface AuthoringCapture<Capture = unknown> {
  /** Opaque adapter-owned snapshot sufficient to restore the affected state exactly. */
  readonly snapshot: Capture;
  /** Hash of the state represented by snapshot. */
  readonly stateHash: ContentHash;
}

/**
 * Transactional boundary implemented by each authoring domain (scene, terrain, map, assets).
 * Methods may perform I/O. preflight and capture MUST NOT mutate authoring state.
 */
export interface AuthoringAdapter<Capture = unknown> {
  readonly id: string;
  /** Stable identity of the state guarded by this operation (entity id, terrain chunk id, etc.). */
  stateKey(operation: AuthoringOperation): string;
  preflight(operation: AuthoringOperation, context: AuthoringAdapterContext): void | Promise<void>;
  capture(operation: AuthoringOperation, context: AuthoringAdapterContext): AuthoringCapture<Capture> | Promise<AuthoringCapture<Capture>>;
  apply(operation: AuthoringOperation, capture: Capture, context: AuthoringAdapterContext): void | Promise<void>;
  stateHash(operation: AuthoringOperation, context: AuthoringAdapterContext): ContentHash | Promise<ContentHash>;
  rollback(operation: AuthoringOperation, capture: Capture, context: AuthoringAdapterContext): void | Promise<void>;
  /** Restore the capture made before the original committed operation. */
  compensate?(operation: AuthoringOperation, originalCapture: Capture, context: AuthoringAdapterContext): void | Promise<void>;
}

export interface AuthoringAdapterAllowlist {
  get(adapterId: string): AuthoringAdapter | undefined;
  isAllowed(adapterId: string): boolean;
}

/** Immutable registry that distinguishes an unknown adapter from a known but disabled one. */
export class StaticAuthoringAdapterAllowlist implements AuthoringAdapterAllowlist {
  readonly #adapters: ReadonlyMap<string, AuthoringAdapter>;
  readonly #allowed: ReadonlySet<string>;

  constructor(adapters: Iterable<AuthoringAdapter>, allowedAdapterIds?: Iterable<string>) {
    const byId = new Map<string, AuthoringAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.id)) throw new Error(`duplicate authoring adapter '${adapter.id}'`);
      byId.set(adapter.id, adapter);
    }
    this.#adapters = byId;
    this.#allowed = allowedAdapterIds === undefined ? new Set(byId.keys()) : new Set(allowedAdapterIds);
  }

  get(adapterId: string): AuthoringAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  isAllowed(adapterId: string): boolean {
    return this.#allowed.has(adapterId);
  }
}
