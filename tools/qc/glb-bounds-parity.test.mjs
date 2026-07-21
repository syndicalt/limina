import assert from "node:assert/strict";
import test from "node:test";

import { measureGlb } from "../../gates/design/asset-qc-gate.mjs";
import { inspectFurnitureGlb } from "../architecture/glb-runtime-geometry.mjs";
import { glbBbox } from "./asset-sanity.mjs";

function jsonGlb(document) {
  const encoded = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = (encoded.length + 3) & ~3;
  const bytes = Buffer.alloc(12 + 8 + paddedLength, 0x20);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(bytes, 20);
  return bytes;
}

function assertVectorClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} arity`);
  for (let axis = 0; axis < expected.length; axis++) {
    assert.ok(
      Math.abs(actual[axis] - expected[axis]) < 1e-9,
      `${label}[${axis}] expected ${expected[axis]}, got ${actual[axis]}`,
    );
  }
}

test("general and furniture GLB inspectors agree on nested transformed bounds", () => {
  const halfSqrt = Math.SQRT1_2;
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        extras: { "limina.id": "furniture/test" },
        translation: [10, 2, -3],
        rotation: [0, 0, halfSqrt, halfSqrt],
        scale: [2, 3, 1],
        children: [1],
      },
      {
        extras: { "limina.id": "part/seat" },
        // Explicit matrix exercises the alternate glTF node-transform representation.
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, -1, 2, 1],
        mesh: 0,
      },
      {
        // This disconnected node must not contaminate active-scene bounds.
        translation: [1000, 1000, 1000],
        mesh: 1,
      },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 1 } }] },
    ],
    accessors: [
      { type: "VEC3", count: 8, min: [-1, -2, -0.5], max: [1, 2, 0.5] },
      { type: "VEC3", count: 8, min: [-50, -50, -50], max: [50, 50, 50] },
    ],
  };
  const bytes = jsonGlb(document);
  const expectedMin = [7, 2, -1.5];
  const expectedMax = [19, 6, -0.5];
  const expectedDims = [12, 4, 1];

  const measured = measureGlb(bytes);
  assert.equal(measured.readable, true);
  assertVectorClose(measured.bboxMin, expectedMin, "asset-QC min");
  assertVectorClose(measured.bboxMax, expectedMax, "asset-QC max");
  assertVectorClose(measured.bboxDims, expectedDims, "asset-QC dimensions");

  const compatibilityBounds = glbBbox(bytes);
  assertVectorClose(compatibilityBounds.mn, expectedMin, "asset-sanity min");
  assertVectorClose(compatibilityBounds.mx, expectedMax, "asset-sanity max");

  const furniture = inspectFurnitureGlb(bytes, {
    id: "furniture/test",
    parts: [{ id: "part/seat" }],
  });
  assertVectorClose(furniture.bounds.min, expectedMin, "furniture min");
  assertVectorClose(furniture.bounds.max, expectedMax, "furniture max");
  assertVectorClose(furniture.pivot, [10, 2, -3], "furniture pivot");
});

test("asset-sanity compatibility wrapper preserves parse and no-bounds outcomes", () => {
  assert.equal(glbBbox(Buffer.from("not a GLB")), null);
  const malformed = Buffer.alloc(24, 0x20);
  malformed.write("glTF", 0, "ascii");
  malformed.writeUInt32LE(2, 4);
  malformed.writeUInt32LE(malformed.length, 8);
  malformed.writeUInt32LE(4, 12);
  malformed.writeUInt32LE(0x4e4f534a, 16);
  malformed.write("nope", 20, "ascii");
  assert.throws(() => glbBbox(malformed), /invalid GLB/);

  const bytes = jsonGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{}] }],
  });
  assert.equal(glbBbox(bytes), null);
  assert.deepEqual(measureGlb(bytes).bboxDims, [0, 0, 0]);
});
