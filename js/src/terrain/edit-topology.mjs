// Derived-terrain edit-layer base topology — the ONE derivation of the lattice a
// sculpt stroke binds to. Three consumers MUST agree byte-for-byte or strokes land on
// a different field than the compiler composes: the terrain compiler (its edit-layer
// domain), the runtime terrain.deform derived path (layer creation), and the
// derived-build rebase ingestion (rebase target). It recomputes exactly the map-field
// master framing (margin, cover radius, half-step snap, territory clamp) WITHOUT the
// erosion raster, so callers never pay a compile to learn the lattice.

import {
  MAP_FIELD_CHUNK_SAMPLES,
  MAP_FIELD_CHUNK_SIZE_M,
  MAP_FIELD_MARGIN_M,
  MAP_FIELD_MASTER_STEP_M,
  worldMapFeatureBounds,
} from "./map-field.mjs";
import { createTerrainGridSpec, terrainChunkRangeForBounds, terrainGridIdForLogicalMap } from "./grid.mjs";
import { createTerrainEditBaseTopology } from "./edit-layer.mjs";

/** The base topology (grid + chunk-domain rect + topology hash) the terrain compiler
 *  composes edit layers against for this WorldMap. `gridId` mirrors the compiler:
 *  explicit config gridId wins, else the logical map id's canonical grid id. */
export function terrainEditBaseTopologyForWorldMap(worldMap, options = {}) {
  if (worldMap === null || typeof worldMap !== "object") {
    throw new Error("terrain edit base topology requires a WorldMap");
  }
  const grid = createTerrainGridSpec({
    gridId: options.gridId ?? terrainGridIdForLogicalMap(worldMap.id),
    origin: [0, 0],
    chunkSizeM: MAP_FIELD_CHUNK_SIZE_M,
    defaultSamples: MAP_FIELD_CHUNK_SAMPLES,
  });
  const featureBounds = worldMapFeatureBounds(worldMap);
  const coverRadius = Math.max(
    Math.abs(featureBounds.minX),
    Math.abs(featureBounds.maxX),
    Math.abs(featureBounds.minZ),
    Math.abs(featureBounds.maxZ),
  ) + MAP_FIELD_MARGIN_M;
  let half = Math.ceil(coverRadius / MAP_FIELD_MASTER_STEP_M) * MAP_FIELD_MASTER_STEP_M;
  if (!(half > 0)) half = MAP_FIELD_MASTER_STEP_M;
  // Territory rect (plans/territory-rect-compile-domain.md): the authored extent plus
  // the map-field margin, clamped to the master square — identical to the compiler's.
  const territory = Object.freeze({
    minX: Math.max(-half, featureBounds.minX - MAP_FIELD_MARGIN_M),
    minZ: Math.max(-half, featureBounds.minZ - MAP_FIELD_MARGIN_M),
    maxX: Math.min(half, featureBounds.maxX + MAP_FIELD_MARGIN_M),
    maxZ: Math.min(half, featureBounds.maxZ + MAP_FIELD_MARGIN_M),
  });
  return createTerrainEditBaseTopology({ grid, domain: terrainChunkRangeForBounds(grid, territory) });
}
