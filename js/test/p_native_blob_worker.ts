function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_native_blob_worker FAIL: ${message}`);
}

const source = `self.addEventListener("message", (event) => self.postMessage({ value: event.data.value * 3 }));`;
const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const worker = new Worker(url);
const result = await new Promise<{ value: number }>((resolve, reject) => {
  worker.addEventListener("message", (event) => resolve(event.data));
  worker.addEventListener("error", (event) => reject(event.error ?? new Error(event.message)));
  worker.postMessage({ value: 14 });
});
assert(result.value === 42, `ordered blob worker returned ${JSON.stringify(result)}`);
worker.terminate();
URL.revokeObjectURL(url);
let rejected = false;
try { new Worker("https://example.invalid/worker.js"); } catch { rejected = true; }
assert(rejected, "external worker URL was accepted");
console.log("p_native_blob_worker OK: local ordered messages work and external workers fail closed");
