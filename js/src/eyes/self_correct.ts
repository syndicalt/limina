// The VISUAL SELF-CORRECTION LOOP (Track B — Eyes).
//
// The signature capability: an agent improves how a scene LOOKS without a human in the chair, by
// iterating  author/adjust → render → critique → fix  until the frame meets a bar. The loop itself
// is provider-based, exactly like the engine's agent loop is LLM-provider-based (Scripted / Ollama /
// Gateway): the GPU-bound and model-bound parts are swappable interfaces, so the LOOP logic —
// iteration, applying the critique's fixes, convergence, the iteration cap — is pure and
// deterministic, and testable headlessly with mock providers. The real providers plug in unchanged:
//   • RenderProvider  — renders the scene under a config and returns a frame (real impl: headless
//     render → image; needs working GPU readback).
//   • CritiqueProvider — scores a frame and proposes config adjustments (real impl: a vision model).
//
// Determinism: the loop reads no wall clock and no RNG; given deterministic providers it produces an
// identical refinement trajectory every run, so a recorded refinement replays.

/** A rendered frame handed to the critic. A real provider carries pixels/handles; a mock carries
 *  just the stats the critic reads. Opaque to the loop. */
export interface Frame {
  width: number;
  height: number;
  /** Provider-defined readouts the critic uses (e.g. mean luminance, contrast). */
  stats?: Record<string, number>;
}

/** Renders the scene under a numeric config (exposure, key-light intensity, …). */
export interface RenderProvider {
  render(config: Record<string, number>): Frame | Promise<Frame>;
}

/** Scores a frame and proposes config ADJUSTMENTS (deltas applied to the config for the next pass).
 *  `passes` true ends the loop. */
export interface Critique {
  passes: boolean;
  /** 0..1 quality score (higher is better). */
  score: number;
  notes: string;
  /** Config deltas the loop applies as the "fix" before the next render. Empty when passing. */
  adjustments: Record<string, number>;
}
export interface CritiqueProvider {
  critique(frame: Frame, config: Record<string, number>): Critique | Promise<Critique>;
}

export interface RefineStep {
  iteration: number;
  score: number;
  passes: boolean;
  notes: string;
  adjustments: Record<string, number>;
}
export interface RefineResult {
  /** Did the frame reach the bar within the iteration budget? */
  converged: boolean;
  iterations: number;
  finalConfig: Record<string, number>;
  finalScore: number;
  history: RefineStep[];
}

/** Apply critique deltas to a config (additive); returns a new config. */
function applyAdjustments(config: Record<string, number>, adj: Record<string, number>): Record<string, number> {
  const out = { ...config };
  for (const k of Object.keys(adj)) out[k] = (out[k] ?? 0) + adj[k];
  return out;
}

/**
 * Run the self-correction loop: render → critique → (fix → repeat) until the critique passes or the
 * iteration budget is exhausted. Returns the trajectory + final config/score. Pure over the
 * providers — deterministic when they are.
 */
export async function refineVisual(opts: {
  render: RenderProvider;
  critique: CritiqueProvider;
  initialConfig: Record<string, number>;
  maxIterations?: number;
}): Promise<RefineResult> {
  const maxIterations = Math.max(1, opts.maxIterations ?? 8);
  let config = { ...opts.initialConfig };
  const history: RefineStep[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const frame = await opts.render.render(config);
    const c = await opts.critique.critique(frame, config);
    history.push({ iteration: i, score: c.score, passes: c.passes, notes: c.notes, adjustments: { ...c.adjustments } });
    if (c.passes) {
      return { converged: true, iterations: i + 1, finalConfig: config, finalScore: c.score, history };
    }
    config = applyAdjustments(config, c.adjustments);
  }

  // Budget exhausted: report the final state honestly (a real pipeline would surface "did not
  // converge" rather than silently shipping a sub-bar frame).
  const frame = await opts.render.render(config);
  const c = await opts.critique.critique(frame, config);
  return { converged: c.passes, iterations: maxIterations, finalConfig: config, finalScore: c.score, history };
}
