// Asset sanity scan — the guard that would have caught the 1.8km "grass tuft" and the
// 0-size leaves before they reached a build. For every assets/*.glb, parse the GLB JSON
// chunk, union the POSITION accessor min/max into one bbox, and flag:
//   • DEGENERATE  — any dimension ≈ 0 (empty / broken geometry)
//   • OVERSIZE    — any dimension beyond a sane world cap (garbage authored scale)
//   • OFF-GROUND  — min-y far from 0 (won't sit on terrain; informational)
//   • NO-BOUNDS   — no POSITION min/max in the file (can't be validated)
// Read-only. Usage: node tools/qc/asset-sanity.mjs [assetsDir]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] || "assets";
const CAP_M = 60;        // nothing in the library should exceed ~60m in any axis (a big keep is ~20m)
const DEGEN_M = 0.02;    // any axis under 2cm ⇒ effectively empty

// 4x4 column-major helpers (glTF convention).
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
const nodeMat = (n) => (Array.isArray(n.matrix) ? n.matrix.slice() : trs(n.translation, n.rotation, n.scale));
function apply(m, p) { // world = m * [p,1]
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// TRANSFORM-AWARE world bbox: walk the scene node hierarchy, accumulate each node's world
// matrix, and for every mesh transform its primitives' POSITION accessor min/max (all 8
// corners) into world space — the SAME size a scatter/place sees. Ignoring node transforms
// (raw accessor bounds) mis-reads assets that carry scale/offset in their nodes.
function glbBbox(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const nodes = json.nodes || [], meshes = json.meshes || [], accessors = json.accessors || [];
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], any = false;
  const visit = (idx, parent) => {
    const n = nodes[idx]; if (!n) return;
    const world = mul(parent, nodeMat(n));
    if (n.mesh !== undefined) {
      for (const prim of meshes[n.mesh]?.primitives || []) {
        const a = accessors[prim.attributes?.POSITION];
        if (a?.type === "VEC3" && Array.isArray(a.min) && Array.isArray(a.max)) {
          any = true;
          for (const cx of [a.min[0], a.max[0]]) for (const cy of [a.min[1], a.max[1]]) for (const cz of [a.min[2], a.max[2]]) {
            const w = apply(world, [cx, cy, cz]);
            for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); }
          }
        }
      }
    }
    for (const c of n.children || []) visit(c, world);
  };
  const I = trs();
  for (const r of roots) visit(r, I);
  return any ? { mn, mx } : null;
}

if (!existsSync(DIR)) { console.error("no dir:", DIR); process.exit(2); }
const glbs = readdirSync(DIR).filter((f) => f.endsWith(".glb")).sort();
const rows = [];
for (const f of glbs) {
  let bb; try { bb = glbBbox(readFileSync(join(DIR, f))); } catch (e) { rows.push({ f, flag: "PARSE-ERR", note: String(e).slice(0, 60) }); continue; }
  if (bb === null) { rows.push({ f, flag: "NO-BOUNDS", note: "no POSITION min/max" }); continue; }
  const d = bb.mx.map((v, i) => v - bb.mn[i]);
  const size = d.map((v) => v.toFixed(2)).join(" × ");
  const flags = [];
  // DEGENERATE = no meaningful extent at all (a point/empty mesh). A single flat axis is fine
  // (billboards, leaves, decals, a ground quad), so gate on the LARGEST dimension, not any.
  if (Math.max(...d) < DEGEN_M) flags.push("DEGENERATE");
  if (d.some((v) => v > CAP_M)) flags.push("OVERSIZE");
  if (Math.abs(bb.mn[1]) > 1.0) flags.push(`OFF-GROUND(y0=${bb.mn[1].toFixed(1)})`);
  rows.push({ f, flag: flags.join(" ") || "ok", note: size + " m" });
}
const bad = rows.filter((r) => r.flag !== "ok");
for (const r of rows) if (r.flag !== "ok") console.log(`  ✗ ${r.flag.padEnd(22)} ${r.f}  [${r.note}]`);
console.log(`\n${glbs.length} GLBs scanned — ${bad.length} flagged, ${glbs.length - bad.length} clean.`);
process.exit(bad.some((r) => /DEGENERATE|OVERSIZE|PARSE-ERR/.test(r.flag)) ? 1 : 0);
