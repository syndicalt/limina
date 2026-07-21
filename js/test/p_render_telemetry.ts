import {
  RENDER_SUBMISSION_TELEMETRY_SCHEMA,
  RENDER_TELEMETRY_CAPACITY,
  RenderTelemetryRing,
  captureRenderResourceTelemetry,
  captureRenderSubmissionTelemetry,
  requirePairedRenderSubmissionTelemetry,
  requireSubjectPairedRenderSubmissionTelemetry,
  requireWholeFrameRenderSubmissionTelemetry,
} from "../src/render/telemetry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_render_telemetry FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const submitted = captureRenderSubmissionTelemetry({
  frame: 19,
  render: { frameCalls: 7, drawCalls: 83, triangles: 5_412_345 },
});
assert(submitted.schema === RENDER_SUBMISSION_TELEMETRY_SCHEMA
  && submitted.frameId === 19 && submitted.renderCalls === 7 && submitted.drawCalls === 83 && submitted.triangles === 5_412_345,
"strict submission snapshot changed counters");
assert(Object.isFrozen(submitted) && submitted.source === "three-webgpu-renderer-info"
  && submitted.scope === "single-production-frame-all-passes" && submitted.instanceAccounting === "full-draw-instance-count",
"strict submission snapshot lost identity, instance semantics, or immutability");
assert(requireWholeFrameRenderSubmissionTelemetry(submitted) === submitted,
  "whole-frame guard replaced valid immutable evidence");
const resources = captureRenderResourceTelemetry({ memory: {
  textures: 3, geometries: 4, programs: 5, renderTargets: 6, total: 700,
  texturesSize: 100, attributesSize: 110, indexAttributesSize: 120, storageAttributesSize: 130,
  indirectStorageAttributesSize: 140, readbackBuffersSize: 50, programsSize: 50,
} });
assert(resources.bytes.total === 700 && resources.counts.programs === 5 && resources.bytes.storageAttributes === 130,
  "strict resource snapshot changed tracked Three counters");
assert(Object.isFrozen(resources) && Object.isFrozen(resources.counts) && Object.isFrozen(resources.bytes),
  "strict resource snapshot is mutable");
rejects(() => captureRenderResourceTelemetry({ memory: { textures: 1, geometries: 1, programs: 1, renderTargets: 1,
  total: -1, texturesSize: 0, attributesSize: 0, indexAttributesSize: 0, storageAttributesSize: 0,
  indirectStorageAttributesSize: 0, readbackBuffersSize: 0, programsSize: 0 } }), /total bytes/,
"negative renderer resource bytes were accepted");
rejects(() => requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry({
  frame: 20,
  render: { frameCalls: 1, drawCalls: 1, triangles: 1 },
})), /whole production frame/, "known final-fullscreen-pass-only telemetry was accepted");
rejects(() => captureRenderSubmissionTelemetry({ frame: 1, render: { frameCalls: 1, drawCalls: 1, triangles: -1 } }),
  /triangles/, "negative submitted triangles were accepted");
rejects(() => captureRenderSubmissionTelemetry({ frame: 1, render: { frameCalls: 1, drawCalls: Number.NaN, triangles: 1 } }),
  /drawCalls/, "non-finite submitted draw calls were accepted");
rejects(() => captureRenderSubmissionTelemetry({ frame: 1, render: { frameCalls: 1.5, drawCalls: 1, triangles: 1 } }),
  /renderCalls/, "fractional submitted render calls were accepted");
rejects(() => captureRenderSubmissionTelemetry({ render: { frameCalls: 1, drawCalls: 1, triangles: 1 } }),
  /frameId/, "submission without an explicit Three frame identity was accepted");
const paired = requirePairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 30, render: { frameCalls: 16, drawCalls: 240, triangles: 65_000_000 } }),
  captureRenderSubmissionTelemetry({ frame: 31, render: { frameCalls: 16, drawCalls: 550, triangles: 72_500_000 } }), 16);
assert(paired.delta.renderCalls === 0 && paired.delta.drawCalls === 310 && paired.delta.triangles === 7_500_000,
  "paired submission delta changed");
assert(Object.isFrozen(paired) && Object.isFrozen(paired.delta), "paired submission evidence is mutable");
const shadowSubject = requireSubjectPairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 31, render: { frameCalls: 3, drawCalls: 565, triangles: 11_413 } }),
  captureRenderSubmissionTelemetry({ frame: 32, render: { frameCalls: 9, drawCalls: 574, triangles: 12_241 } }));
assert(shadowSubject.delta.renderCalls === 6 && shadowSubject.delta.drawCalls === 9
  && shadowSubject.delta.triangles === 828, "shadow-owning subject telemetry changed observed cost");
const unlitSubject = requireSubjectPairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 33, render: { frameCalls: 3, drawCalls: 565, triangles: 11_413 } }),
  captureRenderSubmissionTelemetry({ frame: 34, render: { frameCalls: 3, drawCalls: 574, triangles: 12_241 } }));
assert(unlitSubject.delta.renderCalls === 0 && unlitSubject.delta.drawCalls === 9,
  "unlit subject telemetry did not preserve the production pass scope");
const directPaired = requirePairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 32, render: { frameCalls: 7, drawCalls: 14, triangles: 1400 } }),
  captureRenderSubmissionTelemetry({ frame: 33, render: { frameCalls: 7, drawCalls: 18, triangles: 1800 } }));
assert(directPaired.delta.drawCalls === 4 && directPaired.delta.triangles === 400,
  "direct-render paired submission did not preserve its observed render-call scope");
rejects(() => requirePairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 34, render: { frameCalls: 7, drawCalls: 14, triangles: 1400 } }),
  captureRenderSubmissionTelemetry({ frame: 35, render: { frameCalls: 8, drawCalls: 18, triangles: 1800 } })),
/render-call scope/, "direct-render paired submission accepted a changed render-call scope");
rejects(() => requirePairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 40, render: { frameCalls: 16, drawCalls: 300, triangles: 1000 } }),
  captureRenderSubmissionTelemetry({ frame: 42, render: { frameCalls: 16, drawCalls: 301, triangles: 1001 } }), 16),
/not adjacent/, "non-adjacent paired frames were accepted");
rejects(() => requirePairedRenderSubmissionTelemetry(
  captureRenderSubmissionTelemetry({ frame: 50, render: { frameCalls: 16, drawCalls: 300, triangles: 1000 } }),
  captureRenderSubmissionTelemetry({ frame: 51, render: { frameCalls: 16, drawCalls: 299, triangles: 999 } }), 16),
/regressed below/, "negative paired subject cost was accepted");

const ring = new RenderTelemetryRing();
assert(ring.capacity === 240 && ring.size === 0, "ring capacity or initial size changed");
const empty = ring.snapshot();
assert(empty.samples === 0 && empty.frameMs.mean === 0 && empty.fps.mean === 0, "empty snapshot is not stable");

for (let index = 0; index < RENDER_TELEMETRY_CAPACITY + 10; index++) {
  const frameMs = index < 10 ? 1000 : 10 + (index % 20);
  ring.record(frameMs, frameMs / 4, {
    render: { drawCalls: index, triangles: index * 1000 },
    memory: { textures: 3, geometries: 4, renderTargets: 5, total: 6 },
    programs: { length: 7 },
  }, 1280 + index, 720, 1.5, "balanced");
}
const snapshot = ring.snapshot();
assert(snapshot.samples === RENDER_TELEMETRY_CAPACITY && ring.size === RENDER_TELEMETRY_CAPACITY, "ring did not overwrite at its fixed capacity");
assert(snapshot.frameMs.maximum < 1000, "overwritten warmup samples leaked into the retained window");
assert(snapshot.frameMs.p95 >= snapshot.frameMs.p50 && snapshot.frameMs.maximum >= snapshot.frameMs.p95, "frame percentiles are unordered");
assert(snapshot.submitMs.p95 > 0 && snapshot.fps.minimum === 1000 / snapshot.frameMs.maximum, "submit/FPS statistics changed");
assert(snapshot.fps.p05 === 1000 / snapshot.frameMs.p95 && snapshot.fps.p05 <= snapshot.fps.p50
  && !("p95" in snapshot.fps), "low-end fps is not the inverted high-frame-time percentile under its honest key");
assert(snapshot.render.drawCalls === RENDER_TELEMETRY_CAPACITY + 9 && snapshot.render.triangles === (RENDER_TELEMETRY_CAPACITY + 9) * 1000, "latest render counters changed");
assert(snapshot.memory.textures === 3 && snapshot.memory.geometries === 4 && snapshot.memory.programs === 7 && snapshot.memory.renderTargets === 5, "latest memory counters changed");
assert(snapshot.backingWidth === 1280 + RENDER_TELEMETRY_CAPACITY + 9 && snapshot.backingHeight === 720 && snapshot.pixelRatio === 1.5, "latest surface identity changed");
assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.frameMs) && Object.isFrozen(snapshot.memory), "telemetry snapshot is mutable");

ring.clear();
ring.record(Number.NaN, -1, { render: { drawCalls: Number.POSITIVE_INFINITY, triangles: -5 }, memory: { textures: -1 } }, -4, Number.NaN, Number.POSITIVE_INFINITY, "cinematic");
const sanitized = ring.snapshot();
assert(sanitized.samples === 1 && sanitized.frameMs.mean === 0 && sanitized.submitMs.mean === 0, "invalid timing did not sanitize without breaking render");
assert(sanitized.render.drawCalls === 0 && sanitized.render.triangles === 0 && sanitized.backingWidth === 0, "invalid counters did not sanitize");
assert(sanitized.tier === "cinematic", "tier identity was not retained");

ring.clear();
ring.record(16, 4, { render: { drawCalls: 12, triangles: 34, ...({ calls: 9_999 } as object) } }, 1, 1, 1, "performance");
assert(ring.snapshot().render.drawCalls === 12, "telemetry read Three's cumulative render.calls instead of per-frame drawCalls");

console.log("p_render_telemetry OK: strict whole-frame fixed-slot submission snapshots reject the final-pass-only signature; fixed 240-frame storage, overwrite order, percentiles, and non-throwing live sanitization remain exact");
