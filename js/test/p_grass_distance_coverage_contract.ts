import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { GRASS_FIELD_MAX_RESIDENT_SLOTS } from "../src/render/grass-field-plan.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_grass_distance_coverage_contract FAIL: ${message}`);
}

function smoothstep(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic");
const band = profile.additionalContinuousBands?.find((entry) => entry.id === "mid-cluster");
const proxy = profile.farSurfaceProxy;
assert(band !== undefined && proxy !== undefined, "cinematic meadow must declare geometry and surface distance bands");

const tileSize = 48, primaryCellSize = tileSize / 6;
// The representation boundary is controlled by fineRadius, not the outer residency radius. For a
// camera anywhere inside its anchor cell, the shortest distance to the outer edge of the fine ring
// is fineRadius*cellSize. The prior radius-based assertion passed while the 3x3 fine ring changed
// from 260 independent blades/m2 to clustered LOD1 with LOD0 still about 91% opaque.
const primaryGuaranteedReach = profile.fineRadius * primaryCellSize;
const midRegisteredReach = band.radius * (tileSize / band.cellSizeDivisor);
assert(profile.fineRadius === profile.radius,
  "cinematic primary residency retains a visible near/mid representation ring");
assert(primaryGuaranteedReach >= profile.lod[0].fade!.end,
  `near representation ends before its material fade (${primaryGuaranteedReach} < ${profile.lod[0].fade!.end})`);
const primaryWindowCells = (profile.fineRadius * 2 + 1) ** 2;
const primaryWorstCaseBlades = primaryWindowCells * primaryCellSize ** 2 * profile.bladesPerSquareMeter[0];
assert(primaryWorstCaseBlades <= profile.maxResidentBlades,
  `gap-free near residency exceeds its blade budget (${primaryWorstCaseBlades} > ${profile.maxResidentBlades})`);
const primarySpacing = Math.sqrt(profile.bladesPerInstance[0] / profile.bladesPerSquareMeter[0]);
const primaryWorstCaseSlots = primaryWindowCells * Math.ceil(primaryCellSize / primarySpacing) ** 2;
assert(primaryWorstCaseSlots <= GRASS_FIELD_MAX_RESIDENT_SLOTS,
  `gap-free near residency exceeds its fixed-slot ceiling (${primaryWorstCaseSlots} > ${GRASS_FIELD_MAX_RESIDENT_SLOTS})`);
assert(band.fadeIn.start <= primaryGuaranteedReach,
  `mid geometry starts after guaranteed near coverage (${band.fadeIn.start} > ${primaryGuaranteedReach})`);
assert(proxy.fadeIn.start < band.fadeOut.start && proxy.fadeIn.end <= band.fadeOut.end,
  "far surface proxy does not overlap mid geometry before its retirement");
assert(band.fadeOut.end - band.fadeOut.start >= 12,
  "cinematic physical grass retirement is too compressed to read as a gradual LOD handoff");
assert(midRegisteredReach >= band.fadeIn.end,
  "mid geometry residency cannot cover its fade-in interval");
assert(midRegisteredReach >= band.fadeOut.end,
  "mid geometry residency ends before its material fade-out completes");
assert(proxy.coverageEnd >= 1_000, "far surface proxy does not continue to a horizon-scale distance");

// Coverage is evaluated as projected silhouette saturation, not the maximum of fade weights.
// A band can have a mathematically smooth fade and still look empty when its instances carry too
// little leaf area. The near coefficient is the measured mean blade silhouette at 260 blades/m2;
// the far coefficient is the reviewed, density-aware terrain proxy signal.
const nearProjectedCoverage = 1.133;
const farProjectedCoverage = 0.85;
let previousSaturation: number | undefined;
let previousMidWeight: number | undefined;
let weakestRejectedHandoffSaturation = 1;
for (let distance = 0; distance <= 192; distance += 0.25) {
  const primary = distance <= primaryGuaranteedReach
    ? 1 - smoothstep(profile.lod[0].fade!.start, profile.lod[0].fade!.end, distance) : 0;
  const mid = smoothstep(band.fadeIn.start, band.fadeIn.end, distance)
    * (1 - smoothstep(band.fadeOut.start, band.fadeOut.end, distance));
  const far = distance <= proxy.coverageEnd ? smoothstep(proxy.fadeIn.start, proxy.fadeIn.end, distance) : 0;
  const projectedCoverage = nearProjectedCoverage * primary
    + band.targetProjectedCoverage * mid + farProjectedCoverage * far;
  const saturation = 1 - Math.exp(-projectedCoverage);
  assert(saturation >= 0.55,
    `projected grass saturation falls below the reviewed floor at ${distance.toFixed(2)}m (${saturation.toFixed(3)})`);
  if (previousSaturation !== undefined) {
    assert(Math.abs(saturation - previousSaturation) <= 0.15,
      `projected grass saturation jumps at ${distance.toFixed(2)}m (${previousSaturation.toFixed(3)} -> ${saturation.toFixed(3)})`);
  }
  if (previousMidWeight !== undefined) {
    assert(previousMidWeight - mid <= 0.032,
      `physical grass retires too abruptly at ${distance.toFixed(2)}m (${previousMidWeight.toFixed(3)} -> ${mid.toFixed(3)})`);
  }
  previousSaturation = saturation;
  previousMidWeight = mid;

  // Falsifiability: replay the rejected handoff, where quarter-density explicit geometry was left
  // alone until a delayed 24m surface proxy. The production proxy now starts underneath the
  // physical band at 8m, so simply lowering geometry density no longer recreates a visible hole.
  if (distance >= band.fadeIn.end && distance < 24) {
    const rejectedFar = smoothstep(24, 48, distance);
    const rejectedCoverage = nearProjectedCoverage * primary
      + band.targetProjectedCoverage * 0.25 * mid + farProjectedCoverage * rejectedFar;
    weakestRejectedHandoffSaturation = Math.min(weakestRejectedHandoffSaturation,
      1 - Math.exp(-rejectedCoverage));
  }
}
assert(weakestRejectedHandoffSaturation < 0.55,
  "distance gate is insensitive to the rejected sparse-geometry/delayed-proxy handoff");

console.log(`p_grass_distance_coverage_contract OK: projected silhouette saturation stays continuous across independent blades (0-${primaryGuaranteedReach}m), clustered geometry (${band.fadeIn.start}-${band.fadeOut.end}m), and the density-aware surface proxy (to ${proxy.coverageEnd}m)`);
