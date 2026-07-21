// Atlas stage renderer (Editor 2.0): composite the live paint rasters into an
// offscreen canvas, then blit through the 2D camera. The shared-coast rule is
// load-bearing: the compiler emits OUTER coast loops only, so an ocean pocket
// fully enclosed by land compiles AS LAND — the preview must show it as land,
// or the user paints a coast the compiler will not reproduce
// (the retired SPA's map-paint.js:199-201 made the same rule).

const SEA = [63, 110, 165]; // #3f6ea5 — matches the original sea
const LAND = [154, 168, 95]; // #9aa85f — matches the original grass-land
const BIOME_TINTS = [
  null, // 0 = unpainted
  [138, 168, 95], // grass
  [74, 122, 69], // forest
  [143, 141, 136], // mountain
  [217, 196, 143], // desert
  [219, 228, 234], // tundra
  [107, 122, 85], // swamp
  [63, 110, 165], // water
  [107, 106, 102], // blight
];

/** Ocean cells reachable from the raster border (flood fill, 4-neighbour).
 *  Cells below land threshold NOT reachable are enclosed pockets = land. */
export function borderOcean(cells, w, h, threshold = 128) {
  const ocean = new Uint8Array(cells.length);
  const queue = [];
  const push = (i) => {
    if (ocean[i] === 0 && cells[i] < threshold) {
      ocean[i] = 1;
      queue.push(i);
    }
  };
  for (let c = 0; c < w; c++) { push(c); push((h - 1) * w + c); }
  for (let r = 0; r < h; r++) { push(r * w); push(r * w + w - 1); }
  while (queue.length > 0) {
    const i = queue.pop();
    const c = i % w;
    const r = (i - c) / w;
    if (c > 0) push(i - 1);
    if (c < w - 1) push(i + 1);
    if (r > 0) push(i - w);
    if (r < h - 1) push(i + w);
  }
  return ocean;
}

/** Nearest-cell sample of a layer in WORLD coordinates, or undefined when the
 *  point falls outside the layer's rect. Layers do not share frames: landmass,
 *  elevation, and biomes each carry their own rect/resolution, so the composite
 *  must sample by world position, never by shared index. */
function sampleLayer(layer, wx, wz) {
  const { rect } = layer;
  if (wx < rect.x0 || wz < rect.z0 || wx >= rect.x0 + rect.w || wz >= rect.z0 + rect.h) return undefined;
  const c = Math.min(layer.w - 1, Math.floor(((wx - rect.x0) / rect.w) * layer.w));
  const r = Math.min(layer.h - 1, Math.floor(((wz - rect.z0) / rect.h) * layer.h));
  return layer.cells[r * layer.w + c];
}

/** Composite the visible layers into `out` (an ImageData-sized Uint8ClampedArray).
 *  layers: { landmass?, elevation?, biomes?, seaLevel } — any may be hidden. */
export function compositeRasters({ landmass, elevation, biomes, seaLevel = 0, showBiomes = true }) {
  if (landmass === undefined) throw new TypeError("compositeRasters requires the landmass layer");
  const { w, h, rect } = landmass;
  const ocean = borderOcean(landmass.cells, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  const elevRange = elevation !== undefined ? elevation.maxY - elevation.minY : 1;
  const cellW = rect.w / (w - 1);
  const cellH = rect.h / (h - 1);
  for (let row = 0; row < h; row++) {
    const wz = rect.z0 + row * cellH;
    for (let col = 0; col < w; col++) {
      const wx = rect.x0 + col * cellW;
      const i = row * w + col;
      const isSea = ocean[i] === 1;
      let r;
      let g;
      let b;
      if (isSea) {
        [r, g, b] = SEA;
      } else {
        [r, g, b] = LAND;
        // Elevation shading: gentle height-tinted relief over the land fill.
        if (elevation !== undefined) {
          const ev = sampleLayer(elevation, wx, wz);
          if (ev !== undefined) {
            const t = (ev / 65535) * elevRange + elevation.minY;
            const shade = Math.max(-24, Math.min(40, t * 0.006));
            r = Math.max(0, Math.min(255, r + shade));
            g = Math.max(0, Math.min(255, g + shade));
            b = Math.max(0, Math.min(255, b + shade));
            if (t < seaLevel) {
              // Below-sea cells inside the land mask read as shallow water — the
              // display and the compiler share this one rule.
              const mix = Math.min(1, (seaLevel - t) / 12);
              r = r * (1 - mix) + SEA[0] * mix;
              g = g * (1 - mix) + SEA[1] * mix;
              b = b * (1 - mix) + SEA[2] * mix;
            }
          }
        }
        if (showBiomes && biomes !== undefined) {
          const cls = sampleLayer(biomes, wx, wz);
          if (cls !== undefined && cls > 0) {
            const tint = BIOME_TINTS[cls];
            if (tint !== null && tint !== undefined) {
              r = r * 0.45 + tint[0] * 0.55;
              g = g * 0.45 + tint[1] * 0.55;
              b = b * 0.45 + tint[2] * 0.55;
            }
          }
        }
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
  }
  return { pixels: out, w, h };
}
