// Phase 8 Mode-B — M5: the SIM-WORKER ENTRY module.
//
// This is the script a real dedicated Worker loads:
//     new Worker(new URL("./sim-worker-entry.js", import.meta.url), { type: "module" })
// It is bundled as its OWN browser chunk (npm run bundle:worker / bundle:live) so
// the worker URL resolves to a sibling of the main runtime bundle.
//
// It does exactly two things:
//   1. statically import rapier3d-compat so the bundler carries the wasm-bearing
//      module INTO this worker chunk (SimWorkerController.create dynamically
//      imports the same specifier at `init`, resolving to the bundled copy);
//   2. install the M3 Worker shell on this worker's global scope.
//
// The shell (installSimWorker) wires self.onmessage ⇄ SimWorkerController:
//   • `init` → bring up wasm-Rapier, allocate the transform/input/status SABs,
//     author the supplied command log, reply `ready` with the buffers, then
//     self-drive the authoritative fixed-step loop at 60 Hz (Atomics tick counter);
//   • `step`/`stop` → manual drive / shutdown.
//
// Nothing else belongs here — keep the entry a one-liner over the verified M1–M3
// composition so the browser-UAT surface stays minimal.

import * as RAPIER from "@dimforge/rapier3d-compat";
import { installSimWorker } from "./sim-worker.ts";

// Reference the namespace so the bundler keeps the (wasm-carrying) rapier module in
// this worker chunk; SimWorkerController.create await-imports the same specifier.
void RAPIER;

// Install the M3 shell on the worker global — but ONLY inside a real dedicated
// Worker (WorkerGlobalScope present AND `self` is an instance of it). This keeps
// the entry side-effect-free at plain import / in the portability eval (where
// `self` may be undefined), so nothing runs in a non-worker context. (sim-worker.ts
// carries the same guarded auto-install; the explicit call here is the documented
// contract for what `new Worker(url, {type:"module"})` loads — last writer wins,
// a single active handler.)
declare const WorkerGlobalScope: (new () => unknown) | undefined;
if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  (self as unknown) instanceof (WorkerGlobalScope as unknown as new () => unknown)
) {
  installSimWorker(self as unknown as Parameters<typeof installSimWorker>[0]);
}
