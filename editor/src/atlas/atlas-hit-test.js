// Atlas hit-testing (2.0-A select/lasso): pure world-space geometry for picking
// line features, stamp anchors, and water-body polygons. Tolerances are in
// meters (world units), never pixels — a pick works identically at every zoom.

/** Min distance from point p to polyline `points` ([x,z] pairs), meters. */
export function distToPolyline(px, pz, points) {
  if (!Array.isArray(points) || points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(px - points[0][0], pz - points[0][1]);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
    best = Math.min(best, Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz)));
  }
  return best;
}

/** Ray-cast point-in-polygon over a closed ring ([x,z] pairs, no repeated tail). */
export function pointInPolygon(px, pz, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point p to a ring's boundary (for outline picking), meters. */
export function distToRing(px, pz, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return Infinity;
  const closed = [...ring, ring[0]];
  return distToPolyline(px, pz, closed);
}

/** The best hit under a world point, or null. Stamps and water-body outlines
 *  win within their pick radius; filled water bodies win on containment; lines
 *  win within the line tolerance. */
export function hitTest(px, pz, { features = [], stamps = [], waterBodies = [] }, { stampRadiusM = 12, lineToleranceM = 8 } = {}) {
  // Two tiers. Point/edge picks — stamps, water OUTLINES, lines — compete on real
  // distance. A filled-water CONTAINMENT hit is only an AREA fallback, taken when no
  // point/edge pick claimed the point; otherwise a lake fill steals every stamp, line,
  // or shoreline click inside its basin (it previously forced distance 0, beating any
  // stamp at distance > 0, so a stamp inside a lake could never be selected).
  let best = null;
  let bestDist = Infinity;
  const consider = (candidate, d) => {
    if (d < bestDist) { best = candidate; bestDist = d; }
  };
  for (const stamp of stamps) {
    const d = Math.hypot(px - stamp.x, pz - stamp.z);
    if (d <= stampRadiusM) consider({ kind: "stamp", id: stamp.id, item: stamp }, d);
  }
  let containing = null;
  for (const body of waterBodies) {
    const ring = body.footprint?.points ?? [];
    const edge = distToRing(px, pz, ring);
    if (edge <= lineToleranceM) {
      consider({ kind: "waterBody", id: body.id, item: body }, edge);
    } else if (containing === null && pointInPolygon(px, pz, ring)) {
      containing = { kind: "waterBody", id: body.id, item: body };
    }
  }
  for (const feature of features) {
    if (feature.type !== "line") continue;
    const d = distToPolyline(px, pz, feature.points);
    if (d <= lineToleranceM) consider({ kind: "feature", id: feature.id, item: feature }, d);
  }
  // Area fallback: containment only counts when no point/edge pick was found.
  return best ?? containing;
}

/** Everything a lasso rect contains (for bulk delete): feature lines with ANY
 *  point inside, stamps inside, water bodies with ANY ring point inside. */
export function lassoHits(x0, z0, x1, z1, { features = [], stamps = [], waterBodies = [] }) {
  const [minX, maxX] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [minZ, maxZ] = [Math.min(z0, z1), Math.max(z0, z1)];
  const inRect = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  return {
    features: features.filter((f) => f.type === "line" && (f.points ?? []).some(([x, z]) => inRect(x, z))).map((f) => f.id),
    stamps: stamps.filter((s) => inRect(s.x, s.z)).map((s) => s.id),
    waterBodies: waterBodies.filter((b) => (b.footprint?.points ?? []).some(([x, z]) => inRect(x, z))).map((b) => b.id),
  };
}
