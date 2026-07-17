import { ops } from "../src/engine.ts";

const source = new TextDecoder().decode(ops.op_read_asset("runtime/basis/basis_transcoder.js"));
const wasmBinary = ops.op_read_asset("runtime/basis/basis_transcoder.wasm").slice().buffer;
const factory = Function(`${source}\nreturn BASIS;`)() as (options: { wasmBinary: ArrayBuffer; onRuntimeInitialized(): void }) => unknown;
const startedAt = performance.now();
await new Promise<void>((resolve) => factory({ wasmBinary, onRuntimeInitialized: resolve }));
console.log(`p_native_basis_init OK: ${Number((performance.now() - startedAt).toFixed(1))}ms`);
