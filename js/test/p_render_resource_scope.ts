import { RenderResourceDisposalError, RenderResourceScope } from "../src/render/resource-scope.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_render_resource_scope FAIL: ${message}`);
}

const order: string[] = [];
const reported: string[] = [];
const scope = new RenderResourceScope({ maxReportedErrors: 2, onError: (error) => reported.push(String((error as Error).message)) });
const first = { dispose: () => { order.push("first"); } };
const second = { dispose: async () => { order.push("second"); } };
scope.own(first);
scope.own(second);
scope.own(first);
scope.defer(() => { order.push("third"); throw new Error("third failed"); });
scope.defer(() => { order.push("fourth"); throw new Error("fourth failed"); });
scope.defer(() => { order.push("fifth"); throw new Error("fifth failed"); });
assert(scope.size === 5, "resource identity was not deduplicated");

const disposeA = scope.dispose();
const disposeB = scope.dispose();
assert(disposeA === disposeB, "concurrent/repeated disposal did not coalesce");
let caught: unknown;
try { await disposeA; } catch (error) { caught = error; }
assert(caught instanceof RenderResourceDisposalError, "cleanup failures were not aggregated after continuing disposal");
assert(caught.failures.length === 2 && caught.omittedFailures === 1, "cleanup diagnostics were not bounded");
assert(reported.length === 3, "every cleanup failure was not reported");
assert(order.join(",") === "fifth,fourth,third,second,first", `cleanup was not LIFO: ${order.join(",")}`);
assert(scope.disposed && scope.size === 0, "disposed scope retained resources");
let ownAfterDispose = false;
try { scope.own({ dispose() {} }); } catch { ownAfterDispose = true; }
assert(ownAfterDispose, "disposed scope accepted new ownership");
await scope.dispose().catch(() => undefined);
assert(order.length === 5, "repeated disposal ran cleanup twice");

let badOptions = false;
try { new RenderResourceScope({ maxReportedErrors: 0 }); } catch { badOptions = true; }
assert(badOptions, "invalid diagnostic bound was accepted");

console.log("p_render_resource_scope OK: identity dedupe, async LIFO cleanup, bounded aggregation, and idempotence");
