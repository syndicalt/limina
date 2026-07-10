import { DEFAULT_RENDER_QUALITY_PROFILES, isRenderQualityTier, resolveRenderQuality } from "../src/render/quality.ts";
import { constrainPostPreset, resolvePostPreset } from "../src/render/post.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_render_quality FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  assert(caught instanceof Error && pattern.test(caught.message), `${message}: ${caught instanceof Error ? caught.message : "did not throw"}`);
}

assert(isRenderQualityTier("performance") && isRenderQualityTier("balanced") && isRenderQualityTier("cinematic"), "known tiers were rejected");
assert(!isRenderQualityTier("ultra") && !isRenderQualityTier(1), "unknown tiers were accepted");
assert(Object.isFrozen(DEFAULT_RENDER_QUALITY_PROFILES) && Object.isFrozen(DEFAULT_RENDER_QUALITY_PROFILES.balanced.post), "tier defaults are mutable");

const performance = resolveRenderQuality("performance", 2);
const balanced = resolveRenderQuality("balanced", 2);
const cinematic = resolveRenderQuality("cinematic", 2);
assert(performance.pixelRatio === 1 && performance.shadowMapSize === 1024 && !performance.post.enabled, "performance tier changed");
assert(balanced.pixelRatio === 1.5 && balanced.shadowMapSize === 2048 && balanced.post.aoSamples === 8 && balanced.post.aoResolutionScale === 0.5, "balanced tier changed");
assert(cinematic.pixelRatio === 2 && cinematic.shadowMapSize === 4096 && cinematic.post.aoSamples === 16, "cinematic tier changed");
assert(resolveRenderQuality("cinematic", 1).pixelRatio === 1.25, "resolution scale was not applied before the final DPR cap");

const overridden = resolveRenderQuality("balanced", 3, {
  resolutionScale: 0.8,
  maxPixelRatio: 2,
  shadowMapSize: 512,
  shadowHalfExtent: 200,
  telemetryIntervalFrames: 60,
  post: { enabled: false, aoSamples: 3, aoResolutionScale: 0.75, bloom: false },
});
assert(overridden.pixelRatio === 2 && overridden.shadowMapSize === 512 && overridden.shadowHalfExtent === 200, "valid execution override changed");
assert(!overridden.post.enabled && overridden.post.aoSamples === 3 && overridden.telemetryIntervalFrames === 60, "valid nested override changed");
assert(Object.isFrozen(overridden) && Object.isFrozen(overridden.post), "resolved profile is mutable");

const authoredPost = resolvePostPreset({ ao: { samples: 12, resolutionScale: 0.75 }, bloom: { enabled: true } });
const performancePost = constrainPostPreset(authoredPost, performance.post);
const balancedPost = constrainPostPreset(authoredPost, balanced.post);
const cinematicPost = constrainPostPreset(authoredPost, cinematic.post);
assert(performancePost === undefined, "performance tier did not disable the post graph");
assert(balancedPost?.ao.samples === 8 && balancedPost.ao.resolutionScale === 0.5 && balancedPost.bloom.enabled,
  "balanced tier did not cap authored post cost");
assert(cinematicPost?.ao.samples === 12 && cinematicPost.ao.resolutionScale === 0.75,
  "cinematic tier increased authored post cost instead of preserving intent");
assert(authoredPost.ao.samples === 12 && authoredPost.ao.resolutionScale === 0.75,
  "post quality derivation mutated authored intent");

rejects(() => resolveRenderQuality("ultra" as never, 1), /tier/, "unknown tier was accepted");
for (const dpr of [0, Number.NaN, Number.POSITIVE_INFINITY, 17]) {
  rejects(() => resolveRenderQuality("balanced", dpr), /devicePixelRatio/, `invalid DPR ${dpr} was accepted`);
}
rejects(() => resolveRenderQuality("balanced", 1, { shadowMapSize: 1000 }), /power of two/, "non-power-of-two shadow map was accepted");
rejects(() => resolveRenderQuality("balanced", 1, { post: { aoSamples: 0 } }), /aoSamples/, "zero AO samples were accepted");
rejects(() => resolveRenderQuality("balanced", 1, { post: { aoResolutionScale: 1.1 } }), /aoResolutionScale/, "oversized AO scale was accepted");
rejects(() => resolveRenderQuality("balanced", 1, { mystery: 1 } as never), /mystery/, "unknown override field was ignored");
rejects(() => resolveRenderQuality("balanced", 1, { post: { blur: true } } as never), /blur/, "unknown post field was ignored");
const accessor = {} as Record<string, unknown>;
Object.defineProperty(accessor, "resolutionScale", { enumerable: true, get: () => 1 });
rejects(() => resolveRenderQuality("balanced", 1, accessor), /data field/, "override accessor was evaluated");

console.log("p_render_quality OK: immutable tiers, final DPR caps, strict overrides, and GPU-cost bounds");
