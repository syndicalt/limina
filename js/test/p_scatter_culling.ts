// Map Phase 3.4 GATE — real frustum culling for asset/vegetation scatters (headless, pure math).
//
// The defect: buildAssetInstancedMeshes used to set `frustumCulled = false` on every mesh it built
// (asset-scatter-render.ts), because a plain InstancedMesh frustum-culls against its BASE geometry's
// bounding sphere AT THE ORIGIN — a scatter whose instances sit far from that origin would otherwise
// vanish whole. The fix has two parts, both proven here:
//
//   1. A REAL bounding sphere: `inst.computeBoundingSphere()` (three ^0.184) unions the per-instance
//      transformed geometry sphere across every instance — it must actually CONTAIN every instance's
//      world position (not just the origin). Falsifiable: an old origin-only sphere would NOT contain
//      an instance placed thousands of metres away.
//   2. CHUNKING (opts.chunkSize): without it, a scatter spanning many cells (a forest across a whole
//      map) gets ONE mesh whose bounding sphere covers the entire span — the frustum would almost
//      always intersect it, i.e. no culling GRANULARITY even with a correct sphere. With chunkSize
//      set, a near cluster and a far cluster become SEPARATE InstancedMeshes with their own tight
//      spheres, so a real camera frustum can cull the far one while keeping the near one.
//
// Both are pure three.js math (Frustum/Sphere/InstancedMesh) — no engine, no renderer, no GPU.

import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { buildAssetInstancedMeshes } from "../src/terrain/asset-scatter-render.ts";
import type { AssetInstance } from "../src/terrain/asset-scatter.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_scatter_culling FAIL: " + msg);
}

// A single-mesh "clean" asset (base at Y=0 already, mirrors p11_asset_scatter's clean-asset case) —
// normalization is then a no-op, so instance translations land exactly at (p.x, p.y, p.z).
const mat = new THREE.MeshStandardNodeMaterial({ color: 0x808080 });
const root = new THREE.Group();
root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat));

// A NEAR cluster and a FAR cluster ~2 km away — both well inside ONE 96 m cell each, but ~2000 m apart
// from each other (many cells apart). The near cluster is kept away from x=0/z=0 (a 96 m GRID LINE,
// since cells are floor(coord/96)) so all 3 of its instances land in the SAME cell — straddling that
// line would (correctly) split them into separate cells too, which is a different thing to prove.
const near: AssetInstance[] = [
  { assetId: "box", x: 20, y: 0, z: 20, yaw: 0, scale: 1 },
  { assetId: "box", x: 26, y: 0, z: 16, yaw: 0.4, scale: 1.2 },
  { assetId: "box", x: 12, y: 0, z: 29, yaw: 1.1, scale: 0.8 },
];
const far: AssetInstance[] = [
  { assetId: "box", x: 2000, y: 0, z: 0, yaw: 0, scale: 1 },
  { assetId: "box", x: 2006, y: 0, z: 5, yaw: 0.7, scale: 1.3 },
];
const instances = [...near, ...far];

// ── 1. No chunking (opts omitted) — EXACTLY today's un-chunked shape: one mesh for the whole
//    flat list, its bounding sphere spans the whole 2000 m gap (no culling granularity), but the
//    sphere itself must still be REAL and contain every instance (the origin-sphere bug is fixed).
{
  const meshes = buildAssetInstancedMeshes(root, instances);
  assert(meshes.length === 1, `un-chunked: expected 1 InstancedMesh, got ${meshes.length}`);
  const mesh = meshes[0];
  assert(mesh.frustumCulled === true, "un-chunked: frustumCulled must default to true (was force-disabled before the fix)");
  assert(mesh.boundingSphere !== null, "un-chunked: boundingSphere was never computed");
  const sphere = mesh.boundingSphere!;
  for (const p of instances) {
    const d = sphere.center.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    assert(d <= sphere.radius + 1e-6, `un-chunked: instance (${p.x},${p.y},${p.z}) sits OUTSIDE the computed bounding sphere (d=${d.toFixed(3)} > r=${sphere.radius.toFixed(3)}) — the manual/auto sphere math is wrong`);
  }
  // Falsifies the OLD bug directly: the sphere must NOT be centred at the origin with a tiny radius
  // (that would be the pre-fix origin-only geometry sphere, which would exclude the far cluster).
  assert(sphere.radius > 900, `un-chunked: sphere radius ${sphere.radius.toFixed(1)} is far too small to span the 2000 m cluster gap — looks like the OLD origin-only bounding sphere, not a real per-instance union`);
}

// ── 2. Chunked (chunkSize: 96) — near/far clusters land in DIFFERENT cells (2000 m apart, 96 m
//    cells), so this must produce 2 separate InstancedMeshes, each with a TIGHT sphere around only
//    its own cluster.
const chunked = buildAssetInstancedMeshes(root, instances, { chunkSize: 96 });
assert(chunked.length === 2, `chunked: expected 2 InstancedMeshes (near cell + far cell), got ${chunked.length}`);
const totalInstances = chunked.reduce((n, m) => n + m.count, 0);
assert(totalInstances === instances.length, `chunked: total instance count ${totalInstances} != ${instances.length} (an instance was dropped/duplicated)`);

let nearMesh: THREE.InstancedMesh | undefined;
let farMesh: THREE.InstancedMesh | undefined;
for (const mesh of chunked) {
  assert(mesh.boundingSphere !== null, "chunked: boundingSphere was never computed");
  const sphere = mesh.boundingSphere!;
  if (mesh.count === near.length) nearMesh = mesh;
  if (mesh.count === far.length) farMesh = mesh;
  // Each chunk's sphere must be TIGHT (nowhere near the 2000 m cluster gap) — the whole point of
  // chunking is that no single sphere spans both clusters anymore.
  assert(sphere.radius < 50, `chunked: a per-cell sphere has radius ${sphere.radius.toFixed(1)} — chunking did not separate the clusters (still spans the gap)`);
}
assert(nearMesh !== undefined && farMesh !== undefined, "chunked: did not find one mesh per cluster (by instance count)");

// Every instance sits inside its OWN chunk's sphere (same contract as the un-chunked case, per-cell).
for (const [mesh, group] of [[nearMesh!, near], [farMesh!, far]] as const) {
  const sphere = mesh.boundingSphere!;
  for (const p of group) {
    const d = sphere.center.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    assert(d <= sphere.radius + 1e-6, `chunked: instance (${p.x},${p.y},${p.z}) sits outside its own chunk's bounding sphere`);
  }
}

// ── 3. THE PAYOFF — a real camera frustum culls the far chunk while keeping the near one.
//    A camera looking at the near cluster's spread with a SHORT far plane (200 m) that does not
//    reach the far cluster (2000 m away). Pure three.js Frustum/Camera math — no renderer.
{
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(20, 8, 60);
  camera.lookAt(20, 0, 20);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const frustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProj);

  const nearVisible = frustum.intersectsObject(nearMesh!);
  const farVisible = frustum.intersectsObject(farMesh!);
  assert(nearVisible === true, "frustum test: the NEAR chunk (well inside the 200 m far plane) was culled — false-negative culling");
  assert(farVisible === false, "frustum test: the FAR chunk (2000 m away, past the 200 m far plane) was NOT culled — chunking gave no culling granularity");
}

ops.op_log("[js] p_scatter_culling OK: buildAssetInstancedMeshes computes a REAL per-instance bounding " +
  "sphere (frustumCulled defaults true, no more force-disabled origin-sphere bug) and opts.chunkSize " +
  "buckets a map-spanning scatter into per-area InstancedMeshes with tight spheres — a real camera " +
  "frustum culls a far chunk while keeping a near one.");
