// p_daemon_lock -- KERNEL K3: daemon-reuse state machine. One kernel per project;
// a concurrent second surface ATTACHES to the running kernel (same port + token)
// instead of double-spawning a second authoritative server on a new workspace.
//
// The liveness lock is the kernel PORT (binding a held port throws). This gate
// drives the pure acquireKernel() over injected primitives so every branch is
// exercised deterministically without real sockets or a second process:
//   1. fresh:            port free, no lock         -> SPAWN + lock written
//   2. concurrent start: port held, lock present    -> ATTACH (same port/token)
//   3. stale lock:       port free, lock present     -> SPAWN + reclaim/overwrite
//   4. foreign holder:   port held, no lock          -> ERROR (refuse to attach)
//   5. serialize/parse round-trips + version/field validation.

import { ops } from "../src/engine.ts";
import {
  acquireKernel,
  KERNEL_LOCK_VERSION,
  parseKernelLock,
  serializeKernelLock,
  type KernelLockRecord,
  type LockIO,
} from "../src/kernel/daemon-lock.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_daemon_lock: " + message);
}

// An in-memory lock file + a controllable "port held?" flag stand in for the real
// op_write_trace/op_read_trace and op_net_listen editor_host injects.
function makeLock(initial: string | null = null): { io: LockIO; get(): string | null } {
  let text = initial;
  return {
    io: { read: () => text, write: (s: string) => { text = s; } },
    get: () => text,
  };
}
const PORT = 8787;
const TOKEN = "cap-token-abc";
const WORLDLOG = "project_worldlog.jsonl";
const listenOk = (p: number) => ({ listener: p }); // bound successfully
const listenHeld = (_p: number): never => { throw new Error("invalid_argument"); }; // port in use

// 1. FRESH: port free, no prior lock -> we spawn the kernel and write the lock.
{
  const lock = makeLock(null);
  const r = await acquireKernel({ port: PORT, token: TOKEN, worldlog: WORLDLOG, lock: lock.io, listen: listenOk });
  assert(r.role === "spawned", "fresh boot must SPAWN the kernel");
  assert(r.role === "spawned" && r.reclaimedStaleLock === false, "fresh boot did not reclaim any stale lock");
  assert(lock.get() !== null, "spawn must persist a lock record");
  const persisted = parseKernelLock(lock.get()!);
  assert(persisted.port === PORT && persisted.token === TOKEN && persisted.worldlog === WORLDLOG,
    "persisted lock must carry the live port, token, and workspace");
}

// 2. CONCURRENT START: a kernel is already live (port held) and its lock is on
//    disk -> we ATTACH with the live kernel's port + token, never double-spawn.
{
  const liveRecord: KernelLockRecord = { version: KERNEL_LOCK_VERSION, port: PORT, token: TOKEN, worldlog: WORLDLOG };
  const lock = makeLock(serializeKernelLock(liveRecord));
  const r = await acquireKernel({ port: PORT, token: "a-different-token", worldlog: "other.jsonl", lock: lock.io, listen: listenHeld });
  assert(r.role === "attached", "a second concurrent start must ATTACH, not spawn");
  assert(r.record.port === PORT, "attach must reuse the LIVE kernel's port");
  assert(r.record.token === TOKEN, "attach must reuse the LIVE kernel's capability token (not our own)");
  assert(r.record.worldlog === WORLDLOG, "attach must reuse the LIVE kernel's workspace, not mint a new one");
  assert(lock.get() === serializeKernelLock(liveRecord), "attach must NOT rewrite the live kernel's lock");
}

// 3. STALE LOCK: a crashed daemon left a lock file but released the port -> we can
//    bind, so we SPAWN and reclaim/overwrite the stale record with ours.
{
  const staleRecord: KernelLockRecord = { version: KERNEL_LOCK_VERSION, port: PORT, token: "dead-token", worldlog: WORLDLOG };
  const lock = makeLock(serializeKernelLock(staleRecord));
  const r = await acquireKernel({ port: PORT, token: TOKEN, worldlog: WORLDLOG, lock: lock.io, listen: listenOk });
  assert(r.role === "spawned", "a free port with a stale lock must SPAWN (reclaim)");
  assert(r.role === "spawned" && r.reclaimedStaleLock === true, "reclaim must be flagged");
  assert(parseKernelLock(lock.get()!).token === TOKEN, "reclaim must overwrite the stale token with ours");
}

// 4. FOREIGN HOLDER: port held but NO lock record -> refuse to attach to an
//    unknown process rather than guess a token.
{
  const lock = makeLock(null);
  let threw = false;
  try {
    await acquireKernel({ port: PORT, token: TOKEN, worldlog: WORLDLOG, lock: lock.io, listen: listenHeld });
  } catch (e) {
    threw = true;
    assert(String(e).includes("no kernel lock"), "foreign-holder error must explain the missing lock");
  }
  assert(threw, "a held port with no lock must ERROR, not silently attach");
}

// 5. serialize/parse round-trip + validation.
{
  const rec: KernelLockRecord = { version: KERNEL_LOCK_VERSION, port: 9000, token: "t", worldlog: "w.jsonl" };
  assert(JSON.stringify(parseKernelLock(serializeKernelLock(rec))) === JSON.stringify(rec), "lock round-trip must be stable");
  for (const bad of ['{"version":2,"port":1,"token":"t","worldlog":"w"}', '{"version":1,"port":0,"token":"t","worldlog":"w"}',
    '{"version":1,"port":1,"token":"","worldlog":"w"}', '{"version":1,"port":1,"token":"t","worldlog":""}']) {
    let rejected = false;
    try { parseKernelLock(bad); } catch { rejected = true; }
    assert(rejected, `invalid lock must be rejected: ${bad}`);
  }
}

ops.op_log(
  "[js] p_daemon_lock OK: one kernel per project -- fresh boot spawns + locks; a concurrent second " +
    "start attaches to the live port+token (no double-spawn, no new workspace); a stale lock is reclaimed; " +
    "a foreign port holder is refused; lock records round-trip and validate (K3 daemon reuse).",
);
