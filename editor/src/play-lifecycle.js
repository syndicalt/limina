const HEAD_SCHEMA = "limina.world-project-head/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;
const LOCKED_PHASES = new Set(["starting", "playing", "paused", "stopping", "error"]);

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function validatePlayHead(head) {
  if (head?.schema !== HEAD_SCHEMA || typeof head.projectId !== "string" || head.projectId.length > 64 ||
      !PROJECT_ID.test(head.projectId) || !Number.isSafeInteger(head.revision) || head.revision < 0 ||
      typeof head.headHash !== "string" || !HASH.test(head.headHash)) {
    throw new Error("authoring.head returned an invalid project head for Play");
  }
  return Object.freeze({
    schema: HEAD_SCHEMA,
    projectId: head.projectId,
    revision: head.revision,
    headHash: head.headHash,
  });
}

export function createPlaySnapshot(commands, head, cursor) {
  if (!Array.isArray(commands)) throw new TypeError("Play commands must be an array");
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Play cursor must be a non-negative safe integer");
  const immutableCommands = deepFreeze(clone(commands));
  const source = Object.freeze({ ...validatePlayHead(head), cursor, commandCount: immutableCommands.length });
  return Object.freeze({ commands: immutableCommands, source });
}

export class PlayLifecycleController {
  #phase = "edit";
  #generation = 0;
  #snapshot;
  #stale = false;
  #error = "";
  #listeners = new Set();

  get phase() { return this.#phase; }
  get generation() { return this.#generation; }
  get snapshot() { return this.#snapshot; }
  get stale() { return this.#stale; }
  get error() { return this.#error; }
  isAuthoringLocked() { return LOCKED_PHASES.has(this.#phase); }
  is(token, phase) { return token === this.#generation && this.#phase === phase; }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("Play lifecycle listener must be a function");
    this.#listeners.add(listener);
    if (emitCurrent) listener(this.view());
    return () => this.#listeners.delete(listener);
  }

  view() {
    return Object.freeze({
      phase: this.#phase,
      generation: this.#generation,
      snapshot: this.#snapshot,
      stale: this.#stale,
      error: this.#error,
      authoringLocked: this.isAuthoringLocked(),
    });
  }

  begin() {
    if (this.#phase === "starting") return Object.freeze({ accepted: false, coalesced: true, token: this.#generation });
    if (this.#phase !== "edit") return Object.freeze({ accepted: false, coalesced: false, token: this.#generation });
    this.#generation++;
    this.#snapshot = undefined;
    this.#stale = false;
    this.#error = "";
    this.#setPhase("starting");
    return Object.freeze({ accepted: true, coalesced: false, token: this.#generation });
  }

  capture(token, snapshot) {
    if (!this.is(token, "starting")) return false;
    this.#snapshot = snapshot;
    // Updates included by the synchronization pass are part of this snapshot, not stale drift.
    this.#stale = false;
    this.#emit();
    return true;
  }

  started(token) {
    if (!this.is(token, "starting")) return false;
    this.#setPhase("playing");
    return true;
  }

  paused(token) {
    if (!this.is(token, "playing")) return false;
    this.#setPhase("paused");
    return true;
  }

  resumed(token) {
    if (!this.is(token, "paused")) return false;
    this.#setPhase("playing");
    return true;
  }

  requestStop() {
    if (this.#phase === "edit") return Object.freeze({ accepted: false, token: this.#generation });
    if (this.#phase === "stopping") return Object.freeze({ accepted: false, token: this.#generation });
    this.#setPhase("stopping");
    return Object.freeze({ accepted: true, token: this.#generation });
  }

  fail(token, error) {
    if (token !== this.#generation || this.#phase === "edit" || this.#phase === "stopping") return false;
    this.#error = String(error?.message ?? error ?? "unknown Play error").slice(0, 240);
    this.#setPhase("error");
    return true;
  }

  restoreFailed(error) {
    if (this.#phase !== "stopping" && this.#phase !== "error") return false;
    this.#error = String(error?.message ?? error ?? "Edit restore failed").slice(0, 240);
    this.#setPhase("error");
    return true;
  }

  markStale(cursor) {
    if (!this.isAuthoringLocked() || this.#stale) return false;
    if (this.#snapshot && Number.isSafeInteger(cursor) && cursor <= this.#snapshot.source.cursor) return false;
    this.#stale = true;
    this.#emit();
    return true;
  }

  finishEdit({ error = this.#error } = {}) {
    this.#error = String(error ?? "").slice(0, 240);
    this.#snapshot = undefined;
    this.#stale = false;
    this.#setPhase("edit");
  }

  #setPhase(phase) {
    this.#phase = phase;
    this.#emit();
  }

  #emit() {
    const view = this.view();
    for (const listener of this.#listeners) {
      try { listener(view); }
      catch (error) {
        // Lifecycle mutation is already committed. A broken UI observer must be observable but can
        // never strand Play between phases or prevent the remaining observers from updating.
        if (typeof globalThis.reportError === "function") globalThis.reportError(error);
        else console.error("Play lifecycle listener failed", error);
      }
    }
  }
}

/** One shared async operation whose underlying rejection is never erased. Non-strict callers may
 * observe it as undefined, while a strict caller joining the same in-flight work still rejects. */
export class CoalescedTask {
  #pending;

  run(work, { strict = true, onError } = {}) {
    if (!this.#pending) {
      const core = Promise.resolve().then(work).catch((error) => {
        onError?.(error);
        throw error;
      });
      const tracked = core.finally(() => { if (this.#pending === tracked) this.#pending = undefined; });
      this.#pending = tracked;
    }
    return strict ? this.#pending : this.#pending.catch(() => undefined);
  }

  get pending() { return this.#pending; }
}

/** Retains the exact edit-state recovery payload until the supplied restore operation succeeds. */
export class RetainedEditRestore {
  #saved;

  retain(saved) {
    if (saved === undefined) throw new TypeError("edit restore state is required");
    this.#saved = saved;
  }

  hasPending() { return this.#saved !== undefined; }
  peek() { return this.#saved; }

  async attempt(restore) {
    if (typeof restore !== "function") throw new TypeError("edit restore operation is required");
    const saved = this.#saved;
    if (saved === undefined) return false;
    await restore(saved);
    if (this.#saved === saved) this.#saved = undefined;
    return true;
  }
}

export const playLifecycle = new PlayLifecycleController();

export function assertEditorAuthoringAllowed() {
  if (playLifecycle.isAuthoringLocked()) {
    throw new Error(`editor authoring is read-only while Play is ${playLifecycle.phase}`);
  }
}
