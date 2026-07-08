// P91 — the ASSET QC GATE, proven FALSIFIABLE (Slice — asset pre-import quality gate). Every baked
// asset GLB must clear gates/design/asset-qc-gate.mjs BEFORE it is imported into a world: a THEME axis
// (surfaces on the governing Design Direction, via the reused style-conformance gate) and a monotonic
// graphical FIDELITY RATCHET (art-direction/fidelity-floor.json). This runner proves the gate actually
// catches the broken-cottage class:
//
//   PASS case: a real textured, detailed kit building (assets/kit-building.glb) → runAssetQcGate.pass === true.
//              (SKIPS cleanly if the binary GLB isn't checked in — like p90 — so a fresh sweep stays green.)
//   FAIL case: a DEGENERATE building synthesized in-test (single flat-colour box, ~a dozen tris, no
//              albedo map, speck bbox, off-palette colour) → runAssetQcGate.pass === false with a
//              FIDELITY failure reason. This half is synthetic (always available) so it ALWAYS runs.
//
// Runs NATIVELY: ./target/release/limina js/test/p91_asset_qc.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { DEFAULT_DESIGN_DIRECTION, serializeDesignDirection } from "../src/game/design-direction.ts";
import { runAssetQcGate } from "../../gates/design/asset-qc-gate.mjs";
import floor from "../../art-direction/fidelity-floor.json" with { type: "json" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p91_asset_qc FAIL: " + msg);
}

const dd = JSON.parse(serializeDesignDirection(DEFAULT_DESIGN_DIRECTION));

// ── Build a minimal, VALID, but DEGENERATE box GLB by hand: 8 verts / 12 tris, ONE flat-colour
//    material with NO textures (magenta baseColorFactor — off the earthy palette), a 1×1×1 bbox. This
//    is the broken-cottage class the ratchet must reject. ─────────────────────────────────────────
function buildDegenerateBoxGlb(): Uint8Array {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, 0.5, -0.5,  -0.5, 0.5, -0.5,
    -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5, 0.5,  0.5,  -0.5, 0.5,  0.5,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, // front
    4, 6, 5, 4, 7, 6, // back
    0, 3, 7, 0, 7, 4, // left
    1, 5, 6, 1, 6, 2, // right
    0, 4, 5, 0, 5, 1, // bottom
    3, 2, 6, 3, 6, 7, // top
  ]);
  const posBytes = new Uint8Array(positions.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const posLen = posBytes.length;            // 96
  const idxLen = idxBytes.length;            // 72
  const bin = new Uint8Array(posLen + idxLen);
  bin.set(posBytes, 0);
  bin.set(idxBytes, posLen);

  const json = {
    asset: { version: "2.0", generator: "p91-degenerate-box" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{
      // flat magenta, no maps — OFF-palette AND missing the required albedo texture.
      pbrMetallicRoughness: { baseColorFactor: [0.9, 0.0, 0.9, 1.0], metallicFactor: 0, roughnessFactor: 0.9 },
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posLen, target: 34962 },
      { buffer: 0, byteOffset: posLen, byteLength: idxLen, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  // GLB container: header + JSON chunk (space-padded) + BIN chunk (zero-padded), all 4-byte aligned.
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const p = new Uint8Array(jsonBytes.length + jpad).fill(0x20); p.set(jsonBytes); jsonBytes = p; }
  const bpad = (4 - (bin.length % 4)) % 4;
  const binPadded = bpad ? (() => { const p = new Uint8Array(bin.length + bpad); p.set(bin); return p; })() : bin;

  const total = 12 + 8 + jsonBytes.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  const binHdr = 20 + jsonBytes.length;
  dv.setUint32(binHdr, binPadded.length, true); dv.setUint32(binHdr + 4, 0x004e4942, true); // BIN\0
  out.set(binPadded, binHdr + 8);
  return out;
}

// ── FAIL case (synthetic — ALWAYS runs). The broken cottage MUST hard-fail with a fidelity reason. ─
const bad = buildDegenerateBoxGlb();
const badVerdict = runAssetQcGate(bad, { dd, floor, class: "building" });
ops.op_log(`FAIL-case: pass=${badVerdict.pass} score=${badVerdict.score} measured={v:${badVerdict.measured.vertexCount},t:${badVerdict.measured.triangleCount},mats:${badVerdict.measured.materialCount},albedo:${badVerdict.measured.hasAlbedoMap},normal:${badVerdict.measured.hasNormalMap},bbox:[${badVerdict.measured.bboxDims.map((x: number) => x.toFixed(2)).join(",")}]}`);
for (const f of badVerdict.failures) ops.op_log(`  FAIL ${f.gate}: ${f.detail}`);

assert(badVerdict.pass === false, "the degenerate box PASSED — the QC gate is a no-op (does not catch the broken-cottage class)");
const fidelityFails = badVerdict.failures.filter((f: { gate: string }) => f.gate.startsWith("fidelity:"));
assert(fidelityFails.length > 0, "the degenerate box failed but NOT on a fidelity axis — the ratchet did not fire");
assert(badVerdict.failures.some((f: { gate: string }) => f.gate === "fidelity:albedo-map"), "expected the flat, map-less box to fail requiresAlbedoMap");
assert(badVerdict.failures.some((f: { gate: string }) => f.gate === "fidelity:vertices"), "expected the ~12-tri box to fail the vertex floor");

// ── PASS case (fixture-dependent — SKIPS cleanly if the binary GLB isn't checked in). ──────────────
const GLB_ID = "fixtures/building.glb";
let good: Uint8Array | null = null;
try { good = ops.op_read_asset(GLB_ID); } catch { good = null; }
if (good === null) {
  ops.op_log(`p91_asset_qc: PASS-case SKIP — building fixture '${GLB_ID}' not present (regenerate via tools/blender/make_fixtures.py). FAIL-case (synthetic) ran and passed.`);
} else {
  const goodVerdict = runAssetQcGate(good, { dd, floor, class: "building" });
  ops.op_log(`PASS-case: pass=${goodVerdict.pass} score=${goodVerdict.score} measured={v:${goodVerdict.measured.vertexCount},t:${goodVerdict.measured.triangleCount},mats:${goodVerdict.measured.materialCount},albedo:${goodVerdict.measured.hasAlbedoMap},normal:${goodVerdict.measured.hasNormalMap},bbox:[${goodVerdict.measured.bboxDims.map((x: number) => x.toFixed(2)).join(",")}]}`);
  for (const f of goodVerdict.failures) ops.op_log(`  (unexpected) FAIL ${f.gate}: ${f.detail}`);
  assert(goodVerdict.pass === true, `the good building fixture FAILED QC: ${goodVerdict.failures.map((f: { detail: string }) => f.detail).join("; ")}`);
}

ops.op_log(`p91_asset_qc OK: degenerate box HARD-FAILS (${badVerdict.failures.length} reasons incl. fidelity) and the good building fixture ${good === null ? "SKIPPED (absent)" : "PASSES"}. The asset QC gate is real + falsifiable.`);
