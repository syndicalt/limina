// BUILDING BRIEF — the PER-BUILDING-TYPE build description that comes OUT OF the GDD planning session.
//
// The project-level DesignDirection (design-direction.ts) governs ONE style / palette / material
// envelope for the WHOLE game. But a monastery is not a cottage: they differ in construction, storeys,
// roof, ornament, and which palette role clads which structural element. That per-TYPE art direction
// has nowhere to live in the DD (by design) — it belongs here, authored during GDD planning (the
// director intake stage FILLS a brief per building content item) and CONSUMED by the build agent.
//
// A brief is DECLARATIVE ART DIRECTION, not geometry: it says "cut-stone, one tall storey, steep slate
// gable, high ornament, leaded-arched openings" — `briefToRecipe` turns that into the STRUCTURAL recipe
// the tested assembler (skills/building-recipe.ts) raises. The build agent never hand-authors a bespoke
// model; it authors/edits a brief, and the kit toolkit realizes it.
//
// UNIVERSAL vs PER-TYPE — the two-level split the pivot asked for:
//   • BUILDING_CRAFT_PRINCIPLES below = UNIVERSAL build-agent discipline (structural honesty, material
//     logic, physically-correct texture orientation, weathering). They apply to EVERY building and are
//     enforced by the asset QC gate — NOT re-authored per game.
//   • A BuildingBrief = PER-TYPE art direction, authored per game in the planning session, different for
//     a cottage vs a monastery.
//
// Follows design-direction.ts EXACTLY: a `version` literal, `.strict()` sub-objects, parse/validate +
// DEFAULT_* / library consts, deterministic (no Date / Math.random) so it is replay-safe and its JSON
// Schema (via z.toJSONSchema) can gate the GDS artifact at the pipeline boundary.

import { z } from "../../build/zod.bundle.mjs";
import { PALETTE_ROLE_NAMES, type PaletteRole } from "./design-direction.ts";

// ── Universal craft principles — the build-agent DISCIPLINE (not per-game) ──────────────────────────
// Each principle is (id, statement, realizedBy, gatedBy): the STATEMENT the agent must honour, HOW the
// kit toolkit realizes it, and HOW the asset QC gate falsifies a violation. Encoding them as data (not
// prose) lets the build agent read them and the gate reference them by id. Derived from the Norman
// wattle-and-daub critique but written to hold for ANY building type.
export interface CraftPrinciple {
  id: string;
  statement: string;
  realizedBy: string;
  gatedBy: string;
}

export const BUILDING_CRAFT_PRINCIPLES: readonly CraftPrinciple[] = [
  {
    id: "structural-honesty",
    statement:
      "The frame must read LOAD-BEARING: heavy corner posts carrying to the ground, continuous beams at the sill + eave (wall-plate) lines, studs dividing coherent bays, and diagonal braces triangulating the corners. Never a decorative even grid of identical sticks carrying nothing.",
    realizedBy:
      "kit.ts wallPanel emits thicker corner posts + full-width top-plate/sill + bay studs + a single clean 45° corner knee brace per lower bay; the recipe stacks these on a base course so the frame sits on masonry.",
    gatedBy: "asset-qc-gate fidelity floors (vertex/triangle/material counts) reject a flat box; the silhouette gate rejects a samey set.",
  },
  {
    id: "construction-material-logic",
    statement:
      "Materials follow real construction for the building's `construction` type: masonry load-bearing base + timber-framed (often jettied) upper for wattle-and-daub; ashlar cut-stone throughout for a monastery/keep; the right material clads each structural role.",
    realizedBy: "briefToRecipe sets construction → base-course height + wall part material; assembleBuilding raises a stone base course then timber-frame walls above it.",
    gatedBy: "asset-qc-gate theme axis (materials stay inside the DesignDirection palette + roughness/metalness envelope).",
  },
  {
    id: "texture-orientation",
    statement:
      "Textures respect physical reality: roof cover (slate/tile/thatch) lies on the SLOPES ONLY and never wraps onto vertical faces; gable edges are timber BARGEBOARDS, eaves get a fascia; wood grain runs ALONG the timber.",
    realizedBy: "assembleBuilding clads the roof prism with the cover material but frames every exposed roof edge with timber bargeboards + eave fascia, so no vertical edge shows a triplanar-wrapped shingle.",
    gatedBy: "silhouette / style-conformance gates on the baked GLB; a bargeboard-less gable is a visible fail in the golden compare.",
  },
  {
    id: "weathering-realism",
    statement:
      "Surfaces are aged, irregular, and matte (adze-marked oak, hand-daubed plaster) to the brief's `weathering01` — not a synthetic repeating plank grain.",
    realizedBy: "the DesignDirection material recipes (timber/plaster/slate procedural textures) carry the grain; weathering01 scales their variation amplitude.",
    gatedBy: "style-conformance roughness envelope; the fidelity ratchet's surface-detail (normal/relief energy) floor.",
  },
] as const;

// ── Enums the brief is built from (closed sets — the planner picks from these) ──────────────────────

/** The structural SYSTEM — drives the material-logic + frame principles. Extend deliberately. */
export const CONSTRUCTION_NAMES = [
  "timber-frame-daub",       // timber post-and-truss frame with daub/plaster infill (cottage, hall)
  "stone-base-timber-upper", // masonry ground floor + timber-framed (often jettied) upper storey (manor)
  "cut-stone",               // ashlar load-bearing masonry throughout (monastery, keep, church)
  "cob",                     // monolithic earth walls, thick + rounded (humble cottage/outbuilding)
  "log",                     // stacked-timber walls (frontier/rustic)
] as const;
export type Construction = (typeof CONSTRUCTION_NAMES)[number];

export const ROOF_SHAPE_NAMES = ["gable", "hip", "flat"] as const;
export type RoofShape = (typeof ROOF_SHAPE_NAMES)[number];

export const ROOF_PITCH_NAMES = ["shallow", "medium", "steep"] as const;
export type RoofPitchName = (typeof ROOF_PITCH_NAMES)[number];

export const ROOF_COVER_NAMES = ["slate", "tile", "thatch", "shingle"] as const;
export type RoofCover = (typeof ROOF_COVER_NAMES)[number];

export const ORNAMENT_NAMES = ["plain", "modest", "high"] as const;
export type Ornament = (typeof ORNAMENT_NAMES)[number];

export const OPENING_STYLE_NAMES = ["plain", "shuttered", "leaded", "arched"] as const;
export type OpeningStyle = (typeof OPENING_STYLE_NAMES)[number];

/** The structural ELEMENTS a brief can assign a palette role to. `wall` = the infill/cladding face,
 *  `base` = the plinth + any masonry base course, `frame` = timber members, `roofCover` = the shingles/
 *  thatch, `trim` = bargeboards/fascia/quoins. */
export const BUILDING_ELEMENTS = ["wall", "base", "frame", "roofCover", "trim"] as const;
export type BuildingElement = (typeof BUILDING_ELEMENTS)[number];

// ── The brief schema ────────────────────────────────────────────────────────────────────────────────

const PaletteRoleEnum = z.enum(PALETTE_ROLE_NAMES);

const RoofBriefSchema = z.object({
  shape: z.enum(ROOF_SHAPE_NAMES).default("gable"),
  pitch: z.enum(ROOF_PITCH_NAMES).default("medium"),
  cover: z.enum(ROOF_COVER_NAMES).default("slate"),
  /** Timber bargeboards on the gable edges + an eave fascia. Default TRUE for any timber-framed type
   *  (the texture-orientation principle); a cut-stone build may carry stone verges instead. */
  bargeboards: z.boolean().default(true),
}).strict();

/** Which palette role clads each structural element. Every value must be a real DesignDirection palette
 *  role (referential integrity checked in validateBuildingBrief against the active DD's palette). */
const MaterialByElementSchema = z.object({
  wall: PaletteRoleEnum,
  base: PaletteRoleEnum,
  frame: PaletteRoleEnum,
  roofCover: PaletteRoleEnum,
  trim: PaletteRoleEnum,
}).strict();

export const BuildingBriefSchema = z.object({
  version: z.literal(1),
  /** Dotted archetype id matching art-direction/library (e.g. "buildings.medieval.dwelling.cottage"). */
  id: z.string().min(1),
  name: z.string().min(1),
  construction: z.enum(CONSTRUCTION_NAMES),
  storeys: z.number().int().min(1).max(4).default(1),
  /** Per-storey wall height in metres (the base course + roof are added on top). */
  storeyHeightM: z.number().positive().max(20).default(2.6),
  /** Rough footprint hint the planner may honour or override for site fit (metres). */
  footprintM: z.object({ width: z.number().positive().max(120), depth: z.number().positive().max(120) }).strict().optional(),
  roof: RoofBriefSchema.prefault({}),
  material: MaterialByElementSchema,
  ornament: z.enum(ORNAMENT_NAMES).default("modest"),
  openingStyle: z.enum(OPENING_STYLE_NAMES).default("plain"),
  /** 0 = crisp/new, 1 = heavily weathered. Scales the material grain variation amplitude. */
  weathering01: z.number().min(0).max(1).default(0.5),
  /** Prose escape hatch for nuance the structured fields can't carry (the build agent reads it). */
  notes: z.string().optional(),
}).strict();

export type RoofBrief = z.infer<typeof RoofBriefSchema>;
export type MaterialByElement = z.infer<typeof MaterialByElementSchema>;
export type BuildingBrief = z.infer<typeof BuildingBriefSchema>;

export function parseBuildingBrief(json: string): BuildingBrief {
  return BuildingBriefSchema.parse(JSON.parse(json));
}

// ── Semantic validation (beyond structure) ──────────────────────────────────────────────────────────
export interface BuildingBriefIssue {
  path: string;
  message: string;
}

/** Structural parse THEN cross-field checks. When `paletteRoles` is supplied (the active DD's palette),
 *  every material element must name a role that palette actually defines — the same referential-
 *  integrity discipline gds.ts/design-direction.ts use. Returns the parsed brief when valid, else a flat
 *  issue list (no throw). */
export function validateBuildingBrief(
  input: unknown,
  paletteRoles?: readonly PaletteRole[],
): { ok: boolean; data?: BuildingBrief; issues: BuildingBriefIssue[] } {
  const parsed = BuildingBriefSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const brief = parsed.data;
  const issues: BuildingBriefIssue[] = [];

  if (paletteRoles !== undefined) {
    const have = new Set<string>(paletteRoles);
    for (const el of BUILDING_ELEMENTS) {
      const role = brief.material[el];
      if (!have.has(role)) issues.push({ path: `material.${el}`, message: `element "${el}" clads with role "${role}" which the design direction's palette does not define` });
    }
  }

  // A timber-framed type with bargeboards off is a texture-orientation risk — warn (not fatal) via issue.
  // (Kept as an issue so a strict gate can treat it as a fail; briefToRecipe still builds it.)
  if ((brief.construction === "timber-frame-daub" || brief.construction === "stone-base-timber-upper") && brief.roof.bargeboards === false) {
    issues.push({ path: "roof.bargeboards", message: "timber-framed construction should carry bargeboards (texture-orientation principle); set true unless intentionally stone-verged" });
  }

  return issues.length === 0 ? { ok: true, data: brief, issues: [] } : { ok: false, data: brief, issues };
}

// ── Canonicalization (byte-stable clone, mirrors design-direction.ts) ────────────────────────────────
export function canonicalizeBuildingBrief(b: BuildingBrief): BuildingBrief {
  return {
    version: b.version,
    id: b.id,
    name: b.name,
    construction: b.construction,
    storeys: b.storeys,
    storeyHeightM: b.storeyHeightM,
    ...(b.footprintM !== undefined ? { footprintM: { width: b.footprintM.width, depth: b.footprintM.depth } } : {}),
    roof: { shape: b.roof.shape, pitch: b.roof.pitch, cover: b.roof.cover, bargeboards: b.roof.bargeboards },
    material: { wall: b.material.wall, base: b.material.base, frame: b.material.frame, roofCover: b.material.roofCover, trim: b.material.trim },
    ornament: b.ornament,
    openingStyle: b.openingStyle,
    weathering01: b.weathering01,
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
  };
}

export function serializeBuildingBrief(b: BuildingBrief): string {
  return JSON.stringify(canonicalizeBuildingBrief(b));
}

/** Emit the JSON Schema for a building brief so llmff's validate_json stage can gate it at the pipeline
 *  boundary (same pattern as gds.ts gdsJsonSchema). Deterministic; no external dependency. */
export function buildingBriefJsonSchema(): Record<string, unknown> {
  const toJSONSchema = (z as unknown as {
    toJSONSchema: (s: unknown, o?: Record<string, unknown>) => Record<string, unknown>;
  }).toJSONSchema;
  return toJSONSchema(BuildingBriefSchema, { unrepresentable: "any", target: "draft-7" });
}

// ── The starter archetype LIBRARY — reusable briefs GDD planning selects + customizes ───────────────
// One brief per medieval building archetype, keyed to the art-direction/library dotted ids. The GDD
// planning session picks the archetypes a game needs and tweaks them; it does NOT re-derive a cottage
// from scratch every game. Material roles reference the shipped DEFAULT_DESIGN_DIRECTION palette.

/** A humble tenant COTTAGE: timber post-and-truss frame on a low stone plinth, daub infill, a steep
 *  slate gable with timber bargeboards. The Norman wattle-and-daub the critique was drawn from. */
export const COTTAGE_BRIEF: BuildingBrief = {
  version: 1,
  id: "buildings.medieval.dwelling.cottage",
  name: "Tenant cottage",
  construction: "timber-frame-daub",
  storeys: 1,
  storeyHeightM: 2.6,
  footprintM: { width: 7.5, depth: 6 },
  roof: { shape: "gable", pitch: "steep", cover: "slate", bargeboards: true },
  material: { wall: "stone", base: "trim", frame: "wood", roofCover: "slate", trim: "wood" },
  ornament: "plain",
  openingStyle: "shuttered",
  weathering01: 0.6,
  notes: "Daub infill tinted off the stone role; heavy oak corner posts to the ground; low undressed-stone plinth.",
};

/** A village MONASTERY: ashlar cut-stone throughout, one tall storey (the nave), a steep slate gable,
 *  high ornament (buttressed, arched leaded openings). Deliberately DIFFERENT art direction to a
 *  cottage from the SAME toolkit — the pivot's test case. */
export const MONASTERY_BRIEF: BuildingBrief = {
  version: 1,
  id: "buildings.medieval.religious.monastery",
  name: "Monastery",
  construction: "cut-stone",
  storeys: 1,
  storeyHeightM: 5.0,
  footprintM: { width: 12, depth: 20 },
  roof: { shape: "gable", pitch: "steep", cover: "slate", bargeboards: false },
  material: { wall: "stone", base: "stone", frame: "trim", roofCover: "slate", trim: "stone" },
  ornament: "high",
  openingStyle: "arched",
  weathering01: 0.4,
  notes: "Dressed ashlar, no timber frame on the walls; tall narrow arched leaded windows; stone verges, not bargeboards.",
};

/** A fortified KEEP: heavy cut-stone, multi-storey, a shallow-pitched (or near-flat crenellated) roof,
 *  plain ornament, narrow arrow-slit openings. */
export const KEEP_BRIEF: BuildingBrief = {
  version: 1,
  id: "buildings.medieval.military.keep",
  name: "Keep",
  construction: "cut-stone",
  storeys: 3,
  storeyHeightM: 3.4,
  footprintM: { width: 14, depth: 14 },
  roof: { shape: "flat", pitch: "shallow", cover: "slate", bargeboards: false },
  material: { wall: "stone", base: "stone", frame: "trim", roofCover: "slate", trim: "trim" },
  ornament: "plain",
  openingStyle: "plain",
  weathering01: 0.55,
  notes: "Battered cut-stone walls, narrow deep-set openings, a crenellated wall-walk over a near-flat roof.",
};

/** A civic LONGHALL: timber frame on a stone base, two storeys, a long medium-pitch slate gable. */
export const LONGHALL_BRIEF: BuildingBrief = {
  version: 1,
  id: "buildings.medieval.civic.longhall",
  name: "Longhall",
  construction: "stone-base-timber-upper",
  storeys: 2,
  storeyHeightM: 2.9,
  footprintM: { width: 9, depth: 18 },
  roof: { shape: "gable", pitch: "medium", cover: "slate", bargeboards: true },
  material: { wall: "stone", base: "stone", frame: "wood", roofCover: "slate", trim: "wood" },
  ornament: "modest",
  openingStyle: "leaded",
  weathering01: 0.5,
  notes: "Cut-stone ground floor, jettied timber-framed upper storey; long ridge; leaded upper windows.",
};

/** The shipped library, keyed by archetype id. GDD planning selects + customizes. */
export const BUILDING_ARCHETYPES: Readonly<Record<string, BuildingBrief>> = {
  [COTTAGE_BRIEF.id]: COTTAGE_BRIEF,
  [MONASTERY_BRIEF.id]: MONASTERY_BRIEF,
  [KEEP_BRIEF.id]: KEEP_BRIEF,
  [LONGHALL_BRIEF.id]: LONGHALL_BRIEF,
};

/** Look up a shipped archetype brief by dotted id (undefined if the game authors its own). */
export function archetypeBrief(id: string): BuildingBrief | undefined {
  return BUILDING_ARCHETYPES[id];
}
