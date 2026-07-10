import test from "node:test";
import assert from "node:assert/strict";
import { createWorldMapToMapDocTransform } from "./map-coordinate-conversion.js";

test("WorldMap import converts source local through world into target MapDoc local", () => {
  const transform = createWorldMapToMapDocTransform({
    unitsPerMeter: 2,
    origin: [100, -50],
  }, { kind: "m", unitsPerMeter: 4, origin: [90, -60] });
  assert.deepEqual(transform.point([0, 0]), [40, 40]);
  assert.deepEqual(transform.point([5, 5]), [80, 80]);
  assert.deepEqual(transform.point([10, 10]), [120, 120]);
  assert.deepEqual(transform.rect({ x0: 0, z0: 0, w: 10, h: 10 }), { x0: 40, z0: 40, w: 80, h: 80 });
  assert.equal(transform.metersToTargetLength(200), 800);
  assert.equal(transform.targetUnitsPerMeter, 4);
});

test("WorldMap import rejects malformed source or target frames", () => {
  assert.throws(() => createWorldMapToMapDocTransform({ unitsPerMeter: 0, origin: [0, 0] }), /coordinate frames/);
  assert.throws(() => createWorldMapToMapDocTransform({}, { kind: "km", unitsPerMeter: 1, origin: [0, 0] }), /coordinate frames/);
  assert.throws(() => createWorldMapToMapDocTransform({}).metersToTargetLength(-1), /length/);
});
