// Composed-height sampler for DERIVED terrain (D5.4) — the runtime mirror of the
// derived compiler's chunk composition. Given the authority's MapDoc + the committed
// terrain edit layers it produces sampleHeightM over the edit-layer LOD0 lattice:
// bilinear base elevation from the compiled master field (raster + erosion + the
// hydrology river-channel carve when the map carries a recipe) plus additive lattice
// deltas from every committed HEIGHT layer, in authority order. Paint layers never
// move heights and are skipped.
//
// ROUNDING LAW (must match composePreparedTerrainEditLayers bit-for-bit): the chunk
// base stores sampleMapFieldHeight into a Float32Array (an implicit Math.fround) and
// every delta application rounds again with Math.fround. This module performs the
// identical fround sequence per lattice sample, so a runtime brush (smooth/flatten)
// and the next derived build compose the SAME field.
//
// Determinism: a pure function of content-addressed inputs (MapDoc bytes, layer
// content, base topology). No wall clock, no RNG. Bounded: the master field is
// decoded at most once per MapDoc content hash (layers are re-read per invocation —
// they change per stroke).

import { createMapTerrainField, nearestMapFieldCell, sampleMapFieldHeight } from "./map-field.mjs";
import {
  TerrainEditBaseMismatchError,
  parseTerrainEditBaseTopology,
  parseTerrainEditLayer,
  terrainEditLatticeGeometry,
} from "./edit-layer.mjs";
import { compileAtlasMapDoc } from "../world/design-map-compile.mjs";
import { DEFAULT_MAP_EROSION_RECIPE } from "../world/pipeline/erosion.mjs";
import { createHydrologyTopology } from "../world/hydrology-topology.mjs";
import { extractHydrologyWaterTopology } from "../world/hydrology-water-topology.mjs";
import { carveGeneratedRiverChannels } from "../world/river-channel-carve.mjs";
import {
  WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
  WORLD_TERRAIN_COMPILER_SEED,
  WORLD_TERRAIN_COMPILER_VERTICAL_RANGE,
} from "../world/compiler/config.mjs";

/** The master base field the derived compiler slices chunk bases from, rebuilt from
 *  canonical MapDoc bytes. Mirrors terrain-compile.ts exactly: raster + erosion via
 *  createMapTerrainField with the shared compiler constants, then — only when the
 *  WorldMap carries a hydrology recipe — the river-channel carve swaps heightsM.
 *  Any drift from the compiler's pipeline makes composed heights diverge from the
 *  compiled chunks, so the stage ORDER here is a contract, not an implementation. */
export function compileDerivedBaseField(mapsJsonText, gridId) {
  const { worldMap } = compileAtlasMapDoc({ mapsJsonText });
  const field = createMapTerrainField({
    worldMap,
    seed: WORLD_TERRAIN_COMPILER_SEED,
    baseAmplitude: WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId,
  });
  if (worldMap.hydrology === undefined) return field;
  const topology = createHydrologyTopology({
    rows: field.masterRes,
    cols: field.masterRes,
    heightsM: field.heightsM,
    cellSizeM: field.masterStep,
    seaLevelM: field.seaLevelM,
    precipitationMmPerYear: worldMap.hydrology.precipitationMmPerYear,
  });
  const water = extractHydrologyWaterTopology({
    heightsM: field.heightsM,
    topology,
    placement: { originX: field.bounds.minX, originZ: field.bounds.minZ },
    recipe: worldMap.hydrology,
  });
  const carved = carveGeneratedRiverChannels({
    rows: field.masterRes,
    cols: field.masterRes,
    heightsM: field.channelTerrainHeightsM ?? field.heightsM,
    cellSizeM: field.masterStep,
    originX: field.bounds.minX,
    originZ: field.bounds.minZ,
    reaches: water.reaches,
  }, { minimumHeightM: WORLD_TERRAIN_COMPILER_VERTICAL_RANGE.minM });
  return Object.freeze({ ...field, heightsM: new Float32Array(carved.heightsM) });
}

/** Compose one base field + the committed height edit layers into a queryable
 *  height field over the base topology's LOD0 lattice. `layers` must be in
 *  authority (project-state ref) order — that order IS the composition order. */
export function createComposedHeightField({ baseTopology: baseTopologyInput, baseField, layers, mapDocHash }) {
  const baseTopology = parseTerrainEditBaseTopology(baseTopologyInput);
  const lattice = terrainEditLatticeGeometry(baseTopology);
  const originX = baseTopology.grid.origin[0], originZ = baseTopology.grid.origin[1];
  const step = lattice.stepM;

  // Per-sample ordered delta lists. Iteration order (layer -> operation -> canonical
  // delta) is the compiler's bucket insertion order, so overlapping strokes fold in
  // the same sequence the chunk composition applies them.
  const deltasByKey = new Map();
  const layerHashes = [];
  for (const layerInput of layers) {
    const layer = parseTerrainEditLayer(layerInput);
    if (layer.baseTopology.topologyHash !== baseTopology.topologyHash) {
      throw new TerrainEditBaseMismatchError(baseTopology.topologyHash, layer.baseTopology.topologyHash);
    }
    layerHashes.push(layer.contentHash);
    for (const operation of layer.operations) {
      for (const delta of operation.deltas) {
        const key = `${delta.gz}:${delta.gx}`;
        const list = deltasByKey.get(key);
        if (list === undefined) deltasByKey.set(key, [delta.deltaM]);
        else list.push(delta.deltaM);
      }
    }
  }

  /** Composed world-metre height at one lattice sample: fround(base bilinear),
   *  then one Math.fround per applied delta — the chunk composition's exact rounding. */
  const heightAtLattice = (gx, gz) => {
    let h = Math.fround(sampleMapFieldHeight(baseField, originX + gx * step, originZ + gz * step));
    const deltas = deltasByKey.get(`${gz}:${gx}`);
    if (deltas !== undefined) for (const deltaM of deltas) h = Math.fround(h + deltaM);
    return h;
  };

  const cols = lattice.maxGx - lattice.minGx + 1;
  const rows = lattice.maxGz - lattice.minGz + 1;

  /** Bilinear composed height at an arbitrary world point, in the EXACT arithmetic
   *  order scatterAssets' sampleRaw uses, so a placement check and a tile scatter
   *  read bit-identical heights. Out-of-lattice points clamp like the tile edge. */
  const heightAt = (x, z) => {
    const fc = (x - lattice.minX) / step;
    const fr = (z - lattice.minZ) / step;
    const c0 = Math.min(cols - 1, Math.max(0, Math.floor(fc)));
    const r0 = Math.min(rows - 1, Math.max(0, Math.floor(fr)));
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    const tc = fc - c0, tr = fr - r0;
    const h = (r, c) => heightAtLattice(lattice.minGx + c, lattice.minGz + r);
    const top = h(r0, c0) * (1 - tc) + h(r0, c1) * tc;
    const bot = h(r1, c0) * (1 - tc) + h(r1, c1) * tc;
    return top * (1 - tr) + bot * tr;
  };

  // The dense TerrainTile-shaped lattice (metres; origin.y = 0, scale.y = 1) the
  // derived vegetation.scatter runs scatterAssets over. Memoized per BOUNDS:
  // callers pass their region of interest (inclusion-disc bbox + margin) — a
  // full-field tile on a multi-km map is ~6M samples × per-cell work PER scatter
  // (the rev-708 boot hang: 15 derived scatters at replay each built one).
  let tile;
  let tileKey = "";
  const denseTile = (bounds) => {
    let minCol = 0, maxCol = cols - 1, minRow = 0, maxRow = rows - 1;
    if (bounds !== undefined) {
      minCol = Math.max(0, Math.floor((bounds.minX - lattice.minX) / step));
      maxCol = Math.min(cols - 1, Math.ceil((bounds.maxX - lattice.minX) / step));
      minRow = Math.max(0, Math.floor((bounds.minZ - lattice.minZ) / step));
      maxRow = Math.min(rows - 1, Math.ceil((bounds.maxZ - lattice.minZ) / step));
    }
    const ncols = maxCol - minCol + 1;
    const nrows = maxRow - minRow + 1;
    const key = `${minCol}:${minRow}:${ncols}:${nrows}`;
    if (tile !== undefined && tileKey === key) return tile;
    const heights = new Float32Array(ncols * nrows);
    const blight = new Float32Array(ncols * nrows);
    for (let row = 0; row < nrows; row++) {
      for (let col = 0; col < ncols; col++) {
        const index = row * ncols + col;
        heights[index] = heightAtLattice(lattice.minGx + minCol + col, lattice.minGz + minRow + row);
        const masterCell = nearestMapFieldCell(baseField, lattice.minX + (minCol + col) * step, lattice.minZ + (minRow + row) * step);
        if (masterCell !== undefined) {
          const biomeIndex = baseField.biomeCell[masterCell];
          if (biomeIndex > 0 && baseField.biomeKinds[biomeIndex - 1] === "blight") blight[index] = 1;
        }
      }
    }
    tileKey = key;
    tile = Object.freeze({
      nrows,
      ncols,
      origin: [lattice.minX + minCol * step + ((ncols - 1) * step) / 2, 0, lattice.minZ + minRow * step + ((nrows - 1) * step) / 2],
      scale: [(ncols - 1) * step, 1, (nrows - 1) * step],
      heights,
      blight,
    });
    return tile;
  };

  return Object.freeze({
    terrainKey: `derived-${baseTopology.grid.gridId}`,
    mapDocHash,
    baseTopologyHash: baseTopology.topologyHash,
    layerHashes: Object.freeze(layerHashes),
    seaLevelM: baseField.seaLevelM,
    baseTopology,
    lattice,
    heightAtLattice,
    heightAt,
    denseTile,
  });
}

/** Live provider over the authority seams: resolves the CURRENT composed field from
 *  the project-state refs on every call, caching by content identity (MapDoc hash +
 *  ordered layer hashes + topology hash). The expensive master field is decoded once
 *  per MapDoc content hash (bounded to the 4 most recent); layer composition is
 *  cheap and tracks every committed stroke. Returns undefined when no derived
 *  authority is wired or no MapDoc is mounted — the legacy inert case. */
export function createDerivedComposedHeightProvider(seams) {
  const baseFields = new Map();
  let cached;
  const baseFieldFor = (mapDocRef, gridId) => {
    let field = baseFields.get(mapDocRef.hash);
    if (field === undefined) {
      field = compileDerivedBaseField(seams.readMapDoc(mapDocRef), gridId);
      baseFields.set(mapDocRef.hash, field);
      if (baseFields.size > 4) baseFields.delete(baseFields.keys().next().value);
    }
    return field;
  };
  const current = () => {
    if (seams.projectState === undefined || seams.resolveBaseTopology === undefined || seams.readMapDoc === undefined) {
      return undefined;
    }
    const mapDocRef = seams.projectState.state.refs.mapDoc;
    if (mapDocRef === null) return undefined;
    const baseTopology = parseTerrainEditBaseTopology(seams.resolveBaseTopology(mapDocRef));
    const layers = [];
    const layerKeys = [];
    for (const ref of seams.projectState.state.refs.terrainEditLayers) {
      // The live store holds ALREADY-PARSED layers (the deform/paint handlers put
      // them there); re-parsing per sampler call would re-hash the whole layer per
      // brush sample. Only fs-fallback content is validated here — readLayer's
      // contract is to return parseable layer content (a paint layer CANNOT parse
      // as a height layer, so a paint ref can never pose as heights even when both
      // stores missed it).
      let layer = seams.liveLayers?.get(ref.hash);
      if (layer === undefined) {
        // A paint-layer ref never contributes heights; its content lives in the
        // sibling store, so it is skipped WITHOUT a content read.
        if (seams.livePaintLayers?.has(ref.hash) === true) continue;
        const content = seams.readLayer?.(ref);
        if (content === undefined) {
          throw new Error(`derived composed-height: layer '${ref.layerId}' content (${ref.hash}) is unavailable to this host`);
        }
        layer = parseTerrainEditLayer(content);
      }
      layers.push(layer);
      layerKeys.push(ref.hash);
    }
    const key = `${mapDocRef.hash}|${baseTopology.topologyHash}|${layerKeys.join("|")}`;
    if (cached?.key === key) return cached.field;
    const field = createComposedHeightField({
      baseTopology,
      baseField: baseFieldFor(mapDocRef, baseTopology.grid.gridId),
      layers,
      mapDocHash: mapDocRef.hash,
    });
    cached = { key, field };
    return field;
  };
  return Object.freeze({ current });
}
