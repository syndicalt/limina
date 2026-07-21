// Atlas hit-testing (2.0-A). Proves: polyline distance, point-in-polygon, ring
// distance, pick priority (stamp < contained water < edge water < line), and
// lasso bulk selection. Falsifiability: a hit-test that returned the wrong kind
// or missed containment fails these exact coordinates.

import assert from "node:assert/strict";
import test from "node:test";

import { distToPolyline, distToRing, hitTest, lassoHits, pointInPolygon } from "../src/atlas/atlas-hit-test.js";

test("distToPolyline: endpoints, segments, single point", () => {
  assert.equal(distToPolyline(5, 5, [[0, 0], [10, 0]]), 5);
  assert.equal(distToPolyline(0, 5, [[0, 0], [10, 0]]), 5);
  assert.equal(distToPolyline(20, 0, [[0, 0], [10, 0]]), 10);
  assert.equal(distToPolyline(3, 3, [[7, 7]]), Math.hypot(4, 4));
  assert.equal(distToPolyline(0, 0, []), Infinity);
  // Projection clamps to segment ends, not the infinite line.
  assert.equal(distToPolyline(-3, 4, [[0, 0], [10, 0]]), 5);
});

test("pointInPolygon: inside/outside/vertex-adjacent", () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(pointInPolygon(50, 50, square), true);
  assert.equal(pointInPolygon(150, 50, square), false);
  assert.equal(pointInPolygon(50, -1, square), false);
  assert.equal(pointInPolygon(0, 0, []), false);
  const triangle = [[0, 0], [200, 0], [100, 180]];
  assert.equal(pointInPolygon(100, 60, triangle), true);
  assert.equal(pointInPolygon(10, 170, triangle), false);
});

test("distToRing measures the closed boundary", () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(distToRing(50, -10, square), 10);
  assert.equal(distToRing(50, 110, square), 10);
  assert.equal(distToRing(50, 50, square), 50);
});

test("hitTest: pick priority and kinds", () => {
  const world = {
    features: [{ id: "ln1", type: "line", points: [[0, 0], [200, 0]], color: "#fff" }],
    stamps: [{ id: "st1", assetId: "pine", x: 50, z: 40 }],
    waterBodies: [{ id: "wb1", kind: "lake", footprint: { points: [[300, 300], [400, 300], [400, 400], [300, 400]], holes: [] } }],
  };
  assert.deepEqual(hitTest(52, 42, world)?.kind, "stamp");
  assert.deepEqual(hitTest(350, 350, world)?.kind, "waterBody", "contained water body");
  assert.deepEqual(hitTest(350, 294, world)?.kind, "waterBody", "near water outline");
  assert.deepEqual(hitTest(100, 4, world)?.kind, "feature");
  assert.equal(hitTest(100, 40, world), null, "nothing in range");
});

test("hitTest: a point feature inside a water body is still selectable", () => {
  // Regression: filled-water containment used to force distance 0, so it beat any
  // stamp/line inside the basin — the lake stole the click and Delete removed the lake.
  const world = {
    features: [{ id: "ln1", type: "line", points: [[320, 350], [380, 350]] }],
    stamps: [{ id: "st1", assetId: "cottage", x: 350, z: 350 }],
    waterBodies: [{ id: "wb1", kind: "lake", footprint: { points: [[300, 300], [400, 300], [400, 400], [300, 400]], holes: [] } }],
  };
  // Deep inside the lake, right on the stamp: the STAMP must win, not the lake fill.
  assert.deepEqual(hitTest(350, 350, world)?.id, "st1", "stamp inside lake wins over fill");
  // On the interior line, away from the stamp: the LINE must win over the fill.
  assert.deepEqual(hitTest(360, 350, world)?.kind, "feature", "line inside lake wins over fill");
  // Empty interior water still selects the body by containment.
  assert.deepEqual(hitTest(320, 380, world)?.id, "wb1", "empty interior still hits the body");
});

test("lassoHits selects by any-point-inside", () => {
  const world = {
    features: [
      { id: "ln1", type: "line", points: [[0, 0], [50, 50]] },
      { id: "ln2", type: "line", points: [[500, 500], [600, 600]] },
    ],
    stamps: [{ id: "st1", x: 25, z: 25 }, { id: "st2", x: 550, z: 550 }],
    waterBodies: [
      { id: "wb1", footprint: { points: [[10, 10], [20, 10], [20, 20]], holes: [] } },
      { id: "wb2", footprint: { points: [[500, 500], [510, 500], [510, 510]], holes: [] } },
    ],
  };
  const hits = lassoHits(-10, -10, 100, 100, world);
  assert.deepEqual(hits.features, ["ln1"]);
  assert.deepEqual(hits.stamps, ["st1"]);
  assert.deepEqual(hits.waterBodies, ["wb1"]);
});
