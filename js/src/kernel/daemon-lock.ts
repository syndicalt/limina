// KERNEL K3 -- daemon reuse. One kernel per project: opening a second surface
// (another `npm run editor`, the CLI attaching, a board) must ATTACH to the
// already-running kernel instead of spawning a second authoritative server on a
// second workspace. The user hit the inverse ("every time I start editor_host I
// get a new workspace"); K2 made a single restart RESUME the same durable log,
// and this makes a CONCURRENT second start ATTACH rather than double-spawn.
//
// LIVENESS PRIMITIVE: the runtime exposes no pid/kill/flock op, but binding a TCP
// port fails cleanly when it is already held (verified: op_net_listen on a taken
// port throws). So the kernel PORT itself is the lock: whoever binds it owns the
// kernel; anyone who cannot bind it knows a kernel is live and reads the lock
// record (a per-project trace file) for the port + capability token to attach.
//
// This module is the PURE state machine over three injected primitives so it is
// unit-gateable without real sockets or a second process:
//   listen(port)  -> a handle if we bound it, or throws if the port is held
//   lock.read()   -> the current lock record text, or null if absent
//   lock.write(s) -> replace the lock record
// editor_host injects op_net_listen + op_read_trace/op_write_trace.

export const KERNEL_LOCK_VERSION = 1 as const;

export interface KernelLockRecord {
  version: typeof KERNEL_LOCK_VERSION;
  /** The ws port a surface connects to. */
  port: number;
  /** The capability token a surface presents in `initialize` (127.0.0.1 only). */
  token: string;
  /** The durable world log this kernel owns (its workspace identity). */
  worldlog: string;
}

export interface LockIO {
  /** Current lock record text, or null when no lock file exists yet. */
  read(): string | null;
  /** Atomically replace the lock record text. */
  write(text: string): void;
}

export interface AcquireKernelOptions {
  port: number;
  token: string;
  worldlog: string;
  lock: LockIO;
  /** Bind the port; return an opaque handle on success, THROW when it is held.
   *  May be sync or async (the real op_net_listen returns a Promise). */
  listen(port: number): unknown | Promise<unknown>;
}

export type AcquireKernelResult =
  | {
      /** We bound the port: we ARE the kernel. Stand up the authoritative server. */
      role: "spawned";
      handle: unknown;
      record: KernelLockRecord;
      /** True when we reclaimed a stale lock left by a crashed prior daemon. */
      reclaimedStaleLock: boolean;
    }
  | {
      /** A kernel is already live: attach a client to it, do NOT spawn a server. */
      role: "attached";
      record: KernelLockRecord;
    };

export function serializeKernelLock(record: KernelLockRecord): string {
  return JSON.stringify(record);
}

export function parseKernelLock(text: string): KernelLockRecord {
  const raw = JSON.parse(text) as Partial<KernelLockRecord>;
  if (raw.version !== KERNEL_LOCK_VERSION) {
    throw new Error(`kernel lock: unsupported version ${String(raw.version)} (expected ${KERNEL_LOCK_VERSION})`);
  }
  if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port <= 0) {
    throw new Error(`kernel lock: invalid port ${String(raw.port)}`);
  }
  if (typeof raw.token !== "string" || raw.token.length === 0) {
    throw new Error("kernel lock: missing token");
  }
  if (typeof raw.worldlog !== "string" || raw.worldlog.length === 0) {
    throw new Error("kernel lock: missing worldlog");
  }
  return { version: KERNEL_LOCK_VERSION, port: raw.port, token: raw.token, worldlog: raw.worldlog };
}

/**
 * Decide whether this process spawns the kernel or attaches to a running one.
 *
 *   - port free           -> SPAWN. We bound it; write our lock record. If a lock
 *                            file was present it was STALE (a crashed daemon that
 *                            never released the port) -> reclaim + overwrite it.
 *   - port held + lock     -> ATTACH. Return the live kernel's port + token so the
 *                            caller connects a client instead of double-spawning.
 *   - port held + no lock  -> ERROR. Something else holds our port but it is not
 *                            our kernel; refuse rather than silently misbehave.
 */
export async function acquireKernel(opts: AcquireKernelOptions): Promise<AcquireKernelResult> {
  const { port, token, worldlog, lock, listen } = opts;
  const priorText = lock.read();

  let handle: unknown;
  try {
    handle = await listen(port);
  } catch {
    // Port is held: a kernel (or something) is already on it.
    if (priorText === null) {
      throw new Error(
        `kernel: port ${port} is already in use but no kernel lock record was found -- ` +
          `refusing to attach to an unknown process. Free the port or remove the stale lock.`,
      );
    }
    const record = parseKernelLock(priorText);
    if (record.port !== port) {
      throw new Error(
        `kernel: lock record port ${record.port} does not match the port in use ${port} -- stale or foreign lock`,
      );
    }
    return { role: "attached", record };
  }

  // We own the port. Any pre-existing lock file was left by a dead daemon.
  const record: KernelLockRecord = { version: KERNEL_LOCK_VERSION, port, token, worldlog };
  lock.write(serializeKernelLock(record));
  return { role: "spawned", handle, record, reclaimedStaleLock: priorText !== null };
}
