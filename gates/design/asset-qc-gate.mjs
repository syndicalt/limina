// ASSET QC GATE — the pre-import quality gate every baked asset GLB must clear BEFORE it is placed in a
// world. Two orthogonal axes, both FALSIFIABLE (a broken building hard-fails; a good textured, detailed
// building passes):
//
//   (1) THEME conformance — the asset's SURFACES stay on the governing Design Direction. Reuses
//       gates/design/style-conformance-gate.mjs (runStyleConformanceGate) as the authority: each
//       material's base colour (from baseColorFactor) + roughness/metalness (from the GLB) must sit
//       inside the DD palette + surface envelope, or the asset FAILS.
//
//   (2) FIDELITY RATCHET — a MONOTONIC quality floor (art-direction/fidelity-floor.json) that only ever
//       goes UP (toward the Project Gorgon ceiling). Measured straight from the GLB bytes: vertex/tri
//       counts, presence of an ALBEDO/baseColor map and a NORMAL map (a flat vertex-colour / factor-only
//       material fails requiresAlbedoMap), material count, and the node-transformed bounding-box extent
//       (a speck fails). Below the floor on ANY axis → FAIL with a specific reason.
//
// DETERMINISTIC + PURE given (bytes, floor, dd): no network, no Date, no Math.random, no GPU. Runs both
// under node AND inside the native limina runtime (deno_core) — so it deliberately avoids a top-level
// node:fs / THREE import; the transformed-AABB matrix math is implemented here in pure JS (a
// dependency-free twin of js/src/assets/gltf-bounds.ts). raiseFloor() lazy-imports node:fs only when
// actually called (the ratchet-writer path never runs in the native gate).
//
//   import { runAssetQcGate } from "./asset-qc-gate.mjs"
//   const verdict = runAssetQcGate(glbBytes, { dd, floor, class: "building" })
//     // -> { pass, score, failures:[{gate, detail}], measured }

import { runStyleConformanceGate } from "./style-conformance-gate.mjs";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

// ── GLB JSON-chunk parse (pure bytes; no BIN decode, no texture decode) ────────────────────────────
/** Extract the glTF JSON document from a binary GLB (or a raw .gltf). Returns null when the bytes are
 *  not a recognizable glTF container. */
export function parseGltfJson(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) === GLB_MAGIC) {
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (chunkType === CHUNK_JSON) {
        try { return JSON.parse(new TextDecoder().decode(bytes.subarray(dataStart, dataStart + chunkLen))); }
        catch { return null; }
      }
      offset = dataStart + chunkLen;
    }
    return null;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

// ── Pure-JS column-major 4x4 matrix math (dependency-free twin of gltf-bounds.ts's THREE path) ─────
function mat4Identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

function mat4Multiply(a, b) {
  // column-major: out = a * b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function mat4FromTRS(t, r, s) {
  // Compose column-major TRS: translation t=[x,y,z], rotation quaternion r=[x,y,z,w], scale s=[x,y,z].
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function nodeLocalMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return mat4FromTRS(t, r, s);
}

function transformPoint(m, p) {
  const [x, y, z] = p;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

// ── linear -> sRGB (glTF baseColorFactor is LINEAR; the DD palette is sRGB — convert so the palette
//    distance in style-conformance is apples-to-apples). ────────────────────────────────────────────
function lin2srgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function factorToHex(factor) {
  const r = lin2srgb(factor[0]), g = lin2srgb(factor[1]), b = lin2srgb(factor[2]);
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
const DEFAULT_BASE = [1, 1, 1, 1];
function factorIsMeaningful(factor) {
  // A material asserting a colour deviates from the glTF default white. Texture-only materials keep the
  // default (white) factor — their colour lives in the (undecodable-here) map, enforced by requiresAlbedoMap.
  if (!Array.isArray(factor)) return false;
  return Math.abs(factor[0] - 1) > 1e-4 || Math.abs(factor[1] - 1) > 1e-4 || Math.abs(factor[2] - 1) > 1e-4;
}

// ── Measure the fidelity + theme metrics straight from the GLB bytes ───────────────────────────────
/** Deterministic measurement of a GLB. Returns null-safe zeros when the container is unreadable (which
 *  the gate then hard-fails). */
export function measureGlb(bytes) {
  const json = parseGltfJson(bytes);
  if (json === null) {
    return {
      readable: false, vertexCount: 0, triangleCount: 0, materialCount: 0, meshCount: 0,
      hasAlbedoMap: false, hasNormalMap: false, bboxDims: [0, 0, 0], materials: [],
    };
  }
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];
  const nodes = json.nodes ?? [];
  const materials = json.materials ?? [];

  // Geometry counts.
  let vertexCount = 0, triangleCount = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      const posIdx = prim.attributes?.POSITION;
      if (posIdx === undefined) continue;
      const posAcc = accessors[posIdx];
      if (posAcc?.count) vertexCount += posAcc.count;
      // mode 4 (TRIANGLES) is glTF's default when omitted.
      const mode = prim.mode ?? 4;
      if (mode !== 4) continue;
      if (prim.indices !== undefined && accessors[prim.indices]?.count) triangleCount += Math.floor(accessors[prim.indices].count / 3);
      else if (posAcc?.count) triangleCount += Math.floor(posAcc.count / 3);
    }
  }

  // Material surfaces + map presence.
  const matOut = [];
  let hasAlbedoMap = false, hasNormalMap = false;
  for (const m of materials) {
    const pbr = m.pbrMetallicRoughness ?? {};
    const factor = pbr.baseColorFactor;
    const hasAlbedoTex = pbr.baseColorTexture !== undefined;
    const hasNormalTex = m.normalTexture !== undefined;
    if (hasAlbedoTex) hasAlbedoMap = true;
    if (hasNormalTex) hasNormalMap = true;
    matOut.push({
      // colorHex is set ONLY when the material asserts a non-default factor colour; texture-only
      // materials leave it null (their colour is texture-carried; presence is enforced by the fidelity axis).
      colorHex: factorIsMeaningful(factor) ? factorToHex(factor) : null,
      roughness01: typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1.0, // glTF default 1.0
      metalness01: typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1.0,   // glTF default 1.0
      hasAlbedoTex, hasNormalTex,
    });
  }

  // Node-transformed bounding box (raw accessor union UNDER-estimates when parts are placed by node
  // TRS/matrix — e.g. a roof translated up — so we accumulate world matrices exactly like gltf-bounds.ts).
  const rootIds = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const stack = rootIds.map((id) => ({ id, world: mat4Identity() }));
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let found = false;
  while (stack.length) {
    const { id, world } = stack.pop();
    const node = nodes[id];
    if (!node) continue;
    const nodeWorld = mat4Multiply(world, nodeLocalMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of meshes[node.mesh]?.primitives ?? []) {
        const posIdx = prim.attributes?.POSITION;
        if (posIdx === undefined) continue;
        const acc = accessors[posIdx];
        if (!acc?.min || !acc?.max || acc.min.length < 3 || acc.max.length < 3) continue;
        for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) {
          const p = transformPoint(nodeWorld, [cx ? acc.max[0] : acc.min[0], cy ? acc.max[1] : acc.min[1], cz ? acc.max[2] : acc.min[2]]);
          for (let a = 0; a < 3; a++) { if (p[a] < mn[a]) mn[a] = p[a]; if (p[a] > mx[a]) mx[a] = p[a]; }
          found = true;
        }
      }
    }
    for (const c of node.children ?? []) stack.push({ id: c, world: nodeWorld });
  }
  const bboxDims = found ? [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] : [0, 0, 0];

  return {
    readable: true, vertexCount, triangleCount, materialCount: materials.length, meshCount: meshes.length,
    hasAlbedoMap, hasNormalMap, bboxDims, materials: matOut,
  };
}

// ── Floor resolution: merge the default floor with a class-specific override ───────────────────────
export function resolveFloor(floor, cls) {
  const base = floor?.default ?? {};
  const over = (cls && floor?.class?.[cls]) ?? {};
  return {
    minVertexCount: over.minVertexCount ?? base.minVertexCount ?? 0,
    minTriangleCount: over.minTriangleCount ?? base.minTriangleCount ?? 0,
    minMaterialCount: over.minMaterialCount ?? base.minMaterialCount ?? 0,
    requiresAlbedoMap: over.requiresAlbedoMap ?? base.requiresAlbedoMap ?? false,
    requiresNormalMap: over.requiresNormalMap ?? base.requiresNormalMap ?? false,
    minBboxDims: over.minBboxDims ?? base.minBboxDims ?? [0, 0, 0],
  };
}

// ── The verdict (gamestack shape) ──────────────────────────────────────────────────────────────────
/** runAssetQcGate(glbBytes, { dd, floor, class }) -> { pass, score, failures:[{gate,detail}], measured }.
 *  FALSIFIABLE: any off-theme surface OR any below-floor fidelity axis is a HARD failure. When unsure, FAIL. */
export function runAssetQcGate(glbBytes, opts = {}) {
  const { dd, floor, class: cls } = opts;
  const failures = [];
  const measured = measureGlb(glbBytes);

  if (!measured.readable) {
    return { pass: false, score: 0, failures: [{ gate: "input", detail: "GLB container is unreadable (no glTF JSON chunk)" }], measured };
  }

  const f = resolveFloor(floor, cls);

  // ── FIDELITY RATCHET ─────────────────────────────────────────────────────────────────────────────
  const checks = []; // {ok} — score is the share of axes that hold
  const axis = (ok, gate, detail) => { checks.push(ok); if (!ok) failures.push({ gate, detail }); };

  axis(measured.vertexCount >= f.minVertexCount, "fidelity:vertices",
    `vertex count ${measured.vertexCount} < floor ${f.minVertexCount} (degenerate / near-flat geometry)`);
  axis(measured.triangleCount >= f.minTriangleCount, "fidelity:triangles",
    `triangle count ${measured.triangleCount} < floor ${f.minTriangleCount} (too coarse)`);
  axis(measured.materialCount >= f.minMaterialCount, "fidelity:materials",
    `material count ${measured.materialCount} < floor ${f.minMaterialCount} (single flat surface)`);
  if (f.requiresAlbedoMap) {
    axis(measured.hasAlbedoMap, "fidelity:albedo-map",
      "no albedo/baseColor texture — a flat vertex-colour / factor-only material does not clear the floor");
  }
  if (f.requiresNormalMap) {
    axis(measured.hasNormalMap, "fidelity:normal-map",
      "no normal map — surface detail below the floor");
  }
  for (let a = 0; a < 3; a++) {
    const label = ["width(x)", "height(y)", "depth(z)"][a];
    axis(measured.bboxDims[a] >= (f.minBboxDims[a] ?? 0), "fidelity:bbox",
      `bbox ${label} ${measured.bboxDims[a].toFixed(3)} < floor ${(f.minBboxDims[a] ?? 0)} (a speck, not a ${cls ?? "real asset"})`);
  }

  // ── THEME CONFORMANCE (reuse style-conformance-gate) ───────────────────────────────────────────────
  // Colour palette + surface envelope for materials that ASSERT a colour via baseColorFactor. (The
  // reference kit bakes colour into textures the native gate can't decode — those materials are checked
  // for map PRESENCE above and for their rough/metal envelope below; their pixel colour is enforced at
  // authoring time by the same style-conformance gate, see p88.)
  if (dd) {
    const coloured = measured.materials
      .filter((m) => m.colorHex)
      .map((m, i) => ({ label: `mat${i}`, colorHex: m.colorHex, roughness01: m.roughness01, metalness01: m.metalness01 }));
    if (coloured.length) {
      const v = runStyleConformanceGate(dd, coloured, {});
      for (const fail of v.failures) { checks.push(false); failures.push({ gate: `theme:${fail.gate}`, detail: fail.detail }); }
      if (v.pass) checks.push(true);
    }
    // Surface envelope for texture-only materials (colour deferred, but rough/metal ARE readable).
    const rough = dd.material?.roughness01, metal = dd.material?.metalness01;
    const offEnv = [];
    for (const m of measured.materials) {
      if (m.colorHex) continue; // already covered by the style gate above
      if (rough && (m.roughness01 < rough.min - 1e-6 || m.roughness01 > rough.max + 1e-6)) offEnv.push(`r=${m.roughness01} vs [${rough.min},${rough.max}]`);
      if (metal && (m.metalness01 < metal.min - 1e-6 || m.metalness01 > metal.max + 1e-6)) offEnv.push(`m=${m.metalness01} vs [${metal.min},${metal.max}]`);
    }
    axis(offEnv.length === 0, "theme:envelope",
      `${offEnv.length} texture-only material(s) outside the surface envelope: ${offEnv.slice(0, 6).join("; ")}`);
  }

  const passed = checks.filter(Boolean).length;
  const score = checks.length ? Number((passed / checks.length).toFixed(3)) : 1;
  return { pass: failures.length === 0, score, failures, measured };
}

// ── RATCHET WRITER — monotonically raise the floor to a BETTER asset's metrics. Never lowers. ───────
/** Pure ratchet of a floor OBJECT toward `measured` for one class (or "default"): every min-threshold
 *  becomes max(old, measured); requires* flags are monotonic toward true (old || measuredHasIt), never
 *  cleared. Returns a NEW floor object; does no I/O. */
export function ratchetFloor(floorObj, measured, cls = "building") {
  const next = JSON.parse(JSON.stringify(floorObj ?? { version: 1, default: {}, class: {} }));
  const target = cls === "default" ? (next.default ??= {}) : ((next.class ??= {})[cls] ??= {});
  const maxN = (a, b) => Math.max(a ?? 0, b ?? 0);
  target.minVertexCount = maxN(target.minVertexCount, measured.vertexCount);
  target.minTriangleCount = maxN(target.minTriangleCount, measured.triangleCount);
  target.minMaterialCount = maxN(target.minMaterialCount, measured.materialCount);
  target.requiresAlbedoMap = Boolean(target.requiresAlbedoMap) || Boolean(measured.hasAlbedoMap);
  target.requiresNormalMap = Boolean(target.requiresNormalMap) || Boolean(measured.hasNormalMap);
  const oldBbox = target.minBboxDims ?? [0, 0, 0];
  target.minBboxDims = [0, 1, 2].map((a) => Number(maxN(oldBbox[a], measured.bboxDims?.[a]).toFixed(3)));
  return next;
}

/** Read art-direction/fidelity-floor.json, ratchet it toward `measured` for `class`, and write it back.
 *  Lazy-imports node:fs so this module stays importable in the native (fs-less) runtime — the gate
 *  itself only READS the floor; only this writer touches disk, and only when called under node. */
export async function raiseFloor(measured, opts = {}) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const floorPath = opts.floorPath ?? resolve(here, "..", "..", "art-direction", "fidelity-floor.json");
  const current = JSON.parse(readFileSync(floorPath, "utf8"));
  const next = ratchetFloor(current, measured, opts.class ?? "building");
  next.updatedFrom = opts.provenance ?? "raiseFloor";
  if (opts.dryRun) return next;
  writeFileSync(floorPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}
