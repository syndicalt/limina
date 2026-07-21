import { smoothRiverPresentationReach } from "../src/world/river-presentation-curve.mjs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_river_presentation_curve FAIL: ${message}`);
}
const reach = {
  id: "gen-r-a-b", class: "river", order: 4,
  points: [[0, 0], [0, 3], [3, 3], [3, 6]], widths: [2, 3, 4, 5],
  terrainElevationsM: [0, -1, -2, -3], surfaceElevationsM: [2, 1.5, 1, 0.5], waterfalls: [],
};
const first = smoothRiverPresentationReach(reach), repeat = smoothRiverPresentationReach(reach);
assert(first.presentationSmoothing.algorithm === "chaikin-bounded/v1" && first.presentationSmoothing.iterations === 2,
  "presentation curve did not publish its bounded algorithm identity");
assert(first.points.length === 16 && JSON.stringify(first) === JSON.stringify(repeat),
  "two smoothing passes were not deterministic or bounded to four times the source samples");
assert(JSON.stringify(first.points[0]) === JSON.stringify(reach.points[0])
  && JSON.stringify(first.points.at(-1)) === JSON.stringify(reach.points.at(-1)),
  "presentation smoothing moved a reach junction endpoint");
assert(first.widths[0] === 2 && first.widths.at(-1) === 5
  && first.surfaceElevationsM[0] === 2 && first.surfaceElevationsM.at(-1) === 0.5,
  "presentation smoothing changed endpoint width/elevation authority");
assert(first.points.some((point: number[]) => point[0] > 0 && point[0] < 3 && point[1] > 2 && point[1] < 4),
  "presentation smoothing retained the grid-step right-angle corner");
const none = smoothRiverPresentationReach(reach, 0);
assert(JSON.stringify(none.points) === JSON.stringify(reach.points), "zero-iteration projection changed source points");
console.log(`p_river_presentation_curve OK: ${reach.points.length} lattice points -> ${first.points.length} bounded smooth samples with exact junction endpoints`);
