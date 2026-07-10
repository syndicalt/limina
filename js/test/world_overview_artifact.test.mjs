import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import {
  WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  WORLD_OVERVIEW_MAX_ARTIFACT_BYTES,
  WORLD_OVERVIEW_MAX_DIMENSION,
  WORLD_OVERVIEW_TARGET_DIMENSION,
  WorldOverviewArtifactCancelledError,
  decodeWorldOverviewArtifact,
  encodeWorldOverviewArtifact,
} from "../src/world/compiler/world-overview-artifact.mjs";

function grid(rows = 3, cols = 5) {
  const cells = rows * cols;
  const heights = new Float32Array(cells);
  const paintMaterial = new Uint8Array(cells);
  const paintWeight = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    heights[index] = Math.fround(index / 3 - 2);
    paintMaterial[index] = index % 8;
    paintWeight[index] = index % 256;
  }
  return { rows, cols, origin: [-100.5, 20.25], stepM: 8, heights, paintMaterial, paintWeight };
}

test("world overview artifact is deterministic, exact, and round-trips all channels", () => {
  const source = grid();
  const first = encodeWorldOverviewArtifact(source);
  const second = encodeWorldOverviewArtifact(source);
  assert.deepEqual(first, second);
  assert.equal(first.byteLength, WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES + source.rows * source.cols * 6);
  const decoded = decodeWorldOverviewArtifact(first);
  assert.equal(decoded.metadata.artifactType, WORLD_OVERVIEW_ARTIFACT_TYPE);
  assert.deepEqual(decoded.grid.origin, source.origin);
  assert.equal(decoded.grid.stepM, source.stepM);
  assert.deepEqual(decoded.grid.heights, source.heights);
  assert.deepEqual(decoded.grid.paintMaterial, source.paintMaterial);
  assert.deepEqual(decoded.grid.paintWeight, source.paintWeight);
  assert.deepEqual(encodeWorldOverviewArtifact(decoded.grid), first);
});

test("decoded metadata is immutable and channels own transferable storage", () => {
  const bytes = encodeWorldOverviewArtifact(grid());
  const decoded = decodeWorldOverviewArtifact(bytes);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.grid), true);
  assert.equal(Object.isFrozen(decoded.grid.origin), true);
  assert.equal(Object.isFrozen(decoded.metadata), true);
  assert.equal(Object.isFrozen(decoded.metadata.offsets), true);
  for (const channel of [decoded.grid.heights, decoded.grid.paintMaterial, decoded.grid.paintWeight]) {
    assert.equal(channel.byteOffset, 0);
    assert.equal(channel.byteLength, channel.buffer.byteLength);
    assert.equal(channel.buffer instanceof ArrayBuffer, true);
  }
  const retained = decoded.grid.heights[0];
  bytes[WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES] ^= 0xff;
  assert.equal(decoded.grid.heights[0], retained);
});

test("strict structure, geometry, channel, and framing validation fail closed", () => {
  assert.throws(() => encodeWorldOverviewArtifact({ ...grid(), extra: true }), /unknown field/);
  assert.throws(() => encodeWorldOverviewArtifact({ ...grid(), rows: 1 }), /rows/);
  assert.throws(() => encodeWorldOverviewArtifact(grid(WORLD_OVERVIEW_MAX_DIMENSION + 1, 2)), /rows/);
  assert.throws(() => encodeWorldOverviewArtifact({ ...grid(), origin: [10_000_001, 0] }), /world range/);
  assert.throws(() => encodeWorldOverviewArtifact({ ...grid(), stepM: 0 }), /stepM/);
  const wrong = grid(); wrong.heights = new Float32Array(wrong.heights.buffer, 4);
  assert.throws(() => encodeWorldOverviewArtifact(wrong), /own its complete/);
  const nonfinite = grid(); nonfinite.heights[2] = Infinity;
  assert.throws(() => encodeWorldOverviewArtifact(nonfinite), /finite canonical/);

  const valid = encodeWorldOverviewArtifact(grid());
  assert.throws(() => decodeWorldOverviewArtifact(valid.subarray(0, valid.length - 1)), /owned Uint8Array|byte length/);
  const corruptLength = new Uint8Array(valid); new DataView(corruptLength.buffer).setUint32(12, corruptLength.length + 1, true);
  assert.throws(() => decodeWorldOverviewArtifact(corruptLength), /byte length/);
  const corruptOffset = new Uint8Array(valid); new DataView(corruptOffset.buffer).setUint32(52, 0, true);
  assert.throws(() => decodeWorldOverviewArtifact(corruptOffset), /offsets/);
  const corruptReserved = new Uint8Array(valid); corruptReserved[60] = 1;
  assert.throws(() => decodeWorldOverviewArtifact(corruptReserved), /reserved/);
  const trailing = new Uint8Array(valid.length + 1); trailing.set(valid);
  assert.throws(() => decodeWorldOverviewArtifact(trailing), /byte length/);
});

test("encode and decode honor cancellation checkpoints", () => {
  assert.throws(
    () => encodeWorldOverviewArtifact(grid(), { shouldCancel: () => true }),
    WorldOverviewArtifactCancelledError,
  );
  const bytes = encodeWorldOverviewArtifact(grid());
  assert.throws(
    () => decodeWorldOverviewArtifact(bytes, { shouldCancel: () => true }),
    WorldOverviewArtifactCancelledError,
  );
  assert.throws(() => decodeWorldOverviewArtifact(bytes, { shouldCancel: false }), /shouldCancel/);
});

test("target and maximum grids remain within the compact bound and report decode timing", (context) => {
  const target = encodeWorldOverviewArtifact(grid(WORLD_OVERVIEW_TARGET_DIMENSION, WORLD_OVERVIEW_TARGET_DIMENSION));
  assert.equal(target.byteLength, 99_910);
  const maximum = encodeWorldOverviewArtifact(grid(WORLD_OVERVIEW_MAX_DIMENSION, WORLD_OVERVIEW_MAX_DIMENSION));
  assert.equal(maximum.byteLength, WORLD_OVERVIEW_MAX_ARTIFACT_BYTES);
  const start = performance.now();
  const decoded = decodeWorldOverviewArtifact(maximum);
  const decodeMs = performance.now() - start;
  assert.equal(decoded.grid.heights.length, WORLD_OVERVIEW_MAX_DIMENSION ** 2);
  context.diagnostic(`benchmark targetBytes=${target.byteLength} maxBytes=${maximum.byteLength} maxDecodeMs=${decodeMs.toFixed(3)}`);
});
