// Deterministic presentation projection for lattice-derived river reaches. Gameplay/hydrology
// authority remains the original polyline; rendering, shoreline masks, and vegetation exclusion
// consume this bounded corner-cut curve so their shared visible bank is not a staircase.

import { WATER_LIMITS } from "./water-ir.mjs";

function interpolate(a, b, t) {
  return {
    point: [a.point[0] + (b.point[0] - a.point[0]) * t, a.point[1] + (b.point[1] - a.point[1]) * t],
    width: a.width + (b.width - a.width) * t,
    terrain: a.terrain + (b.terrain - a.terrain) * t,
    surface: a.surface + (b.surface - a.surface) * t,
  };
}

/** Two Chaikin passes remove grid-step corners without overshoot. Endpoints are preserved exactly
 * so independently compiled reaches still meet at their hydrology junctions. */
export function smoothRiverPresentationReach(reach, requestedIterations = 2) {
  if (reach === null || typeof reach !== "object" || !Array.isArray(reach.points)
      || !Array.isArray(reach.widths) || !Array.isArray(reach.terrainElevationsM)
      || !Array.isArray(reach.surfaceElevationsM) || reach.points.length < 2
      || reach.widths.length !== reach.points.length || reach.terrainElevationsM.length !== reach.points.length
      || reach.surfaceElevationsM.length !== reach.points.length) {
    throw new TypeError("river presentation smoothing requires aligned verified reach arrays");
  }
  if (!Number.isSafeInteger(requestedIterations) || requestedIterations < 0 || requestedIterations > 4) {
    throw new RangeError("river presentation smoothing iterations must be an integer in [0,4]");
  }
  let samples = reach.points.map((point, index) => ({
    point: [point[0], point[1]], width: reach.widths[index],
    terrain: reach.terrainElevationsM[index], surface: reach.surfaceElevationsM[index],
  }));
  let iterations = 0;
  while (iterations < requestedIterations && samples.length * 2 <= WATER_LIMITS.waterwayPoints) {
    const next = [samples[0]];
    for (let index = 0; index < samples.length - 1; index++) {
      next.push(interpolate(samples[index], samples[index + 1], 0.25));
      next.push(interpolate(samples[index], samples[index + 1], 0.75));
    }
    next.push(samples[samples.length - 1]);
    samples = next; iterations++;
  }
  return Object.freeze({
    ...reach,
    points: Object.freeze(samples.map((sample) => Object.freeze(sample.point))),
    widths: Object.freeze(samples.map((sample) => sample.width)),
    terrainElevationsM: Object.freeze(samples.map((sample) => sample.terrain)),
    surfaceElevationsM: Object.freeze(samples.map((sample) => sample.surface)),
    presentationSmoothing: Object.freeze({ algorithm: "chaikin-bounded/v1", iterations, sourcePoints: reach.points.length }),
  });
}
