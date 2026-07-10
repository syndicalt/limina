import { RENDER_TELEMETRY_CAPACITY, RenderTelemetryRing } from "../src/render/telemetry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_render_telemetry FAIL: ${message}`);
}

const ring = new RenderTelemetryRing();
assert(ring.capacity === 240 && ring.size === 0, "ring capacity or initial size changed");
const empty = ring.snapshot();
assert(empty.samples === 0 && empty.frameMs.mean === 0 && empty.fps.mean === 0, "empty snapshot is not stable");

for (let index = 0; index < RENDER_TELEMETRY_CAPACITY + 10; index++) {
  const frameMs = index < 10 ? 1000 : 10 + (index % 20);
  ring.record(frameMs, frameMs / 4, {
    render: { calls: index, triangles: index * 1000 },
    memory: { textures: 3, geometries: 4, renderTargets: 5, total: 6 },
    programs: { length: 7 },
  }, 1280 + index, 720, 1.5, "balanced");
}
const snapshot = ring.snapshot();
assert(snapshot.samples === RENDER_TELEMETRY_CAPACITY && ring.size === RENDER_TELEMETRY_CAPACITY, "ring did not overwrite at its fixed capacity");
assert(snapshot.frameMs.maximum < 1000, "overwritten warmup samples leaked into the retained window");
assert(snapshot.frameMs.p95 >= snapshot.frameMs.p50 && snapshot.frameMs.maximum >= snapshot.frameMs.p95, "frame percentiles are unordered");
assert(snapshot.submitMs.p95 > 0 && snapshot.fps.minimum === 1000 / snapshot.frameMs.maximum, "submit/FPS statistics changed");
assert(snapshot.render.drawCalls === RENDER_TELEMETRY_CAPACITY + 9 && snapshot.render.triangles === (RENDER_TELEMETRY_CAPACITY + 9) * 1000, "latest render counters changed");
assert(snapshot.memory.textures === 3 && snapshot.memory.geometries === 4 && snapshot.memory.programs === 7 && snapshot.memory.renderTargets === 5, "latest memory counters changed");
assert(snapshot.backingWidth === 1280 + RENDER_TELEMETRY_CAPACITY + 9 && snapshot.backingHeight === 720 && snapshot.pixelRatio === 1.5, "latest surface identity changed");
assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.frameMs) && Object.isFrozen(snapshot.memory), "telemetry snapshot is mutable");

ring.clear();
ring.record(Number.NaN, -1, { render: { calls: Number.POSITIVE_INFINITY, triangles: -5 }, memory: { textures: -1 } }, -4, Number.NaN, Number.POSITIVE_INFINITY, "cinematic");
const sanitized = ring.snapshot();
assert(sanitized.samples === 1 && sanitized.frameMs.mean === 0 && sanitized.submitMs.mean === 0, "invalid timing did not sanitize without breaking render");
assert(sanitized.render.drawCalls === 0 && sanitized.render.triangles === 0 && sanitized.backingWidth === 0, "invalid counters did not sanitize");
assert(sanitized.tier === "cinematic", "tier identity was not retained");

console.log("p_render_telemetry OK: fixed 240-frame storage, overwrite order, percentile snapshots, and non-throwing sanitization");
