import { carveGeneratedRiverChannels, RIVER_CHANNEL_CARVE_POLICY_VERSION } from "../src/world/river-channel-carve.mjs";

const assert = (value: boolean, message: string): void => { if (!value) throw new Error(`p_river_channel_carve FAIL: ${message}`); };
const rows = 21, cols = 21, heightsM = new Float64Array(rows * cols).fill(12);
const input = { rows, cols, cellSizeM: 1, originX: 0, originZ: 0, heightsM, reaches: [{
  points: [[2, 10], [18, 10]], widths: [4, 4], surfaceElevationsM: [10, 8],
}] };
const first = carveGeneratedRiverChannels(input), second = carveGeneratedRiverChannels(input);
assert(first.diagnostics.policyVersion === RIVER_CHANNEL_CARVE_POLICY_VERSION && first.diagnostics.carvedSamples > 0
  && first.diagnostics.bankSamples > 0 && first.diagnostics.maxCutDepthM >= 2,
"carve did not cut a bed and blended banks below the sloping water surface");
assert(JSON.stringify([...first.heightsM]) === JSON.stringify([...second.heightsM]), "same reach did not carve deterministically");
assert([...heightsM].every((height) => height === 12), "carve mutated the authoritative input field");
assert(first.heightsM[10 * cols + 10] < first.heightsM[7 * cols + 10], "channel center is not lower than its outer bank");
assert(first.heightsM[10 * cols + 10] < 9 && first.heightsM[0] === 12, "bed is not submerged or distant terrain changed");
for (let index = 0; index < heightsM.length; index++) assert(first.heightsM[index] <= heightsM[index], "carve raised terrain");
console.log("p_river_channel_carve OK: exact reaches cut deterministic submerged beds and smooth banks without raising or mutating authority terrain");
