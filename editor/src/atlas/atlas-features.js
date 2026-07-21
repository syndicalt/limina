// Atlas feature authoring (Editor 2.0): water bodies, line features, and stamp
// anchors. Smoothing/decimation are byte-faithful ports of the original
// frontend (map.js:2539-2566); water bodies are validated by the SHARED engine
// contract (water-ir.mjs, injected like the raster codec) so an authored basin
// can never drift from what the compiler accepts.

/** Chaikin corner-cut, one pass, open polyline (verbatim port). */
export function chaikinOpen(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    out.push(
      [x1 * 0.75 + x2 * 0.25, z1 * 0.75 + z2 * 0.25],
      [x1 * 0.25 + x2 * 0.75, z1 * 0.25 + z2 * 0.75],
    );
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Drop points closer than minD to their kept predecessor (verbatim port). */
export function decimatePts(pts, minD) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= minD) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The original draw-release pipeline: two Chaikin passes, then decimate. */
export function smoothDrawnPolyline(pts, minSpacingM) {
  if (!Array.isArray(pts) || pts.length < 2) return pts;
  return decimatePts(chaikinOpen(chaikinOpen(pts)), minSpacingM);
}

/** Close a drawn polyline into a simple polygon ring (drop the duplicate tail). */
export function closeRing(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return pts;
  const out = pts.map(([x, z]) => [x, z]);
  const [fx, fz] = out[0];
  const [lx, lz] = out[out.length - 1];
  if (Math.hypot(lx - fx, lz - fz) < 1e-9) out.pop();
  return out;
}

let featureSeq = 0;
export function featureId(prefix) {
  featureSeq += 1;
  return `${prefix}_${featureSeq.toString(36)}`;
}

/** Construct + validate one authored water body against the shared contract.
 *  `waterIr` is the injected /shared/water-ir.mjs module (parseAuthoredWaterBodies).
 *  Throws WaterIrValidationError-shaped errors — the surface toasts them verbatim
 *  (the contract's messages name the exact offending path). */
export function makeWaterBody(waterIr, { id, kind, level, ring, depthM = 6 }) {
  if (typeof waterIr?.parseAuthoredWaterBodies !== "function") {
    throw new TypeError("makeWaterBody requires the shared water-ir module");
  }
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error("a basin needs at least 3 points — draw a bigger outline");
  }
  const candidate = [{
    id,
    kind,
    level,
    footprint: { points: ring.map(([x, z]) => [Math.round(x), Math.round(z)]), holes: [] },
    depthZones: [
      { minShoreDistanceM: 0, maxShoreDistanceM: depthM * 2, depthM },
      { minShoreDistanceM: depthM * 2, maxShoreDistanceM: depthM * 6, depthM: depthM * 3 },
    ],
  }];
  // Validate the constructed body itself (shape/topology/limits).
  validateWaterBodies(waterIr, candidate);
  return candidate[0];
}

/** Validate a complete waterBodies array through the shared contract. */
export function validateWaterBodies(waterIr, bodies) {
  return waterIr.parseAuthoredWaterBodies(bodies);
}

/** One stamp anchor (matches the compiler's stamp IR: id/assetId/x/z/rot?/scale?). */
export function makeStamp({ id, assetId, x, z, rot, scale }) {
  if (typeof assetId !== "string" || assetId.length === 0) throw new TypeError("stamp assetId must be a non-empty string");
  const stamp = { id, assetId, x: Math.round(x), z: Math.round(z) };
  if (rot !== undefined) stamp.rot = rot;
  if (scale !== undefined) stamp.scale = scale;
  return stamp;
}
