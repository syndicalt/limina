// D5.2 optimistic sculpt preview (editor/src/sculpt-preview.js). Proves, on a synthetic
// 33x33 derived chunk mesh (48m chunks, 1.5m step — the derived-runtime chunk geometry):
//   (a) a raise dab displaces exactly the in-radius vertices by the deltas the engine's
//       lattice materializer computes for the same input — byte-exact (the preview's f32
//       store rounds (y + deltaM) exactly like composition's Math.fround per-op apply);
//   (b) out-of-radius vertices are untouched, bit-for-bit;
//   (c) normals are recomputed (and return byte-identical after rollback);
//   (d) a failed dab rolls the preview back byte-identical (whole position array);
//   (e) a raycast after the displacement hits the raised surface.
// The differential reference is materializeLatticeBrushDeltas — the exact function
// materializeTerrainBrushOp delegates to (js/src/skills/terrain-edit.ts is not
// node-importable in strip-only mode; the wrapper is gated by p_terrain_derived_edit_layer
// under the engine runner). The kernel module here IS the module the engine imports —
// no copy. Falsifiability: a forked/drifted falloff breaks (a); a skipped needsUpdate
// or bounding-sphere refresh breaks (e) through the raycaster's early-out.

import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "../../js/build/three.bundle.mjs";
import {
  createTerrainEditBaseTopology,
  terrainEditLatticeGeometry,
} from "../../js/src/terrain/edit-layer.mjs";
import * as kernel from "../../js/src/terrain/brush-kernel.mjs";
import {
  applySculptPreview,
  collectDerivedTerrainMeshes,
  rollbackSculptPreview,
} from "../src/sculpt-preview.js";

const SAMPLES = 33;
const CHUNK_M = 48;
const STEP = CHUNK_M / (SAMPLES - 1); // 1.5m — exact in binary for every lattice coordinate

// One-chunk domain: gx/gz 0..32, world x = gx*1.5, z = gz*1.5 (grid origin [0,0]).
const baseTopology = createTerrainEditBaseTopology({
  grid: {
    schema: "limina.terrain-grid/v1",
    gridId: "test-grid",
    origin: [0, 0],
    chunkSizeM: CHUNK_M,
    defaultSamples: SAMPLES,
  },
  domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 },
});
const lattice = terrainEditLatticeGeometry(baseTopology);

// Deterministic non-flat relief (flat heights would let a broken normal check pass).
function baseHeight(col, row) {
  return ((col * 7 + row * 13) % 17) * 0.1;
}

/** Mirrors featureLocalTerrainMesh: local grid around [0,0,0], tile origin baked into
 *  mesh.position; engine index winding ([v00,v10,v01]/[v10,v11,v01]) so normals face +y. */
function makeChunkMesh() {
  const positions = new Float32Array(SAMPLES * SAMPLES * 3);
  for (let row = 0; row < SAMPLES; row++) {
    for (let col = 0; col < SAMPLES; col++) {
      const v = row * SAMPLES + col;
      positions[v * 3] = -CHUNK_M / 2 + col * STEP;
      positions[v * 3 + 1] = baseHeight(col, row);
      positions[v * 3 + 2] = -CHUNK_M / 2 + row * STEP;
    }
  }
  const indices = new Uint32Array((SAMPLES - 1) * (SAMPLES - 1) * 6);
  let i = 0;
  for (let row = 0; row < SAMPLES - 1; row++) {
    for (let col = 0; col < SAMPLES - 1; col++) {
      const v00 = row * SAMPLES + col, v01 = v00 + 1, v10 = v00 + SAMPLES, v11 = v10 + 1;
      indices[i++] = v00; indices[i++] = v10; indices[i++] = v01;
      indices[i++] = v10; indices[i++] = v11; indices[i++] = v01;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(CHUNK_M / 2, 0, CHUNK_M / 2); // chunk (0,0) spans world 0..48 on both axes
  mesh.name = "limina:derived-terrain-chunk";
  mesh.userData.derivedTerrain = true;
  return mesh;
}

const RAISE_DAB = { center: [20.3, 17.7], radius: 6, delta: 2, mode: "raise", falloff: "smooth" };

function deltaMapFor(dab) {
  const deltas = kernel.materializeLatticeBrushDeltas(lattice, dab);
  const map = new Map();
  for (const d of deltas) map.set(`${d.gz}:${d.gx}`, d.deltaM);
  return map;
}

test("(a) raise dab displaces exactly the kernel deltas, byte-exact per vertex", () => {
  const mesh = makeChunkMesh();
  const original = Float32Array.from(mesh.geometry.attributes.position.array);
  const deltas = deltaMapFor(RAISE_DAB);
  assert.ok(deltas.size > 0, "the dab must cover lattice samples");
  const token = applySculptPreview([mesh], RAISE_DAB, kernel);
  assert.ok(token !== null, "an in-radius dab must touch the chunk");
  const array = mesh.geometry.attributes.position.array;
  let moved = 0;
  for (let row = 0; row < SAMPLES; row++) {
    for (let col = 0; col < SAMPLES; col++) {
      const v = row * SAMPLES + col;
      const deltaM = deltas.get(`${row}:${col}`) ?? 0;
      const expected = deltaM === 0 ? original[v * 3 + 1] : Math.fround(original[v * 3 + 1] + deltaM);
      assert.equal(array[v * 3 + 1], expected, `vertex (${col},${row}) y`);
      assert.equal(array[v * 3], original[v * 3], `vertex (${col},${row}) x untouched`);
      assert.equal(array[v * 3 + 2], original[v * 3 + 2], `vertex (${col},${row}) z untouched`);
      if (deltaM !== 0) moved++;
    }
  }
  assert.equal(moved, deltas.size, "every kernel delta landed on exactly one vertex");
  assert.ok(moved > 0);
});

test("(b) out-of-radius vertices are untouched bit-for-bit", () => {
  const mesh = makeChunkMesh();
  const original = Float32Array.from(mesh.geometry.attributes.position.array);
  applySculptPreview([mesh], RAISE_DAB, kernel);
  const array = mesh.geometry.attributes.position.array;
  const [cx, cz] = RAISE_DAB.center;
  let outside = 0;
  for (let row = 0; row < SAMPLES; row++) {
    for (let col = 0; col < SAMPLES; col++) {
      const v = row * SAMPLES + col;
      const dx = col * STEP - cx, dz = row * STEP - cz;
      if (dx * dx + dz * dz <= RAISE_DAB.radius * RAISE_DAB.radius) continue;
      outside++;
      assert.equal(array[v * 3 + 1], original[v * 3 + 1], `out-of-radius vertex (${col},${row}) moved`);
    }
  }
  assert.ok(outside > 0, "the dab must leave some vertices out of radius");
});

test("(c) normals recompute on apply and return byte-identical on rollback", () => {
  const mesh = makeChunkMesh();
  const normalsBefore = Float32Array.from(mesh.geometry.attributes.normal.array);
  const token = applySculptPreview([mesh], RAISE_DAB, kernel);
  const normalsAfter = mesh.geometry.attributes.normal.array;
  let bent = 0;
  for (let i = 0; i < normalsBefore.length; i++) if (normalsAfter[i] !== normalsBefore[i]) bent++;
  assert.ok(bent > 0, "displaced terrain must bend at least one normal");
  rollbackSculptPreview(token);
  const normalsRestored = mesh.geometry.attributes.normal.array;
  assert.deepEqual([...normalsRestored], [...normalsBefore], "rollback must restore normals byte-identical");
});

test("(d) failed dab rolls the position array back byte-identical", () => {
  const mesh = makeChunkMesh();
  const before = Buffer.from(mesh.geometry.attributes.position.array.buffer.slice(0));
  const token = applySculptPreview([mesh], RAISE_DAB, kernel);
  assert.ok(token !== null);
  rollbackSculptPreview(token);
  const after = Buffer.from(mesh.geometry.attributes.position.array.buffer.slice(0));
  assert.ok(before.equals(after), "positions must restore byte-identical");
});

test("(e) raycast after displacement hits the raised surface", () => {
  const mesh = makeChunkMesh();
  const scene = new THREE.Group();
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  const [cx, cz] = RAISE_DAB.center;
  const raycast = () => {
    const rc = new THREE.Raycaster(new THREE.Vector3(cx, 500, cz), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObjects(scene.children, true);
    return hits.length ? hits[0].point.y : null;
  };
  const before = raycast();
  assert.ok(before !== null, "the downward ray must hit the chunk");
  applySculptPreview([mesh], RAISE_DAB, kernel);
  scene.updateMatrixWorld(true);
  const after = raycast();
  assert.ok(after !== null, "the ray must still hit after displacement (bounding sphere refreshed)");
  assert.ok(after > before + 0.5, `raised surface must intercept higher (before ${before}, after ${after})`);
});

test("mesh collection: only derived chunk meshes, and a miss returns null", () => {
  const mesh = makeChunkMesh();
  const overview = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  overview.userData.derivedWorldOverview = true;
  const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const inner = new THREE.Group();
  inner.add(mesh);
  const scene = new THREE.Group();
  scene.add(inner, overview, plain);
  const collected = collectDerivedTerrainMeshes(scene);
  assert.deepEqual(collected, [mesh], "only userData.derivedTerrain meshes, found through nesting");
  const farDab = { center: [500, 500], radius: 3, delta: 1, mode: "raise", falloff: "smooth" };
  assert.equal(applySculptPreview(collected, farDab, kernel), null, "a dab off every chunk touches nothing");
  assert.equal(applySculptPreview([], RAISE_DAB, kernel), null, "no derived meshes -> no preview");
});

test("lower dab mirrors the kernel's negated deltas", () => {
  const mesh = makeChunkMesh();
  const dab = { ...RAISE_DAB, mode: "lower" };
  const deltas = deltaMapFor(dab);
  const original = Float32Array.from(mesh.geometry.attributes.position.array);
  applySculptPreview([mesh], dab, kernel);
  const array = mesh.geometry.attributes.position.array;
  for (let row = 0; row < SAMPLES; row++) {
    for (let col = 0; col < SAMPLES; col++) {
      const v = row * SAMPLES + col;
      const deltaM = deltas.get(`${row}:${col}`) ?? 0;
      const expected = deltaM === 0 ? original[v * 3 + 1] : Math.fround(original[v * 3 + 1] + deltaM);
      assert.equal(array[v * 3 + 1], expected, `vertex (${col},${row}) y`);
      if (deltaM !== 0) assert.ok(deltaM < 0, "lower deltas are negative");
    }
  }
});
