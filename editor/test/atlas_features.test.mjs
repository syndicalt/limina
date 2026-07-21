// Atlas feature authoring (water/line/stamp). Proves: the draw pipeline is a
// byte-faithful port (Chaikin×2 + decimate), rings close, stamps normalize, and
// water bodies validate through the REAL shared contract (water-ir.mjs) — a
// basin the compiler would reject fails here first, with its exact message.
// Falsifiability: a 2-point basin must fail; a duplicate id must fail; a broken
// smoothing port changes the expected point list below.

import assert from "node:assert/strict";
import test from "node:test";

import {
  chaikinOpen,
  closeRing,
  decimatePts,
  featureId,
  makeStamp,
  makeWaterBody,
  smoothDrawnPolyline,
  validateWaterBodies,
} from "../src/atlas/atlas-features.js";
import * as waterIr from "../../js/src/world/water-ir.mjs";

test("chaikinOpen/decimatePts are byte-faithful ports", () => {
  assert.deepEqual(chaikinOpen([[0, 0]]), [[0, 0]]);
  assert.deepEqual(chaikinOpen([[0, 0], [4, 0]]), [[0, 0], [4, 0]]);
  assert.deepEqual(
    chaikinOpen([[0, 0], [4, 0], [4, 4]]),
    [[0, 0], [1, 0], [3, 0], [4, 1], [4, 3], [4, 4]].map(([x, z]) => [x, z]),
  );
  assert.deepEqual(decimatePts([[0, 0], [1, 0], [9, 0], [10, 0]], 5), [[0, 0], [9, 0], [10, 0]]);
  const smoothed = smoothDrawnPolyline([[0, 0], [10, 0], [10, 10]], 2);
  assert.ok(smoothed.length > 3, "smoothing adds corners");
  assert.deepEqual(smoothed[0], [0, 0]);
  assert.deepEqual(smoothed[smoothed.length - 1], [10, 10]);
});

test("closeRing drops only the duplicate tail", () => {
  assert.deepEqual(closeRing([[0, 0], [4, 0], [4, 4], [0, 0]]), [[0, 0], [4, 0], [4, 4]]);
  assert.deepEqual(closeRing([[0, 0], [4, 0], [4, 4]]), [[0, 0], [4, 0], [4, 4]]);
  assert.deepEqual(closeRing([[0, 0], [4, 0]]), [[0, 0], [4, 0]], "too-short rings pass through");
});

test("makeStamp validates + rounds + keeps optional fields", () => {
  assert.deepEqual(makeStamp({ id: "st_1", assetId: "cottage", x: 100.4, z: -50.6, rot: 45, scale: 2 }),
    { id: "st_1", assetId: "cottage", x: 100, z: -51, rot: 45, scale: 2 });
  assert.deepEqual(makeStamp({ id: "st_2", assetId: "tree", x: 1, z: 2 }), { id: "st_2", assetId: "tree", x: 1, z: 2 });
  assert.throws(() => makeStamp({ id: "st_3", assetId: "", x: 0, z: 0 }), TypeError);
  assert.notEqual(featureId("ln"), featureId("ln"), "feature ids are unique");
});

test("makeWaterBody validates through the shared contract", () => {
  const body = makeWaterBody(waterIr, {
    id: "wb_1", kind: "lake", level: 0,
    ring: [[0, 0], [400, 0], [400, 300], [0, 300]],
    depthM: 8,
  });
  assert.equal(body.kind, "lake");
  assert.equal(body.depthZones.length, 2);
  assert.equal(body.depthZones[0].minShoreDistanceM, 0, "depth zones start at the shoreline");
  // The full-set validator accepts it.
  const validated = validateWaterBodies(waterIr, [body]);
  assert.equal(validated.length, 1);
  // A 2-point basin fails BEFORE the compiler ever sees it.
  assert.throws(() => makeWaterBody(waterIr, { id: "wb_2", kind: "lake", level: 0, ring: [[0, 0], [10, 0]] }), /at least 3 points/);
  // Duplicate ids fail through the contract's own message.
  assert.throws(() => validateWaterBodies(waterIr, [body, structuredClone(body)]), /duplicate id/);
  // A bad kind fails the contract.
  const bad = { ...body, kind: "ocean" };
  assert.throws(() => validateWaterBodies(waterIr, [bad]), /kind/);
});
