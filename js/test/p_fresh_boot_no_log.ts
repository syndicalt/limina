// p_fresh_boot_no_log -- KERNEL K2 robustness: a BRAND-NEW project has no durable
// world-log file yet (the create-limina-app / first-editor-boot case). The runtime
// op_read_trace THROWS on a missing file, so the constructor's durable-log read must
// treat "file absent" as "empty log" -> a fresh open(), never a boot crash.
//
// Regression guard: before this fix, editor_host only ever booted because a log file
// already existed on disk; deleting it (a true fresh checkout) crashed boot with
// "Uncaught (in promise) undefined" the moment the AuthoritativeServer constructor
// read the missing trace.

import { spawnRenderable } from "../src/ecs/world.ts";
import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_fresh_boot_no_log: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

class SilentTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async close(_connId: number): Promise<void> {}
  async send(_connId: number, _line: string): Promise<void> {}
}

// A worldLog name that is guaranteed NOT to exist on disk (unique-ish, never written).
const MISSING_LOG = "p_fresh_boot_definitely_absent_9271.jsonl";

let built = false;
let server: AuthoritativeServer | undefined;
try {
  server = new AuthoritativeServer(new SilentTransport(), {
    sessionId: "p_fresh_boot_no_log",
    seed: 1,
    tickMs: 1000,
    worldLog: { name: MISSING_LOG, compactFlushed: false },
    bootstrap: ({ world }: { world: WorldContext }) => {
      spawnRenderable(world.ecs, STUB, 0, 0, 0);
    },
  });
  built = true;
} catch (e) {
  throw new Error(
    "p_fresh_boot_no_log: constructing with a MISSING world-log must NOT throw (fresh project boot), but threw: " +
      (e instanceof Error ? e.message : String(e)),
  );
}

assert(built && server !== undefined, "server must construct on a missing log");
// A missing log is an empty log: nothing to rehydrate.
const info = server as unknown as { rehydrated: boolean; ready: Promise<unknown> };
assert(info.rehydrated === false, "a missing/empty log must NOT enter the rehydrate path");
// The deferred boot promise must resolve cleanly (fresh open()), not reject.
await info.ready;

ops.op_log(
  "[js] p_fresh_boot_no_log OK: a brand-new project with NO durable world-log file boots FRESH " +
    "(missing file reads as empty -> open(), rehydrated=false, ready resolves) instead of crashing (K2 robustness).",
);
