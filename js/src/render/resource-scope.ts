export interface RenderDisposable {
  dispose(): void | Promise<void>;
}

export interface RenderResourceScopeOptions {
  maxReportedErrors?: number;
  onError?: (error: unknown) => void;
}

export class RenderResourceDisposalError extends Error {
  readonly failures: readonly string[];
  readonly omittedFailures: number;

  constructor(failures: readonly string[], omittedFailures: number) {
    super(`render resource cleanup failed for ${failures.length + omittedFailures} resource(s)`);
    this.name = "RenderResourceDisposalError";
    this.failures = Object.freeze([...failures]);
    this.omittedFailures = omittedFailures;
  }
}

export class RenderResourceScope {
  #resources: RenderDisposable[] = [];
  #owned = new Set<RenderDisposable>();
  #disposePromise: Promise<void> | undefined;
  #disposed = false;
  #maxReportedErrors: number;
  #onError: ((error: unknown) => void) | undefined;

  constructor({ maxReportedErrors = 16, onError }: RenderResourceScopeOptions = {}) {
    if (!Number.isSafeInteger(maxReportedErrors) || maxReportedErrors < 1 || maxReportedErrors > 256) {
      throw new RangeError("maxReportedErrors must be an integer in [1, 256]");
    }
    if (onError !== undefined && typeof onError !== "function") throw new TypeError("onError must be a function");
    this.#maxReportedErrors = maxReportedErrors;
    this.#onError = onError;
  }

  get size(): number { return this.#resources.length; }
  get disposed(): boolean { return this.#disposed; }

  own<T extends RenderDisposable>(resource: T): T {
    if (this.#disposed || this.#disposePromise !== undefined) throw new Error("render resource scope is disposing or disposed");
    if (resource === null || typeof resource !== "object" || typeof resource.dispose !== "function") {
      throw new TypeError("owned render resource must expose dispose()");
    }
    if (!this.#owned.has(resource)) {
      this.#owned.add(resource);
      this.#resources.push(resource);
    }
    return resource;
  }

  defer(dispose: () => void | Promise<void>): RenderDisposable {
    if (typeof dispose !== "function") throw new TypeError("deferred render cleanup must be a function");
    return this.own({ dispose });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposePromise = this.#disposeAll();
    return this.#disposePromise;
  }

  async #disposeAll(): Promise<void> {
    const failures: string[] = [];
    let omittedFailures = 0;
    for (let index = this.#resources.length - 1; index >= 0; index--) {
      try {
        await this.#resources[index].dispose();
      } catch (error) {
        try { this.#onError?.(error); } catch { /* cleanup reporting cannot stop cleanup */ }
        if (failures.length < this.#maxReportedErrors) failures.push(String((error as { message?: unknown })?.message ?? error));
        else omittedFailures++;
      }
    }
    this.#resources.length = 0;
    this.#owned.clear();
    this.#disposed = true;
    if (failures.length > 0) throw new RenderResourceDisposalError(failures, omittedFailures);
  }
}
