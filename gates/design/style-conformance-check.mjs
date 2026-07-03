// FALSIFIABILITY CHECK for the style-conformance design gate. The discipline test that the gate is
// REAL, not a rubber-stamp: a build whose materials are drawn FROM the Design Direction's own palette
// (on-brief) must PASS, and a build that injects off-palette / off-envelope surfaces (off-brief) must
// HARD-FAIL. If the off-brief set passes, the gate is a no-op and this exits non-zero.
//
// The on-brief set is built by RESOLVING roles from the SAME DD the gate checks against (closed-loop,
// not hand-picked to pass) — mirroring silhouette-gate/check.mjs's distinct-vs-oatmeal discipline.
//
// Run: node gates/design/style-conformance-check.mjs   (exit 0 = real + falsifiable · 1 = rubber-stamp)

import { runStyleConformanceGate, resolveRoleColor } from "./style-conformance-gate.mjs";

// A representative Design Direction in its serialized (plain-object) wire form — the same shape
// serializeDesignDirection(DEFAULT_DESIGN_DIRECTION) emits: an earthy "grounded stylized realism"
// palette with a mostly-diffuse surface envelope (water/metal are the low-roughness exceptions).
const DD = {
  version: 1,
  id: "grounded-stylized-realism",
  style: "stylized-realism",
  palette: [
    { role: "stone", colorHex: "#9b9890" },
    { role: "wood", colorHex: "#8a5a2b" },
    { role: "foliage", colorHex: "#357a2b" },
    { role: "ground", colorHex: "#59a83a" },
    { role: "water", colorHex: "#2e8bc0" },
    { role: "metal", colorHex: "#c2c6cc" },
    { role: "accent", colorHex: "#d98f2b" },
    { role: "trim", colorHex: "#6f675e" },
    { role: "skin", colorHex: "#c8a27a" },
    { role: "sky", colorHex: "#b9c4cc" },
  ],
  material: { roughness01: { min: 0.10, max: 0.98 }, metalness01: { min: 0.0, max: 1.0 }, roles: [] },
  proportion: { unitScaleM: 1.0, chunkiness01: 0.35, silhouette: "grounded" },
  referenceLibrary: [],
};

// ON-BRIEF: colors resolved straight from the DD palette (a couple lightly tinted, still within
// tolerance), surfaces inside the envelope. A build that honoured the art direction.
function tint(hex, d) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + d));
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, "0")).join("");
}
const ON_BRIEF = [
  { label: "wall", colorHex: resolveRoleColor(DD, "stone"), roughness01: 0.82, metalness01: 0.0 },
  { label: "beam", colorHex: tint(resolveRoleColor(DD, "wood"), 8), roughness01: 0.72, metalness01: 0.0 },
  { label: "canopy", colorHex: resolveRoleColor(DD, "foliage"), roughness01: 0.80, metalness01: 0.0 },
  { label: "pond", colorHex: resolveRoleColor(DD, "water"), roughness01: 0.14, metalness01: 0.0 },
  { label: "blade", colorHex: resolveRoleColor(DD, "metal"), roughness01: 0.38, metalness01: 1.0 },
  { label: "lantern", colorHex: tint(resolveRoleColor(DD, "accent"), -6), roughness01: 0.6, metalness01: 0.0 },
];

// OFF-BRIEF: a garish hot-magenta prop far outside the earthy palette, plus a mirror-glossy surface
// below the roughness floor and a neon-cyan clone — a build that ignored the art direction.
const OFF_BRIEF = [
  { label: "wall", colorHex: resolveRoleColor(DD, "stone"), roughness01: 0.82, metalness01: 0.0 }, // still on-brief
  { label: "magenta-prop", colorHex: "#ff00ff", roughness01: 0.5, metalness01: 0.0 },              // off-palette
  { label: "mirror-floor", colorHex: resolveRoleColor(DD, "ground"), roughness01: 0.03, metalness01: 0.0 }, // below floor
  { label: "neon-sign", colorHex: "#00ffcc", roughness01: 0.5, metalness01: 0.0 },                 // off-palette
];

const on = runStyleConformanceGate(DD, ON_BRIEF);
console.error(`  on-brief:  pass=${on.pass} score=${on.score} ${JSON.stringify(on.stats)} failures=${on.failures.length ? JSON.stringify(on.failures) : "none"}`);
const off = runStyleConformanceGate(DD, OFF_BRIEF);
console.error(`  off-brief: pass=${off.pass} score=${off.score} ${JSON.stringify(off.stats)} failures=${JSON.stringify(off.failures)}`);

let ok = true;
if (!on.pass) { console.error("FAIL: the on-brief set should PASS but didn't — gate too strict."); ok = false; }
if (off.pass) { console.error("FAIL: the off-brief set should HARD-FAIL but PASSED — the gate is a no-op stub."); ok = false; }

console.log(ok
  ? `check-style-conformance OK: on-brief PASSES (score ${on.score}), off-brief HARD-FAILS (score ${off.score}, ${off.failures.map((f) => f.gate).join("+")}). The conformance gate is real + falsifiable.`
  : "check-style-conformance FAILED.");
process.exit(ok ? 0 : 1);
