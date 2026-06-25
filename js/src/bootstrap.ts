// limina JS entry point (Phase 0).
//
// Loaded and transpiled by the Rust host's TypescriptModuleLoader, then
// evaluated on the V8 isolate. For now it only exercises the op bridge; later
// milestones acquire the GPU surface, build the renderer, and register the
// per-frame callbacks here.

// Minimal typed view of the deno_core op surface limina exposes to JS.
interface LiminaOps {
  op_log(msg: string): void;
}

declare const Deno: { core: { ops: LiminaOps } };

const { op_log } = Deno.core.ops;

op_log("bootstrap.ts evaluated on the limina runtime");
op_log(`Date.now() = ${Date.now()}`);

// Prove async microtasks advance when the host pumps the event loop.
queueMicrotask(() => op_log("microtask drained"));
await Promise.resolve();
op_log("top-level await resumed");
