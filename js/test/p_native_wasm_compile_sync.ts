import { ops } from "../src/engine.ts";

const bytes = ops.op_read_asset("runtime/basis/basis_transcoder.wasm");
const startedAt = performance.now();
const module = new WebAssembly.Module(bytes);
if (!(module instanceof WebAssembly.Module)) throw new Error("p_native_wasm_compile_sync FAIL: compile returned no module");
console.log(`p_native_wasm_compile_sync OK: ${bytes.byteLength} bytes in ${Number((performance.now() - startedAt).toFixed(1))}ms`);
