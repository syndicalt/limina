// p_post_stages — the render/post.ts stage wiring gate (pure, no renderer).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_post_stages.ts
// Exit: 0 pass, throws (1) on fail.
//
// Proves the Phase-4 post additions (godrays / dof / outline) are wired into the preset
// resolver: the three CORE stages (ao/bloom/grade) stay on by default, the three OPT-IN
// stages are OFF by default (so no demo's look changes), and a deep-merge override turns a
// stage on while preserving that stage's other defaults and every non-overridden stage.
// Falsifiable: an unwired stage is `undefined` on the resolved preset and trips an assert.

import { resolvePostPreset, DEFAULT_POST_PRESET } from "../src/render/post.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) { ops.op_log("p_post_stages FAIL: " + msg); throw new Error(msg); }
}

const d = DEFAULT_POST_PRESET;
assert(d.ao.enabled && d.bloom.enabled && d.grade.enabled, "core stages (ao/bloom/grade) must be ON by default");
assert(d.godrays.enabled === false && d.dof.enabled === false && d.outline.enabled === false,
  "opt-in stages (godrays/dof/outline) must be OFF by default so the shipped look is unchanged");

// Deep-merge override: turn the opt-in stages on, tweak one knob each.
const r = resolvePostPreset({
  godrays: { enabled: true, density: 1.0 },
  dof: { enabled: true, bokehScale: 3 },
  outline: { enabled: true, strength: 0.9 },
});
assert(r.godrays.enabled && r.godrays.density === 1.0, "godrays override did not apply");
assert(r.dof.enabled && r.dof.bokehScale === 3, "dof override did not apply");
assert(r.outline.enabled && r.outline.strength === 0.9, "outline override did not apply");
// Non-overridden knobs on an overridden stage keep their defaults (partial merge, not replace).
assert(r.godrays.maxDensity === d.godrays.maxDensity && r.godrays.raymarchSteps === d.godrays.raymarchSteps,
  "partial godrays override dropped a non-overridden default");
// Non-overridden STAGES are untouched.
assert(r.ao.enabled === d.ao.enabled && r.bloom.strength === d.bloom.strength,
  "override of one stage clobbered another");

ops.op_log("p_post_stages OK: 6 post stages; ao/bloom/grade on + godrays/dof/outline OFF by default; deep-merge override preserves per-stage + cross-stage defaults.");
