import { ops } from "../src/engine.ts";
import {
  MAX_TERRAIN_EDIT_DELTAS_PER_OPERATION,
  MAX_TERRAIN_EDIT_OPERATIONS,
  TerrainEditBaseMismatchError,
  TerrainEditCancelledError,
  canonicalTerrainEditLayer,
  composePreparedTerrainEditLayers,
  composeTerrainEditLayers,
  createTerrainEditBaseTopology,
  createTerrainEditLayer,
  parseTerrainEditBaseTopology,
  parseTerrainEditLayer,
  prepareTerrainEditLayers,
  rebaseTerrainEditLayer,
} from "../src/terrain/edit-layer.mjs";
import { createTerrainGridSpec, terrainChunkTopology } from "../src/terrain/grid.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_edit_layer FAIL: ${message}`);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function rejects(run: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function referenceCompose(
  topology: ReturnType<typeof terrainChunkTopology>,
  baseHeightsM: Float32Array,
  layers: Array<ReturnType<typeof createTerrainEditLayer>>,
): Float32Array {
  const heightsM = new Float32Array(baseHeightsM);
  const intervals = topology.samples.rows - 1;
  const minGx = topology.tx * intervals;
  const minGz = topology.tz * intervals;
  for (const editLayer of layers) {
    for (const operation of editLayer.operations) {
      for (const delta of operation.deltas) {
        const col = delta.gx - minGx;
        const row = delta.gz - minGz;
        if (col < 0 || col > intervals || row < 0 || row > intervals) continue;
        const index = row * topology.samples.cols + col;
        heightsM[index] = Math.fround(heightsM[index] + delta.deltaM);
      }
    }
  }
  return heightsM;
}

function equalFloat32(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
  return true;
}

const grid = createTerrainGridSpec({ gridId: "grey-field", origin: [0, 0], chunkSizeM: 100, defaultSamples: 5 });
const base = createTerrainEditBaseTopology({
  grid,
  domain: { minTx: -2, minTz: -2, maxTx: 1, maxTz: 1 },
});

// Creation canonicalizes sparse points, while parsing requires that canonical order and verifies both hashes.
const layer = createTerrainEditLayer({
  layerId: "sculpt-a",
  baseTopology: base,
  operations: [
    {
      operationId: "raise-edge",
      kind: "add",
      deltas: [
        { gx: 0, gz: 0, deltaM: 2 },
        { gx: -2, gz: -3, deltaM: 4 },
      ],
    },
    { operationId: "overlap-edge", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: -0.5 }] },
  ],
});
const differentlyOrdered = createTerrainEditLayer({
  layerId: "sculpt-a",
  baseTopology: clone(base),
  operations: [
    {
      operationId: "raise-edge",
      kind: "add",
      deltas: [
        { gx: -2, gz: -3, deltaM: 4 },
        { gx: 0, gz: 0, deltaM: 2 },
      ],
    },
    { operationId: "overlap-edge", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: -0.5 }] },
  ],
});
assert(layer.contentHash === differentlyOrdered.contentHash, "delta input order changed canonical content hash");
assert(canonicalTerrainEditLayer(layer) === canonicalTerrainEditLayer(differentlyOrdered), "canonical source bytes were not deterministic");
assert(parseTerrainEditLayer(clone(layer)).contentHash === layer.contentHash, "canonical layer did not round-trip");
assert(Object.isFrozen(layer) && Object.isFrozen(layer.operations) && Object.isFrozen(layer.operations[0].deltas[0]), "canonical layer is mutable");

const tamperedDelta = clone(layer);
tamperedDelta.operations[0].deltas[0].deltaM += 1;
rejects(() => parseTerrainEditLayer(tamperedDelta), /content hash does not match/, "tampered delta was accepted");
const tamperedTopology = clone(base);
tamperedTopology.grid.chunkSizeM = 101;
rejects(() => parseTerrainEditBaseTopology(tamperedTopology), /topology hash does not match/, "tampered topology was accepted");
const reorderedWire = clone(layer);
reorderedWire.operations[0].deltas.reverse();
rejects(() => parseTerrainEditLayer(reorderedWire), /strictly ordered/, "non-canonical wire delta order was accepted");
const wrongGrid = clone(layer);
wrongGrid.gridId = "other-grid";
rejects(() => parseTerrainEditLayer(wrongGrid), /gridId does not match/, "layer/base grid disagreement was accepted");
const unknownField = clone(layer) as Record<string, unknown>;
unknownField.unverified = true;
rejects(() => parseTerrainEditLayer(unknownField), /must contain exactly/, "unknown layer field was accepted");
rejects(
  () => createTerrainEditLayer({
    layerId: "duplicate-point",
    baseTopology: base,
    operations: [{ operationId: "bad", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: 1 }, { gx: 0, gz: 0, deltaM: 2 }] }],
  }),
  /duplicate sample coordinates/,
  "duplicate coordinates in one operation were accepted",
);
rejects(
  () => createTerrainEditLayer({
    layerId: "outside",
    baseTopology: base,
    operations: [{ operationId: "bad", kind: "add", deltas: [{ gx: 9, gz: 0, deltaM: 1 }] }],
  }),
  /outside the base topology domain/,
  "out-of-domain sparse delta was accepted",
);

// Signed global lattice points are shared by adjacent chunks. The same edge edit composes identically on both sides.
const leftTopology = terrainChunkTopology(grid, { lod: 0, tx: -1, tz: -1, samples: 5 });
const rightTopology = terrainChunkTopology(grid, { lod: 0, tx: 0, tz: -1, samples: 5 });
const leftBaseHeights = new Float32Array(25).fill(10);
const rightBaseHeights = new Float32Array(25).fill(10);
const prepared = prepareTerrainEditLayers({ baseTopology: base, layers: [layer] });
const left = composePreparedTerrainEditLayers({ baseTopology: base, chunkTopology: leftTopology, baseHeightsM: leftBaseHeights, preparedLayers: prepared });
const right = composePreparedTerrainEditLayers({ baseTopology: base, chunkTopology: rightTopology, baseHeightsM: rightBaseHeights, preparedLayers: prepared });
assert(left.heightsM[4 * 5 + 4] === 11.5, `left shared corner was ${left.heightsM[24]}`);
assert(right.heightsM[4 * 5] === 11.5, `right shared corner was ${right.heightsM[20]}`);
assert(left.heightsM[1 * 5 + 2] === 14, "negative-coordinate interior edit was not addressed exactly");
assert(leftBaseHeights.every((height) => height === 10) && rightBaseHeights.every((height) => height === 10), "composition mutated source heights");
assert(left.appliedDeltaCount === 3 && left.sourceDeltaCount === 3, "composition accounting is incorrect");
assert(equalFloat32(left.heightsM, referenceCompose(leftTopology, leftBaseHeights, [layer])), "indexed negative-chunk output diverged from reference composition");
assert(equalFloat32(right.heightsM, referenceCompose(rightTopology, rightBaseHeights, [layer])), "indexed shared-edge output diverged from reference composition");
assert(prepared.indexedDeltaCount <= prepared.sourceDeltaCount * 4, "shared-edge ownership exceeded four chunks per source delta");

const distantTopology = terrainChunkTopology(grid, { lod: 0, tx: -2, tz: -2, samples: 5 });
const distant = composePreparedTerrainEditLayers({
  baseTopology: base,
  chunkTopology: distantTopology,
  baseHeightsM: new Float32Array(25).fill(10),
  preparedLayers: prepared,
});
assert(distant.sourceDeltaCount === 3 && distant.inspectedDeltaCount === 0, "distant chunk inspected global edit data instead of its empty local bucket");
assert(equalFloat32(distant.heightsM, referenceCompose(distantTopology, new Float32Array(25).fill(10), [layer])), "empty indexed bucket diverged from reference composition");
rejects(
  () => composePreparedTerrainEditLayers({
    baseTopology: base,
    chunkTopology: rightTopology,
    baseHeightsM: rightBaseHeights,
    preparedLayers: { ...prepared },
  }),
  /not created by prepareTerrainEditLayers/,
  "forged prepared index metadata was accepted",
);

// Layer and operation order are explicit: every overlap is applied sequentially with float32 storage semantics.
const orderA = createTerrainEditLayer({
  layerId: "order-a",
  baseTopology: base,
  operations: [{ operationId: "a", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: 0.1 }] }],
});
const orderB = createTerrainEditLayer({
  layerId: "order-b",
  baseTopology: base,
  operations: [{ operationId: "b", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: 0.2 }] }],
});
const ordered = composeTerrainEditLayers({ baseTopology: base, chunkTopology: rightTopology, baseHeightsM: rightBaseHeights, layers: [orderA, orderB] });
const expectedOrdered = Math.fround(Math.fround(10 + 0.1) + 0.2);
assert(ordered.heightsM[20] === expectedOrdered, "overlap did not follow stored layer/operation order");
assert(JSON.stringify(ordered.layerHashes) === JSON.stringify([orderA.contentHash, orderB.contentHash]), "composition discarded layer order");
rejects(
  () => composeTerrainEditLayers({ baseTopology: base, chunkTopology: rightTopology, heights: rightBaseHeights, layers: [layer] } as never),
  /must contain exactly: baseHeightsM/,
  "ambiguous legacy heights input was accepted instead of requiring world metres",
);

const otherBase = createTerrainEditBaseTopology({
  grid,
  domain: { minTx: -2, minTz: -2, maxTx: 2, maxTz: 2 },
});
const mismatch = rejects(
  () => composeTerrainEditLayers({ baseTopology: otherBase, chunkTopology: rightTopology, baseHeightsM: rightBaseHeights, layers: [layer] }),
  /base topology mismatch/,
  "old-base layer composed against a new base",
);
assert(mismatch instanceof TerrainEditBaseMismatchError && (mismatch as TerrainEditBaseMismatchError).code === "terrain_edit_base_mismatch", "base mismatch was not typed");

// Refinement maps every old global sample exactly. Coarsening is all-or-nothing and never resamples.
const refinedGrid = createTerrainGridSpec({ ...grid, origin: [...grid.origin], defaultSamples: 9 });
const refinedBase = createTerrainEditBaseTopology({ grid: refinedGrid, domain: { ...base.domain } });
const refined = rebaseTerrainEditLayer(layer, refinedBase);
assert(refined.ok, "exact refinement reported a conflict");
if (refined.ok) {
  assert(refined.report.exact && refined.report.mappedDeltaCount === 3, "refinement report is incomplete");
  assert(refined.layer.operations[0].deltas[0].gx === -4 && refined.layer.operations[0].deltas[0].gz === -6, "refinement did not map signed coordinates exactly");
  assert(refined.layer.operations[0].deltas[1].gx === 0 && refined.layer.operations[0].deltas[1].gz === 0, "refinement changed the shared edge coordinate");
  assert(refined.layer.contentHash !== layer.contentHash, "new base topology did not change layer provenance");
}

const coarseGrid = createTerrainGridSpec({ ...grid, origin: [...grid.origin], defaultSamples: 3 });
const coarseBase = createTerrainEditBaseTopology({ grid: coarseGrid, domain: { ...base.domain } });
const lossy = rebaseTerrainEditLayer(layer, coarseBase);
assert(!lossy.ok, "lossy coarsening was accepted");
if (!lossy.ok) {
  assert(lossy.conflicts.some((conflict) => conflict.code === "coordinate_not_representable" && conflict.gx === -2 && conflict.gz === -3), "coarsening conflict lacks the exact source coordinate");
  assert(lossy.report.conflictCount === 1 && !lossy.report.exact, "coarsening report hid conflicts");
  assert(!("layer" in lossy), "conflicted rebase returned a partially rewritten layer");
}

const evenLayer = createTerrainEditLayer({
  layerId: "coarsenable",
  baseTopology: base,
  operations: [{ operationId: "even", kind: "add", deltas: [{ gx: -2, gz: -2, deltaM: 3 }] }],
});
const coarsened = rebaseTerrainEditLayer(evenLayer, coarseBase);
assert(coarsened.ok && coarsened.layer.operations[0].deltas[0].gx === -1 && coarsened.layer.operations[0].deltas[0].gz === -1, "exact coarsening did not preserve an aligned edit");

const shrunkenBase = createTerrainEditBaseTopology({ grid, domain: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } });
const outside = rebaseTerrainEditLayer(layer, shrunkenBase);
assert(!outside.ok && outside.conflicts.some((conflict) => conflict.code === "outside_target_domain"), "domain shrink silently dropped an edit");
const movedGrid = createTerrainGridSpec({ ...grid, origin: [1, 0] });
const movedBase = createTerrainEditBaseTopology({ grid: movedGrid, domain: { ...base.domain } });
const moved = rebaseTerrainEditLayer(layer, movedBase);
assert(!moved.ok && moved.conflicts[0].code === "grid_geometry_changed", "grid origin change was not a typed conflict");
const renamedGrid = createTerrainGridSpec({ ...grid, gridId: "other", origin: [...grid.origin] });
const renamedBase = createTerrainEditBaseTopology({ grid: renamedGrid, domain: { ...base.domain } });
const renamed = rebaseTerrainEditLayer(layer, renamedBase);
assert(!renamed.ok && renamed.conflicts[0].code === "grid_mismatch", "grid identity change was not a typed conflict");

// Cancellation is checked before work and remains typed at both composition and rebase boundaries.
const composeCancelled = rejects(
  () => composeTerrainEditLayers({ baseTopology: base, chunkTopology: rightTopology, baseHeightsM: rightBaseHeights, layers: [layer] }, { shouldCancel: () => true }),
  /cancelled/,
  "composition ignored cancellation",
);
assert(composeCancelled instanceof TerrainEditCancelledError, "composition cancellation was not typed");
const rebaseCancelled = rejects(() => rebaseTerrainEditLayer(layer, refinedBase, { shouldCancel: () => true }), /cancelled/, "rebase ignored cancellation");
assert(rebaseCancelled instanceof TerrainEditCancelledError, "rebase cancellation was not typed");

const denseDeltas = Array.from({ length: 17 * 17 }, (_, index) => ({
  gx: (index % 17) - 8,
  gz: Math.floor(index / 17) - 8,
  deltaM: 0.01,
}));
const cancellationLayer = createTerrainEditLayer({
  layerId: "cancellation-work",
  baseTopology: base,
  operations: Array.from({ length: 4 }, (_, index) => ({ operationId: `work-${index}`, kind: "add", deltas: denseDeltas })),
});
const densePrepared = prepareTerrainEditLayers({ baseTopology: base, layers: [cancellationLayer] });
const denseLocal = composePreparedTerrainEditLayers({
  baseTopology: base,
  chunkTopology: rightTopology,
  baseHeightsM: rightBaseHeights,
  preparedLayers: densePrepared,
});
assert(denseLocal.sourceDeltaCount === 1_156, `dense index source accounting was ${denseLocal.sourceDeltaCount}`);
assert(denseLocal.inspectedDeltaCount === 100 && denseLocal.inspectedDeltaCount < denseLocal.sourceDeltaCount / 10,
  `local composition inspected ${denseLocal.inspectedDeltaCount}/${denseLocal.sourceDeltaCount} global deltas`);
assert(equalFloat32(denseLocal.heightsM, referenceCompose(rightTopology, rightBaseHeights, [cancellationLayer])), "dense indexed output diverged from reference composition");
let composeCancellationChecks = 0;
const midComposeCancelled = rejects(
  () => composeTerrainEditLayers(
    { baseTopology: base, chunkTopology: rightTopology, baseHeightsM: rightBaseHeights, layers: [cancellationLayer] },
    { shouldCancel: () => ++composeCancellationChecks === 3 },
  ),
  /cancelled/,
  "composition ignored cancellation after processing began",
);
assert(midComposeCancelled instanceof TerrainEditCancelledError && composeCancellationChecks === 3, "composition did not cancel at its bounded work checkpoint");
let rebaseCancellationChecks = 0;
const midRebaseCancelled = rejects(
  () => rebaseTerrainEditLayer(cancellationLayer, refinedBase, { shouldCancel: () => ++rebaseCancellationChecks === 3 }),
  /cancelled/,
  "rebase ignored cancellation after processing began",
);
assert(midRebaseCancelled instanceof TerrainEditCancelledError && rebaseCancellationChecks === 3, "rebase did not cancel at its bounded work checkpoint");

// Resource ceilings reject adversarial documents before unbounded composition work.
const oneDelta = [{ gx: 0, gz: 0, deltaM: 1 }];
rejects(
  () => createTerrainEditLayer({
    layerId: "too-many-operations",
    baseTopology: base,
    operations: Array.from({ length: MAX_TERRAIN_EDIT_OPERATIONS + 1 }, (_, index) => ({ operationId: `op-${index}`, kind: "add", deltas: oneDelta })),
  }),
  /exceeds .* entries/,
  "operation ceiling was not enforced",
);
rejects(
  () => createTerrainEditLayer({
    layerId: "too-many-deltas",
    baseTopology: base,
    operations: [{
      operationId: "op",
      kind: "add",
      deltas: Array.from({ length: MAX_TERRAIN_EDIT_DELTAS_PER_OPERATION + 1 }, (_, index) => ({ gx: index, gz: 0, deltaM: 1 })),
    }],
  }),
  /exceeds .* entries/,
  "per-operation delta ceiling was not enforced",
);
rejects(
  () => createTerrainEditBaseTopology({ grid, domain: { minTx: -600, minTz: -600, maxTx: 600, maxTz: 600 } }),
  /domain exceeds/,
  "oversized topology domain was accepted",
);

ops.op_log(
  "p_terrain_edit_layer OK: canonical content-addressed sparse layers and reusable local indexes compose world-metre heights without source mutation; ordered overlaps, signed chunks, shared seams, exact refine/coarsen rebase, typed loss conflicts, stale bases, mid-work cancellation, tampering, and resource ceilings are proven.",
);
