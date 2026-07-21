// STYLE-CONFORMANCE DESIGN GATE (Phase A3) — the second, DATA-driven half of the design-direction
// binding. Where silhouette-gate.mjs checks that a build's SHAPES are distinct, this gate checks that
// a build's SURFACES are ON-BRIEF: it holds a set of built entities' materials (color + roughness +
// metalness) against a project's Design Direction (js/src/game/design-direction.ts) — the same
// machine-readable artifact build agents read to pick colors. A build whose materials stay inside the
// DD's declared palette + surface envelope PASSES; an off-brief build (a color outside the palette, or
// a surface outside the roughness envelope) HARD-FAILS.
//
// It consumes the DD as its SERIALIZED plain-object form (serializeDesignDirection) — the wire format,
// decoupled from the TS runtime exactly as silhouette-gate is decoupled from the engine. No model, no
// network, no GPU: pure color/param geometry, so it runs even on a headless CI box.
//
//   import { runStyleConformanceGate } from "./style-conformance-gate.mjs"
//   const verdict = runStyleConformanceGate(dd, [{ label, colorHex, roughness01, metalness01 }], opts)
//     // -> { pass, score, failures:[{gate, detail}], stats }

// Thresholds. `colorTolerance` is a Euclidean sRGB distance (0..441); a material whose nearest palette
// color is farther than this is judged off-palette. `rangeEps` tolerates float noise at the envelope
// edges. `conformRatio` is the share of materials that must conform for a soft/hard split.
export const THRESHOLDS = { colorTolerance: 45, rangeEps: 1e-6, conformRatio: 0.999 };

/** #rrggbb -> {r,g,b} 0..255. Accepts a 0xRRGGBB integer too (so callers can pass either form). */
export function toRgb(color) {
  let n;
  if (typeof color === "number") n = color >>> 0;
  else {
    const s = String(color).trim().replace(/^#/, "");
    n = parseInt(s, 16);
  }
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Euclidean distance in sRGB (0..~441.7). Cheap, deterministic, good enough to separate an on-brief
 *  tint from an off-brief hue — the falsification the check exercises. */
export function colorDistance(a, b) {
  const x = toRgb(a), y = toRgb(b);
  const dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Nearest palette color distance for one color, plus which role it matched. */
export function nearestRole(dd, color) {
  let best = Infinity, role = null;
  for (const p of dd.palette) {
    const d = colorDistance(color, p.colorHex);
    if (d < best) { best = d; role = p.role; }
  }
  return { distance: best, role };
}

/** Resolve a palette role's color from a serialized DD (the JS twin of palette.ts resolveRoleColor;
 *  the check uses it to build an on-brief set FROM the DD, so on-brief is closed-loop, not hand-picked). */
export function resolveRoleColor(dd, role) {
  const entry = dd.palette.find((p) => p.role === role);
  if (!entry) throw new Error(`design direction "${dd.id}" declares no color for role "${role}"`);
  return entry.colorHex;
}

/** The verdict over a set of built materials. Each material = { label?, colorHex|color, roughness01,
 *  metalness01 }. Returns { pass, score, failures:[{gate, detail}], stats } in the gamestack shape. */
export function styleConformanceVerdict(dd, materials, t = THRESHOLDS) {
  const failures = [];
  if (!dd || !Array.isArray(dd.palette) || dd.palette.length === 0) {
    return { pass: false, score: 0, failures: [{ gate: "input", detail: "design direction has no palette" }], stats: { checked: 0, conforming: 0 } };
  }
  const rough = dd.material.roughness01, metal = dd.material.metalness01;

  const offPalette = [], offRough = [], offMetal = [];
  for (const m of materials) {
    const label = m.label ?? "(unlabeled)";
    const color = m.colorHex ?? m.color;
    const { distance, role } = nearestRole(dd, color);
    if (distance > t.colorTolerance) {
      offPalette.push(`${label} (nearest ${role} +${distance.toFixed(0)})`);
    }
    if (typeof m.roughness01 === "number" && (m.roughness01 < rough.min - t.rangeEps || m.roughness01 > rough.max + t.rangeEps)) {
      offRough.push(`${label} (r=${m.roughness01} vs [${rough.min}, ${rough.max}])`);
    }
    if (typeof m.metalness01 === "number" && (m.metalness01 < metal.min - t.rangeEps || m.metalness01 > metal.max + t.rangeEps)) {
      offMetal.push(`${label} (m=${m.metalness01} vs [${metal.min}, ${metal.max}])`);
    }
  }

  if (offPalette.length) failures.push({ gate: "palette", detail: `${offPalette.length} off-palette color(s): ${offPalette.slice(0, 6).join("; ")}` });
  if (offRough.length) failures.push({ gate: "roughness", detail: `${offRough.length} material(s) outside the roughness envelope: ${offRough.slice(0, 6).join("; ")}` });
  if (offMetal.length) failures.push({ gate: "metalness", detail: `${offMetal.length} material(s) outside the metalness envelope: ${offMetal.slice(0, 6).join("; ")}` });

  const offenders = new Set([...offPalette, ...offRough, ...offMetal].map((s) => s.split(" ")[0]));
  const checked = materials.length;
  const conforming = Math.max(0, checked - offenders.size);
  const ratio = checked ? conforming / checked : 1;
  // HARD-FAIL on ANY off-brief material — an art direction that tolerates an off-palette surface is not
  // governing the build. (Same discipline as silhouette-gate: any clone is a hard fail.)
  const hard = failures.length > 0;
  return { pass: !hard, score: Number(ratio.toFixed(3)), failures, stats: { checked, conforming } };
}

export function runStyleConformanceGate(dd, materials, opts = {}) {
  return styleConformanceVerdict(dd, materials, opts.thresholds ?? THRESHOLDS);
}
