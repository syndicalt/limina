// STRUCTURAL self-correction (Track B — Eyes) — the COMPLETE, GPU-free self-correction loop.
//
// The visual self-correction loop (self_correct.ts) needs a real GPU render + vision critique to
// judge pixels. But a large, useful slice of "does this look right?" is STRUCTURAL and fully
// perceivable headlessly through scene.inspect: is anything placed? is it spread across the region
// or all piled at the origin? does the world have enough content? This loop closes that slice
// END TO END with REAL providers — perception via scene.inspect, fixes via the scene skills — so an
// agent genuinely improves its world without a human, and the whole thing is verifiable.
//
//   inspect (scene.inspect) -> critique (vs a structural goal) -> fix (place content) -> repeat
//
// Deterministic: placement is a pure function of the placement index, and inspect/fix go through the
// recorded skill surface, so a refinement replays identically.

/** What scene.inspect tells the loop about the world (a subset it reasons over). */
export interface SceneSummary {
  entityCount: number;
  spanX: number;
  spanZ: number;
}

/** A structural target the agent refines toward. */
export interface StructuralGoal {
  /** Minimum number of entities the scene must contain. */
  minEntities?: number;
  /** Minimum extent (max of X/Z span) the content must cover — catches "everything at the origin". */
  minSpan?: number;
}

export interface StructuralStep {
  iteration: number;
  entityCount: number;
  span: number;
  passes: boolean;
  /** "done" when the goal is met, else "place" (the fix the loop applied). */
  action: "done" | "place";
  /** Where the fix placed content this step (undefined on the passing step). */
  placedAt?: [number, number];
}

export interface RefineSceneResult {
  converged: boolean;
  iterations: number;
  finalSummary: SceneSummary;
  history: StructuralStep[];
}

/** Deterministic spreading placement: index k → a widening 2-column lattice so BOTH the entity
 *  count and the spatial span grow monotonically as the loop fixes. Pure function of k. */
function placementFor(k: number, spacing: number): [number, number] {
  const row = Math.floor(k / 2);
  const col = k % 2;
  return [row * spacing, col * spacing];
}

/**
 * Run the structural self-correction loop with REAL providers:
 *  - `inspect()` perceives the scene (wire to scene.inspect),
 *  - the goal is judged here,
 *  - `addAt(x, z)` applies the fix (wire to scene.createEntity / asset.place / world.populateBiome).
 * Returns the trajectory + whether the world reached the goal within the budget.
 */
export async function refineScene(opts: {
  inspect: () => Promise<SceneSummary>;
  goal: StructuralGoal;
  addAt: (x: number, z: number) => Promise<void>;
  spacing?: number;
  maxIterations?: number;
}): Promise<RefineSceneResult> {
  const spacing = opts.spacing ?? 5;
  const maxIterations = Math.max(1, opts.maxIterations ?? 32);
  const minEntities = opts.goal.minEntities ?? 0;
  const minSpan = opts.goal.minSpan ?? 0;
  const history: StructuralStep[] = [];

  // How many placements WE have made — drives the deterministic placement pattern. Starts from the
  // scene's existing entity count so we extend an already-populated world coherently.
  let placed = 0;
  let summary = await opts.inspect();
  placed = summary.entityCount;

  for (let i = 0; i < maxIterations; i++) {
    summary = await opts.inspect();
    const span = Math.max(summary.spanX, summary.spanZ);
    const passes = summary.entityCount >= minEntities && span >= minSpan;
    if (passes) {
      history.push({ iteration: i, entityCount: summary.entityCount, span, passes: true, action: "done" });
      return { converged: true, iterations: i + 1, finalSummary: summary, history };
    }
    const [x, z] = placementFor(placed, spacing);
    history.push({ iteration: i, entityCount: summary.entityCount, span, passes: false, action: "place", placedAt: [x, z] });
    await opts.addAt(x, z);
    placed += 1;
  }

  const final = await opts.inspect();
  const span = Math.max(final.spanX, final.spanZ);
  return {
    converged: final.entityCount >= minEntities && span >= minSpan,
    iterations: maxIterations,
    finalSummary: final,
    history,
  };
}
