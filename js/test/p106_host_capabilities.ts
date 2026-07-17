// p106_host_capabilities.ts — HOST CAPABILITY GATE: web timers, structuredClone,
// and async WebAssembly.compile on the embedded limina runtime.
//
// SEAM UNDER TEST: crates/limina-render/js/00_bootstrap.js exposes
// setTimeout/setInterval/clearTimeout/clearInterval (deno_core timer wheel) and
// structuredClone (V8 ValueSerializer round-trip) as host globals, and
// crates/limina-runtime enters the tokio context before JsRuntime::new so V8
// background threads can post the wasm-compile completion foreground task.
// These capabilities exist at HOST global scope only — js/src/skills remains
// wall-clock-free (check-determinism.mjs), nothing here touches world state.
//
// FALSIFIABILITY lives in-code: the gate asserts that broken inputs FAIL the
// capability (a string timer callback throws; cloning a function throws; a
// transfer list throws) — a permissive stub implementation cannot pass.

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p106_host_capabilities FAIL: ${message}`);
}

// ── Timers exist as globals ──────────────────────────────────────────────────
assert(typeof setTimeout === "function", "setTimeout global missing");
assert(typeof setInterval === "function", "setInterval global missing");
assert(typeof clearTimeout === "function", "clearTimeout global missing");
assert(typeof clearInterval === "function", "clearInterval global missing");

// ── Fire + extra-args forwarding ─────────────────────────────────────────────
await new Promise<void>((resolve) => {
  setTimeout((a: number, b: string) => {
    assert(a === 7 && b === "x", "setTimeout must forward extra arguments to the callback");
    resolve();
  }, 5, 7, "x");
});

// ── Ordering: shorter delays first, same-delay FIFO, nested timers fire ─────
const order: string[] = [];
await new Promise<void>((resolve) => {
  setTimeout(() => order.push("late"), 40);
  setTimeout(() => order.push("early-first"), 5);
  setTimeout(() => order.push("early-second"), 5);
  setTimeout(() => {
    order.push("nested-parent");
    setTimeout(() => { order.push("nested-child"); resolve(); }, 5);
  }, 60);
});
const expectedOrder = ["early-first", "early-second", "late", "nested-parent", "nested-child"];
assert(
  JSON.stringify(order) === JSON.stringify(expectedOrder),
  `timer ordering wrong: got [${order.join(", ")}], want [${expectedOrder.join(", ")}]`,
);

// ── Cancel: a cleared timeout never fires ────────────────────────────────────
let cancelledFired = false;
const cancelHandle = setTimeout(() => { cancelledFired = true; }, 5);
clearTimeout(cancelHandle);
await new Promise<void>((resolve) => setTimeout(resolve, 30));
assert(!cancelledFired, "cleared timeout must not fire");
// Clearing an unknown/expired handle must be a no-op, not a throw.
clearTimeout(cancelHandle);
clearTimeout(999_999 as unknown as ReturnType<typeof setTimeout>);

// ── Interval: repeats, then clearInterval stops it for good ──────────────────
let ticks = 0;
await new Promise<void>((resolve) => {
  const handle = setInterval(() => {
    ticks += 1;
    if (ticks === 3) { clearInterval(handle); resolve(); }
  }, 5);
});
await new Promise<void>((resolve) => setTimeout(resolve, 40));
assert(ticks === 3, `cleared interval kept firing: ${ticks} ticks after stop at 3`);

// ── Falsifiability: eval-by-string timer callbacks are forbidden ────────────
let stringCallbackThrew = false;
try {
  (setTimeout as unknown as (cb: string, ms: number) => number)("1 + 1", 1);
} catch {
  stringCallbackThrew = true;
}
assert(stringCallbackThrew, "string timer callbacks must throw, not be silently accepted");

// ── structuredClone: types, aliasing, circularity, independence ─────────────
assert(typeof structuredClone === "function", "structuredClone global missing");

interface CloneSource {
  list: number[];
  map: Map<string, number[]>;
  set: Set<string>;
  date: Date;
  regex: RegExp;
  bytes: Uint8Array;
  floats: Float64Array;
  raw: ArrayBuffer;
  twin?: number[];
  cycle?: CloneSource;
}
const source: CloneSource = {
  list: [1, 2, 3],
  map: new Map([["k", [4, 5]]]),
  set: new Set(["a", "b"]),
  date: new Date(1_234_567),
  regex: /pat[t]ern/gi,
  bytes: new Uint8Array([9, 8, 7]),
  floats: new Float64Array([1.5, -2.25]),
  raw: new Uint8Array([42]).buffer,
};
source.twin = source.list; // internal aliasing must survive the clone
source.cycle = source; // circular reference must survive the clone

const clone = structuredClone(source);
assert(clone !== source, "clone must be a distinct object");
assert(clone.cycle === clone, "circular reference must point at the CLONE, not the source");
assert(clone.twin === clone.list, "internal aliasing must be preserved as one shared clone");
assert(clone.map instanceof Map && clone.map.get("k")?.[1] === 5, "Map must clone with contents");
assert(clone.map.get("k") !== source.map.get("k"), "Map values must be deep-cloned");
assert(clone.set instanceof Set && clone.set.has("a") && clone.set.has("b") && clone.set.size === 2, "Set must clone with contents");
assert(clone.date instanceof Date && clone.date.getTime() === 1_234_567, "Date must clone by value");
assert(clone.regex instanceof RegExp && clone.regex.source === source.regex.source && clone.regex.flags === "gi", "RegExp must clone source+flags");
assert(clone.bytes instanceof Uint8Array && clone.bytes[0] === 9 && clone.bytes.length === 3, "Uint8Array must clone");
assert(clone.bytes.buffer !== source.bytes.buffer, "TypedArray backing buffer must be copied, not shared");
assert(clone.floats instanceof Float64Array && clone.floats[1] === -2.25, "Float64Array must clone");
assert(clone.raw instanceof ArrayBuffer && new Uint8Array(clone.raw)[0] === 42, "ArrayBuffer must clone by copy");

clone.list.push(99);
clone.bytes[0] = 0;
assert(source.list.length === 3 && source.bytes[0] === 9, "mutating the clone must not touch the source");

// ── Falsifiability: unsupported types and transfer lists must THROW ─────────
let functionCloneThrew = false;
try {
  structuredClone({ fn: () => 1 });
} catch {
  functionCloneThrew = true;
}
assert(functionCloneThrew, "cloning a function must throw, not return a lossy copy");

let transferThrew = false;
try {
  structuredClone(source.raw, { transfer: [source.raw] });
} catch {
  transferThrew = true;
}
assert(transferThrew, "transfer lists are unsupported on this host and must throw loudly");

// ── Async WebAssembly.compile resolves on the host event loop ───────────────
// Smallest valid module: just the `\0asm` magic + version header. Exercises the
// V8 background-compile -> platform foreground-task -> promise-resolve path.
const wasmModule = await WebAssembly.compile(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
);
assert(wasmModule instanceof WebAssembly.Module, "async WebAssembly.compile must resolve with a Module");

console.log(
  "p106_host_capabilities OK: timers (fire/args/order/cancel/interval), structuredClone " +
  "(Map/Set/Date/RegExp/TypedArray/ArrayBuffer/alias/cycle + throw-on-function/transfer), async WebAssembly.compile",
);
