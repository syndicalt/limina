import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export class WorldCompilerWorkerError extends Error {
  constructor(message, { name = "WorldCompilerWorkerError", code, stack, cause } = {}) {
    super(message, { cause });
    this.name = name;
    this.code = code;
    if (typeof stack === "string") this.stack = stack;
  }
}

function transferList(output) {
  const buffers = new Set();
  for (const artifact of output?.artifacts ?? []) {
    if (artifact?.bytes instanceof Uint8Array && artifact.bytes.buffer instanceof ArrayBuffer) buffers.add(artifact.bytes.buffer);
  }
  return [...buffers];
}

async function runWorker() {
  const flag = new Int32Array(workerData.cancelBuffer);
  try {
    const compiler = await import(pathToFileURL(workerData.bundlePath).href);
    const output = compiler.compileWorldTerrain({
      ...workerData.input,
      cancellation: { shouldCancel: () => Atomics.load(flag, 0) !== 0 },
    });
    parentPort.postMessage({ ok: true, output }, transferList(output));
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        code: error?.code,
      },
    });
  }
}

if (!isMainThread) await runWorker();

/** Run one pure terrain compile off-thread; AbortSignal updates a shared cancellation word. */
export function compileWorldTerrainInWorker({ bundlePath, input, signal }) {
  if (typeof bundlePath !== "string" || bundlePath.length === 0 || input === null || typeof input !== "object") {
    return Promise.reject(new WorldCompilerWorkerError("world compiler worker options are invalid"));
  }
  if (!signal || typeof signal.addEventListener !== "function") {
    return Promise.reject(new WorldCompilerWorkerError("world compiler worker requires an AbortSignal"));
  }
  if (signal.aborted) return Promise.reject(signal.reason ?? new WorldCompilerWorkerError("world compiler worker was cancelled"));
  const { cancellation: _cancellation, ...cloneableInput } = input;
  const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const flag = new Int32Array(cancelBuffer);
  return new Promise((resolveCompile, rejectCompile) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { bundlePath: resolve(bundlePath), input: cloneableInput, cancelBuffer },
    });
    let settled = false;
    const cancel = () => {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    };
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      void worker.terminate();
      if (error !== undefined) rejectCompile(error);
      else resolveCompile(output);
    };
    signal.addEventListener("abort", cancel, { once: true });
    worker.once("message", (message) => {
      if (message?.ok === true) finish(undefined, message.output);
      else finish(new WorldCompilerWorkerError(message?.error?.message ?? "world compiler worker failed", message?.error ?? {}));
    });
    worker.once("error", (error) => finish(new WorldCompilerWorkerError("world compiler worker crashed", { cause: error })));
    worker.once("exit", (code) => {
      if (!settled) finish(new WorldCompilerWorkerError(`world compiler worker exited before returning output (exit ${code})`));
    });
  });
}
