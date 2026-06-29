// Phase 16 (Track B — Eyes) — THE VISUAL SELF-CORRECTION LOOP GATE.
//
// refineVisual is the loop an agent uses to improve how a scene LOOKS with no human in the chair:
// render → critique → fix → repeat until the frame meets a bar. The loop is provider-based (like the
// engine's LLM-provider agent loop), so the GPU-bound render and model-bound critique are swappable
// interfaces and the LOOP LOGIC is testable headlessly. Here the providers are a physically-plausible
// auto-exposure model (rendered luminance = exposure × key-light; the critic nudges toward a
// well-exposed band) — a faithful stand-in for the real render+vision providers, which plug in
// unchanged. This gate proves the loop converges, is deterministic, reports non-convergence honestly,
// drives multiple knobs, and short-circuits when the frame already passes.
//
// Run: ./target/release/limina js/test/p16_self_correct.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { refineVisual, type RenderProvider, type CritiqueProvider, type Frame } from "../src/eyes/self_correct.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_self_correct FAIL: " + msg);
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// A faithful render stand-in: brightness = exposure × key-light (clamped), as a real frame would
// respond. The critic reads frame.stats.luminance — the same shape a real luminance histogram has.
const render: RenderProvider = {
  render(config): Frame {
    const luminance = clamp((config.exposure ?? 1) * (config.keyLight ?? 1), 0, 4);
    return { width: 8, height: 8, stats: { luminance } };
  },
};

// Auto-exposure critic: pass inside a well-exposed band; else nudge `lever` toward target with damping
// (so it takes a few honest iterations, not a magic one-shot).
function autoExposure(lever: "exposure" | "keyLight", target = 1.0, band = 0.1, damping = 0.6): CritiqueProvider {
  return {
    critique(frame, config): { passes: boolean; score: number; notes: string; adjustments: Record<string, number> } {
      const lum = frame.stats?.luminance ?? 0;
      const err = Math.abs(lum - target);
      const score = clamp(1 - err, 0, 1);
      if (err <= band) return { passes: true, score: 1, notes: "well exposed", adjustments: {} };
      const cur = config[lever] ?? 1;
      // multiplicative correction toward target, damped:
      const ideal = cur * (target / Math.max(lum, 0.05));
      const delta = (ideal - cur) * damping;
      return { passes: false, score, notes: lum < target ? "too dark" : "too bright", adjustments: { [lever]: delta } };
    },
  };
}

// ── 1. Converges from a dark start by raising exposure. ───────────────────────────────────────
{
  const r = await refineVisual({ render, critique: autoExposure("exposure"), initialConfig: { exposure: 0.3, keyLight: 1 }, maxIterations: 12 });
  assert(r.converged, `the loop converged from a dark frame (final score ${r.finalScore})`);
  assert(r.finalScore >= 0.9, `the final frame is well-exposed (score ${r.finalScore})`);
  assert(Math.abs((r.finalConfig.exposure ?? 0) * (r.finalConfig.keyLight ?? 1) - 1) <= 0.1, `final luminance lands in the band (exposure=${r.finalConfig.exposure})`);
  assert(r.iterations >= 2 && r.iterations <= 12, `it took a few honest iterations (${r.iterations}), not a one-shot`);
  // The score improves monotonically as it fixes (each pass is at least as good as the last).
  for (let i = 1; i < r.history.length; i++) assert(r.history[i].score >= r.history[i - 1].score - 1e-9, `score is non-decreasing across iterations (step ${i})`);
}

// ── 2. Deterministic: same start ⇒ identical trajectory. ──────────────────────────────────────
{
  const a = await refineVisual({ render, critique: autoExposure("exposure"), initialConfig: { exposure: 0.3, keyLight: 1 }, maxIterations: 12 });
  const b = await refineVisual({ render, critique: autoExposure("exposure"), initialConfig: { exposure: 0.3, keyLight: 1 }, maxIterations: 12 });
  assert(a.iterations === b.iterations && a.history.length === b.history.length, "same iteration count across runs");
  for (let i = 0; i < a.history.length; i++) assert(Object.is(a.history[i].score, b.history[i].score), `step ${i} identical across runs (deterministic)`);
}

// ── 3. Honest non-convergence: too small a budget ⇒ converged:false, with the real final score. ─
{
  const r = await refineVisual({ render, critique: autoExposure("exposure"), initialConfig: { exposure: 0.2, keyLight: 1 }, maxIterations: 1 });
  assert(!r.converged, "a 1-iteration budget from a dark frame does NOT converge");
  assert(r.iterations === 1 && r.finalScore < 1, `it reports the honest sub-bar final score (${r.finalScore}), not a fake pass`);
}

// ── 4. A different knob: the same loop fixes an under-lit scene by raising the key light. ──────
{
  const r = await refineVisual({ render, critique: autoExposure("keyLight"), initialConfig: { exposure: 1, keyLight: 0.25 }, maxIterations: 12 });
  assert(r.converged && r.finalScore >= 0.9, `the loop drives the key-light knob to a well-lit frame (keyLight=${r.finalConfig.keyLight})`);
}

// ── 5. Already passing ⇒ one iteration, no fixes applied. ─────────────────────────────────────
{
  const r = await refineVisual({ render, critique: autoExposure("exposure"), initialConfig: { exposure: 1, keyLight: 1 }, maxIterations: 12 });
  assert(r.converged && r.iterations === 1, "an already-good frame passes on the first look");
  assert(Object.keys(r.history[0].adjustments).length === 0, "no fix is applied when the frame already meets the bar");
}

ops.op_log(
  "p16_self_correct OK: the visual self-correction loop — render → critique → fix → repeat, provider-based so the " +
  "GPU render + vision critique swap in unchanged. With a faithful auto-exposure stand-in it converges a dark frame to a " +
  "well-exposed one (monotonically improving), is deterministic, reports honest non-convergence under a tight budget, " +
  "drives any knob, and short-circuits when the frame already passes. The loop logic, proven headlessly.",
);
