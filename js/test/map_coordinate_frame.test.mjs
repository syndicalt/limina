import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MAP_WORLD_COORDINATE_M,
  MapCoordinateFrameError,
  mapLocalRectToWorld,
  mapLocalToWorld,
  mapMetersToLocalLength,
  mapWorldToLocal,
  parseMapCoordinateFrame,
} from "../src/world/map-coordinate-frame.mjs";

const frame = (unitsPerMeter = 2, origin = [100, -50]) => ({ kind: "m", unitsPerMeter, origin });

test("MapDoc local/world transforms implement units-per-metre affine semantics", () => {
  assert.deepEqual(mapLocalToWorld(frame(), [20, -10]), [110, -55]);
  assert.deepEqual(mapWorldToLocal(frame(), [110, -55]), [20, -10]);
  assert.deepEqual(mapLocalToWorld(frame(0.5, [-4, 8]), [3, 4]), [2, 16]);
  assert.equal(mapMetersToLocalLength(frame(), 12), 24);
  assert.deepEqual(mapLocalRectToWorld(frame(), { x0: 20, z0: -10, w: 40, h: 20 }), {
    x0: 110, z0: -55, w: 20, h: 10,
  });
});

test("outputs are frozen and normalize negative zero", () => {
  const parsed = parseMapCoordinateFrame(frame(1, [-0, 0]));
  const world = mapLocalToWorld(parsed, [-0, 0]);
  const local = mapWorldToLocal(parsed, [-0, 0]);
  assert.equal(Object.is(parsed.origin[0], -0), false);
  assert.equal(Object.is(world[0], -0), false);
  assert.equal(Object.is(local[0], -0), false);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.origin), true);
  assert.equal(Object.isFrozen(world), true);
});

test("frame and tuple validation rejects hostile or noncanonical data", () => {
  for (const units of [
    { kind: "km", unitsPerMeter: 1, origin: [0, 0] },
    { kind: "m", unitsPerMeter: 0, origin: [0, 0] },
    { kind: "m", unitsPerMeter: -1, origin: [0, 0] },
    { kind: "m", unitsPerMeter: Infinity, origin: [0, 0] },
    { kind: "m", unitsPerMeter: Number.MIN_VALUE, origin: [0, 0] },
    { kind: "m", unitsPerMeter: 1, origin: [0, 0], extra: true },
    Object.assign(Object.create(null), { kind: "m", unitsPerMeter: 1, origin: [0, 0] }),
  ]) assert.throws(() => parseMapCoordinateFrame(units), MapCoordinateFrameError);

  const sparse = new Array(2); sparse[0] = 1;
  assert.throws(() => mapLocalToWorld(frame(), sparse), /dense/);
  const custom = [1, 2]; custom.extra = 3;
  assert.throws(() => mapLocalToWorld(frame(), custom), /dense/);

  let invoked = false;
  const accessor = frame();
  Object.defineProperty(accessor, "origin", { enumerable: true, get() { invoked = true; return [0, 0]; } });
  assert.throws(() => parseMapCoordinateFrame(accessor), /data field/);
  assert.equal(invoked, false);
});

test("world bounds, overflow, cancellation, and collapsed rects fail closed", () => {
  assert.deepEqual(
    mapLocalToWorld(frame(1, [MAX_MAP_WORLD_COORDINATE_M - 1, 0]), [1, 0]),
    [MAX_MAP_WORLD_COORDINATE_M, 0],
  );
  assert.throws(() => mapLocalToWorld(frame(1, [MAX_MAP_WORLD_COORDINATE_M, 0]), [1, 0]), /range/);
  assert.throws(() => mapWorldToLocal(frame(), [MAX_MAP_WORLD_COORDINATE_M + 1, 0]), /range/);
  assert.throws(() => mapMetersToLocalLength(frame(Number.MAX_VALUE, [0, 0]), 2), /finite/);
  assert.throws(() => mapLocalToWorld(frame(1e308, [MAX_MAP_WORLD_COORDINATE_M, 0]), [1, 0]), /loses precision/);
  assert.throws(
    () => mapLocalRectToWorld(frame(1e308, [MAX_MAP_WORLD_COORDINATE_M, 0]), { x0: 0, z0: 0, w: 1, h: 1 }),
    /loses precision|positive extent/,
  );
});

test("rect validation is exact-shape and preserves fractional precision", () => {
  const result = mapLocalRectToWorld(frame(4, [0.25, -0.5]), { x0: 0.5, z0: 1.5, w: 0.25, h: 0.5 });
  assert.deepEqual(result, { x0: 0.375, z0: -0.125, w: 0.0625, h: 0.125 });
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => mapLocalRectToWorld(frame(), { x0: 0, z0: 0, w: 1, h: 1, extra: 0 }), /fields/);
  assert.throws(() => mapLocalRectToWorld(frame(), { x0: 0, z0: 0, w: -1, h: 1 }), /positive/);
});
