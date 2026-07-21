// DESIGN DIRECTION — the PROJECT-LEVEL, machine-readable art-style artifact that GOVERNS builds.
//
// Today "art direction" is either reference imagery (art-direction/library/*), a per-leaf recipe card
// (art-direction/SCHEMA.md's card.md, which NO code parses), or a free-text GDS field (gds.ts
// `artDirection: z.string()`) with no downstream consumer. This file promotes that intent into DATA:
// a single typed value the pipeline binds BOTH ways —
//   (a) generative context: build agents / material defaults READ the declared style + palette roles,
//   (b) a falsifiable conformance gate (gates/design/style-conformance-gate.mjs) CHECKS the built
//       result's materials/colors against these declared roles + ranges.
//
// It is DISTINCT from render/look-profile.ts (tonemap / bloom / sky = post/lighting) — this is the
// ART direction (named style, palette ROLES, material language, proportion) that upstream content
// generation and downstream conformance both consume.
//
// Follows js/src/world/world-config.ts + js/src/render/look-profile.ts EXACTLY: a `version` literal,
// `.strict()` sub-objects, parse*/canonical*/serialize* + a DEFAULT_* const, with a byte-stable
// canonical JSON round-trip. No Date / Math.random anywhere (deterministic + replay-safe).
//
// RECONCILIATION with art-direction/SCHEMA.md (the card spec) — what PROMOTED to this project-level DD
// vs. what stays a per-asset card concern:
//   PROMOTED  card.palette (named hex roles)  -> DesignDirection.palette  (role -> colorHex)
//   PROMOTED  card.materials (role -> recipe)  -> DesignDirection.material.roles (role -> recipe + params)
//   PROMOTED  card.tags.style                  -> DesignDirection.style (a named enum, not free text)
//   PROMOTED  card.scale (rough metres)         -> DesignDirection.proportion (unit scale + chunkiness)
//   NOT MAPPED (stay per-leaf on the card, not project-level): card.features / variations /
//     engine_gaps / status / id / title — these describe ONE asset's silhouette + buildability +
//     capability backlog, which is inherently per-asset. `referenceLibrary` here just POINTS at the
//     dotted card ids that anchor the DD; it does not absorb their per-asset bodies.

import { z } from "../../build/zod.bundle.mjs";

const UnitInterval = z.number().min(0).max(1);

// A 24-bit sRGB color as a #rrggbb hex string (the same interpretation as THREE.Color.set / the
// palette presets). Kept as a string so the DD is human-authorable and diff-readable; resolveRoleColor
// parses it to the 0xRRGGBB integer the material layer uses.
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex color");

// ── style: the named art style this project targets ──────────────────────────────────────────────
// A closed, defensible set (NOT free text): the value governs which content-generation defaults and
// material grain a build reaches for. Extend deliberately — every member must be a style the pipeline
// can actually aim at.
export const DESIGN_STYLE_NAMES = [
  "stylized-realism", // limina's default "Grounded Stylized Realism": saturated-but-grounded, textured
  "claymation",       // hand-sculpted, matte, rounded/chunky forms (Aardman-like)
  "pixel",            // low-res, hard-edged, limited palette
  "low-poly",         // faceted, flat-shaded, bright
  "painterly",        // brushed, soft-edged, hand-painted texture
] as const;
export type DesignStyle = (typeof DESIGN_STYLE_NAMES)[number];

// ── palette ROLES: the semantic slots build-time materials + the conformance gate both read ───────
// A closed set of material-semantic roles (project-level), spanning environment, structure, character,
// and focal. Reconciles the card's building-specific roles (accent / trim) into a project vocabulary.
export const PALETTE_ROLE_NAMES = [
  "stone", "wood", "foliage", "ground", "water", "metal", "accent", "trim", "skin", "sky", "slate",
] as const;
export type PaletteRole = (typeof PALETTE_ROLE_NAMES)[number];

const PaletteRoleEnum = z.enum(PALETTE_ROLE_NAMES);

const PaletteEntrySchema = z.object({
  role: PaletteRoleEnum,
  colorHex: HexColor,
}).strict();

// ── material language: the allowed surface envelope + per-role recipes ────────────────────────────
// The global roughness/metalness ENVELOPE the conformance gate holds a build to, plus optional
// per-role recipe hints (promoted from card.materials) the material layer resolves for on-brief
// defaults. Per-role hint params must sit inside the global envelope so a material RESOLVED from the DD
// always passes the DD's own gate (the closed loop the falsifiability check depends on).
const RangeSchema = z.object({
  min: UnitInterval,
  max: UnitInterval,
}).strict();

const MaterialRoleSchema = z.object({
  role: PaletteRoleEnum,
  // A limina material recipe name (e.g. "stone pbr", "stylized water") — the card's role->recipe.
  recipe: z.string().min(1),
  roughness01: UnitInterval,
  metalness01: UnitInterval,
}).strict();

const MaterialLanguageSchema = z.object({
  roughness01: RangeSchema, // the allowed microsurface-roughness window for the whole project
  metalness01: RangeSchema, // the allowed metalness window
  roles: z.array(MaterialRoleSchema), // per-role recipe hints (may be empty)
}).strict();

// ── proportion / scale rules ──────────────────────────────────────────────────────────────────────
const ProportionSchema = z.object({
  // Metres per authored unit — the default world/entity scale a build assumes.
  unitScaleM: z.number().positive(),
  // 0 = slender / delicate, 1 = chunky / blocky. Claymation trends high, low-poly mid, pixel n/a-ish.
  chunkiness01: UnitInterval,
  // Whether silhouettes read grounded/naturalistic or exaggerated/caricatured.
  silhouette: z.enum(["grounded", "exaggerated"]),
}).strict();

export const DesignDirectionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  style: z.enum(DESIGN_STYLE_NAMES),
  palette: z.array(PaletteEntrySchema).min(1),
  material: MaterialLanguageSchema,
  proportion: ProportionSchema,
  // Dotted art-direction/library card ids that anchor this DD (e.g. "buildings.medieval.religious.
  // monastery"). Purely a provenance pointer — the DD does not absorb the cards' per-asset bodies.
  referenceLibrary: z.array(z.string()),
}).strict();

export type PaletteEntry = z.infer<typeof PaletteEntrySchema>;
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;
export type MaterialLanguage = z.infer<typeof MaterialLanguageSchema>;
export type Proportion = z.infer<typeof ProportionSchema>;
export type DesignDirection = z.infer<typeof DesignDirectionSchema>;

export function parseDesignDirection(json: string): DesignDirection {
  return DesignDirectionSchema.parse(JSON.parse(json));
}

// ── Canonicalization: a stable, key-ordered clone so serialize() is byte-identical for equal values.
// Every field is required (arrays may be empty), so there is no optional-omission branching — the
// clone simply re-emits every key in a fixed order. ──────────────────────────────────────────────
function canonicalDesignDirection(d: DesignDirection): DesignDirection {
  return {
    version: d.version,
    id: d.id,
    style: d.style,
    palette: d.palette.map((p) => ({ role: p.role, colorHex: p.colorHex })),
    material: {
      roughness01: { min: d.material.roughness01.min, max: d.material.roughness01.max },
      metalness01: { min: d.material.metalness01.min, max: d.material.metalness01.max },
      roles: d.material.roles.map((r) => ({
        role: r.role,
        recipe: r.recipe,
        roughness01: r.roughness01,
        metalness01: r.metalness01,
      })),
    },
    proportion: {
      unitScaleM: d.proportion.unitScaleM,
      chunkiness01: d.proportion.chunkiness01,
      silhouette: d.proportion.silhouette,
    },
    referenceLibrary: d.referenceLibrary.map((r) => r),
  };
}

export function canonicalizeDesignDirection(d: DesignDirection): DesignDirection {
  return canonicalDesignDirection(d);
}

export function serializeDesignDirection(d: DesignDirection): string {
  return JSON.stringify(canonicalDesignDirection(d));
}

// ── Semantic validation (beyond the structural schema) ────────────────────────────────────────────
/** One semantic problem a structural parse can't express. */
export interface DesignDirectionIssue {
  path: string;
  message: string;
}

/** Structural parse THEN cross-field semantic checks (mirrors gds.ts validateGDS): palette roles must
 *  be unique; every per-role material hint must name a role that exists in the palette AND sit inside
 *  the global roughness/metalness envelope; each range's min must be <= max. Returns the parsed DD
 *  when valid, else a flat issue list (no throw). */
export function validateDesignDirection(
  input: unknown,
): { ok: boolean; data?: DesignDirection; issues: DesignDirectionIssue[] } {
  const parsed = DesignDirectionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const dd = parsed.data;
  const issues: DesignDirectionIssue[] = [];

  // Unique palette roles.
  const seen = new Set<string>();
  for (const p of dd.palette) {
    if (seen.has(p.role)) issues.push({ path: `palette.${p.role}`, message: `duplicate palette role "${p.role}"` });
    seen.add(p.role);
  }

  // Ranges: min <= max.
  for (const key of ["roughness01", "metalness01"] as const) {
    const r = dd.material[key];
    if (r.min > r.max) issues.push({ path: `material.${key}`, message: `range min ${r.min} > max ${r.max}` });
  }

  // Per-role material hints: role must exist in palette AND params within the global envelope.
  const paletteRoles = new Set(dd.palette.map((p) => p.role));
  for (const r of dd.material.roles) {
    if (!paletteRoles.has(r.role)) {
      issues.push({ path: `material.roles.${r.role}`, message: `material role "${r.role}" has no palette color` });
    }
    if (r.roughness01 < dd.material.roughness01.min || r.roughness01 > dd.material.roughness01.max) {
      issues.push({ path: `material.roles.${r.role}`, message: `roughness ${r.roughness01} outside envelope [${dd.material.roughness01.min}, ${dd.material.roughness01.max}]` });
    }
    if (r.metalness01 < dd.material.metalness01.min || r.metalness01 > dd.material.metalness01.max) {
      issues.push({ path: `material.roles.${r.role}`, message: `metalness ${r.metalness01} outside envelope [${dd.material.metalness01.min}, ${dd.material.metalness01.max}]` });
    }
  }

  return issues.length === 0 ? { ok: true, data: dd, issues: [] } : { ok: false, data: dd, issues };
}

// ── DEFAULT — limina's shipped "Grounded Stylized Realism" direction ──────────────────────────────
// Palette colors are grounded in the existing material presets (materials/palette.ts) so the default DD
// and the shipped preset library agree; accent/trim/skin/sky fill the roles the presets don't name.
export const DEFAULT_DESIGN_DIRECTION: DesignDirection = {
  version: 1,
  id: "grounded-stylized-realism",
  style: "stylized-realism",
  palette: [
    { role: "stone", colorHex: "#9b9890" },   // MATERIALS.stone
    { role: "wood", colorHex: "#8a5a2b" },     // MATERIALS.wood
    { role: "foliage", colorHex: "#357a2b" },  // MATERIALS.foliage
    { role: "ground", colorHex: "#59a83a" },   // MATERIALS.grass
    { role: "water", colorHex: "#2e8bc0" },    // MATERIALS.water
    { role: "metal", colorHex: "#c2c6cc" },    // MATERIALS.metal
    { role: "accent", colorHex: "#d98f2b" },   // warm lantern focal (the Blight-gradient accent)
    { role: "trim", colorHex: "#6f675e" },     // MATERIALS.rock — dark structural trim
    { role: "skin", colorHex: "#c8a27a" },     // neutral character skin
    { role: "sky", colorHex: "#b9c4cc" },      // hazed sky (matches world-config default fog)
    { role: "slate", colorHex: "#49535d" },    // dark blue-grey slate (roof shingles)
  ],
  material: {
    // Grounded stylized realism = mostly-diffuse dielectrics with a couple of low-roughness exceptions
    // (water, polished metal). The envelope spans those so any role hint stays inside it.
    roughness01: { min: 0.10, max: 0.98 },
    metalness01: { min: 0.0, max: 1.0 },
    roles: [
      { role: "stone", recipe: "stone pbr", roughness01: 0.82, metalness01: 0.0 },
      { role: "wood", recipe: "timber pbr", roughness01: 0.72, metalness01: 0.0 },
      { role: "metal", recipe: "steel pbr", roughness01: 0.38, metalness01: 1.0 },
      { role: "water", recipe: "stylized water", roughness01: 0.14, metalness01: 0.0 },
    ],
  },
  proportion: {
    unitScaleM: 1.0,
    chunkiness01: 0.35,
    silhouette: "grounded",
  },
  referenceLibrary: [
    "buildings.medieval.religious.monastery",
    "creatures.blighted.shambler",
    "props.camp.signal-fire",
  ],
};
