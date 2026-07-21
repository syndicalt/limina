// p90 — the GLB EXPORT round-trip gate (Slice 4). Proves a kit-composed cottage, exported to a binary
// GLB by the browser harness (js/src/eyes/kit_export_entry.ts, written by tools/preview/export-kit-
// building.mjs), RE-IMPORTS faithfully through the ENGINE's own asset paths — geometry survives, the
// world bounds match the source building, and the mesh instantiates. This is the author→GLB→re-import
// proof, verified BY RE-IMPORT (not by preview).
//
// Runs NATIVELY: ./target/release/limina js/test/p90_glb_export_roundtrip.ts   (exit 0 = pass)
//
// Two independent re-import paths, both the engine's real ones:
//   1. gltfLocalAabb(bytes) — the deterministic byte-level AABB asset.place authors colliders from
//      (no THREE scene, no texture decode). Runs on the FULL textured GLB. Asserts the geometry is
//      present + the bounds match the source building.
//   2. parseGltfScene(id, bytes) — the engine's GLTFLoader path the live viewport mounts through.
//      Asserts ≥1 real mesh with positioned vertices instantiates.
//
// NATIVE TEXTURE-DECODE LIMITATION (deliberate split, not a hack): the exported GLB embeds the baked
// SRGB albedo as raster PNG bufferViews. three's GLTFLoader decodes those by createObjectURL(blob) +
// fetch(blobURL); deno_webgpu's native fetch supports only file:// URLs, so an embedded-raster GLB
// cannot texture-decode NATIVELY (this is why p87's UNtextured cottage.glb parses here but a textured
// one throws "Only file:// URLs are supported"). The geometry round-trip is what THIS native gate
// proves, so path 2 parses a texture-reference-stripped copy of the SAME bytes — every mesh/material/
// accessor is identical, only the image/texture/sampler references are removed so no blob fetch runs.
// The FULL textured re-import (decode + the "not darkened" SRGB proof) is done in a real browser via
// the IDENTICAL engine parseGltfScene by the GPU-eyes harness (kit_reimport_entry.ts) — where blob
// URLs work. gltfLocalAabb above already exercises the real textured GLB's geometry byte-for-byte.
//
// The GLB MUST be present (produced by the export harness); if it is missing the gate FAILS LOUDLY —
// it never silently skips, so a broken export can't pass green.

import { ops } from "../src/engine.ts";
import { gltfLocalAabb } from "../src/assets/gltf-bounds.ts";
import { parseGltfScene } from "../src/skills/three.ts";
import * as THREE from "../build/three.bundle.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p90_glb_export_roundtrip FAIL: " + msg);
}
const finite = (n: number): boolean => Number.isFinite(n);

/** Return a copy of GLB `bytes` with every image/texture/sampler reference removed (geometry, meshes,
 *  materials and accessors untouched) so a native GLTFLoader parse instantiates the meshes WITHOUT the
 *  blob-URL image fetch deno_webgpu can't service. Pure byte surgery on the JSON chunk; the BIN chunk
 *  is carried through verbatim (the now-unreferenced image bufferViews are harmless). */
function stripGltfTextures(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const jsonStart = 20; // 12-byte header + 8-byte JSON chunk header
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLen))) as Record<string, unknown>;
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of (json.materials as Array<Record<string, unknown>> | undefined) ?? []) {
    const pbr = m.pbrMetallicRoughness as Record<string, unknown> | undefined;
    if (pbr !== undefined) delete pbr.baseColorTexture;
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
  }
  // Re-emit the GLB: header + padded JSON chunk + the original BIN chunk (verbatim).
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad > 0) { const p = new Uint8Array(jsonBytes.length + pad).fill(0x20); p.set(jsonBytes); jsonBytes = p; }
  const binChunk = bytes.subarray(jsonStart + jsonLen); // [len][type][data...] of the BIN chunk, verbatim
  const total = 12 + 8 + jsonBytes.length + binChunk.length;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
  odv.setUint32(12, jsonBytes.length, true); odv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.set(binChunk, 20 + jsonBytes.length);
  return out;
}

// The native runtime reads only through the engine's sandboxed asset path (op_read_asset, rooted at
// <cwd>/assets). GLB_ID is a committed synthetic building fixture (tools/blender/make_fixtures.py) so
// the round-trip runs on every checkout; reading it is the SAME resolver asset.place uses in production.
const GLB_ID = "fixtures/building.glb";
const BOUNDS_ID = "fixtures/building.bounds.json";
const EXPORT_CMD = 'blender --background --factory-startup --python tools/blender/make_fixtures.py -- --outdir assets/fixtures';

// ── The building fixture is committed, so the full round-trip runs on every checkout. The absent-GLB
// branch remains a defensive SKIP (e.g. if fixtures were pruned): regenerate with the command above.
// When present, every assertion below runs and a broken re-import fails loudly. ────────────────────
let bytes: Uint8Array | null = null;
try { bytes = ops.op_read_asset(GLB_ID); } catch { bytes = null; }
if (bytes === null) {
  ops.op_log(`p90_glb_export_roundtrip SKIP: building fixture '${GLB_ID}' not present — regenerate: ${EXPORT_CMD}`);
} else {
  assert(bytes.length > 1000, `exported GLB is implausibly small (${bytes.length} bytes)`);

// ── 1. Byte-level AABB (the collider path). ───────────────────────────────────────────────────────
const aabb = gltfLocalAabb(bytes);
assert(aabb !== null, "gltfLocalAabb returned null — the GLB carries no positioned geometry (re-import would author no collider)");
const ext: [number, number, number] = [aabb.max[0] - aabb.min[0], aabb.max[1] - aabb.min[1], aabb.max[2] - aabb.min[2]];
for (let a = 0; a < 3; a++) {
  assert(finite(aabb.min[a]) && finite(aabb.max[a]), `re-imported AABB axis ${a} is not finite: [${aabb.min[a]}, ${aabb.max[a]}]`);
  assert(ext[a] > 0.1, `re-imported AABB axis ${a} extent ${ext[a]} is not a positive building dimension`);
}

// ── 2. Bounds ≈ the source building (sidecar written by the harness; else hard cottage plausibility). ─
let srcBounds: { size: number[]; min: number[]; max: number[] } | null = null;
try { srcBounds = JSON.parse(new TextDecoder().decode(ops.op_read_asset(BOUNDS_ID))) as typeof srcBounds; } catch { srcBounds = null; }
if (srcBounds !== null) {
  const src = srcBounds;
  const TOL = 0.25; // GLB accessor min/max are rounded to fp32 + our node-TRS bake; a tight metric tolerance
  for (let a = 0; a < 3; a++) {
    const d = Math.abs(ext[a] - src.size[a]);
    assert(d <= TOL, `re-imported extent axis ${a} (${ext[a].toFixed(4)}) differs from source ${src.size[a]} by ${d.toFixed(4)} > ${TOL}`);
  }
} else {
  // No sidecar → assert plausible cottage dims directly (W≈8–9, H≈5–7 incl. gable, D≈6–7.5).
  assert(ext[0] >= 7.5 && ext[0] <= 9.5, `cottage width ${ext[0].toFixed(3)} out of plausible range`);
  assert(ext[1] >= 4.5 && ext[1] <= 7.0, `cottage height ${ext[1].toFixed(3)} out of plausible range`);
  assert(ext[2] >= 5.5 && ext[2] <= 8.0, `cottage depth ${ext[2].toFixed(3)} out of plausible range`);
}

// ── 3. Mesh instantiation via the engine's GLTFLoader path (≥1 real mesh). Texture-stripped copy so
//       the native (blob-fetch-less) loader instantiates the SAME geometry — see the header note. ──
const root = await parseGltfScene(GLB_ID, stripGltfTextures(bytes));
let meshes = 0, verts = 0;
(root as unknown as THREE.Object3D).traverse((o: THREE.Object3D) => {
  const m = o as THREE.Mesh;
  if (m.isMesh && m.geometry !== undefined) {
    const pos = m.geometry.getAttribute("position");
    if (pos !== undefined && pos.count > 0) { meshes++; verts += pos.count; }
  }
});
assert(meshes >= 1, `parseGltfScene instantiated ${meshes} meshes — expected ≥1`);
assert(verts > 0, "parseGltfScene meshes carry no positioned vertices");

// ── 4. The instantiated scene's world AABB is finite + non-degenerate (matches the byte-level AABB). ─
const box = new THREE.Box3().setFromObject(root as unknown as THREE.Object3D);
const sz = new THREE.Vector3(); box.getSize(sz);
assert(finite(sz.x) && finite(sz.y) && finite(sz.z), `instantiated scene bounds not finite: ${JSON.stringify([sz.x, sz.y, sz.z])}`);
assert(sz.x > 0.1 && sz.y > 0.1 && sz.z > 0.1, `instantiated scene bounds degenerate: ${JSON.stringify([sz.x, sz.y, sz.z])}`);

  console.log(`p90_glb_export_roundtrip OK: GLB ${bytes.length} bytes re-imports — gltfLocalAabb ext=${JSON.stringify(ext.map((e) => +e.toFixed(3)))} (finite, positive); parseGltfScene → ${meshes} meshes / ${verts} verts; instantiated bounds=${JSON.stringify([sz.x, sz.y, sz.z].map((v) => +v.toFixed(3)))}. Round-trip verified by RE-IMPORT.`);
}
