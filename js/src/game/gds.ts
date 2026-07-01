// GAME DESIGN SPEC (GDS) — the spine artifact of the game-director pipeline (M2).
//
// Every stage reads/writes this one typed document: intake (parse a design doc OR interview)
// FILLS it; the planner reads it; the functional-gate generator (M3) compiles its DoD
// assertions into a headless test; the coordinator (M4) builds against it. TypeScript + Zod is
// the single source of truth (matching the engine's skill IO + worldlog validation), and the
// SAME schema emits a JSON Schema (zod v4 `z.toJSONSchema`) so llmff's `validate_json` stage can
// gate every inter-stage artifact at the pipeline boundary.
//
// The structural schema (`GameDesignSpecSchema`) is kept JSON-Schema-representable (no custom
// refinements), so the emitted schema is clean. Richer cross-field invariants (referential
// integrity; a state-transition DoD must carry a drive script) live in `validateGDS`, which runs
// the structural parse THEN the semantic checks.

import { z } from "../../build/zod.bundle.mjs";

// ── Controls ──────────────────────────────────────────────────────────────────────────────────
export const ControlSchemeSchema = z.object({
  scheme: z.enum(["keyboard-mouse", "gamepad", "touch"]),
  /** Named intents the game reads (e.g. "move-forward" -> "KeyW"). */
  intents: z.array(z.object({
    name: z.string().min(1),
    binding: z.string().min(1),
    description: z.string().optional(),
  })).min(1),
});

// ── Entities ──────────────────────────────────────────────────────────────────────────────────
export const EntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["player", "npc", "hazard", "pickup", "prop"]),
  /** Discrete states this entity can be in (drives DoD coverage). */
  states: z.array(z.string().min(1)).default([]),
});

// ── Mechanics (mapped to existing skills or flagged NEW) ────────────────────────────────────────
export const MechanicSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Which existing skill/manager covers it (e.g. "interaction.pickup"), or "NEW:<desc>". */
  skill: z.string().min(1),
});

// ── Content manifest (drives the asset pipeline) ────────────────────────────────────────────────
export const ContentItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["character", "prop", "environment", "audio"]),
  prompt: z.string().min(1),
  source: z.enum(["procedural", "poly-pizza", "3d-ai-studio", "generate"]),
  // ── Design-gate fields (the silhouette/readability gate scores against these). All OPTIONAL so
  //    existing specs stay valid; the silhouette gate skips items without a resolved `asset`. ──
  /** The resolved glTF id once the asset pipeline has sourced it (e.g. "pine.glb"). The design gate
   *  renders this to a silhouette; absent until sourcing runs. */
  asset: z.string().min(1).optional(),
  /** Silhouette distinctness group — the gate checks sameness WITHIN a tier. Defaults to `kind`. */
  tier: z.string().min(1).optional(),
  /** art-direction-and-readability's per-asset "read contract": the one gameplay question this asset's
   *  silhouette must let the player answer ("is it cover? a pickup? an enemy?"). */
  readContract: z.string().min(1).optional(),
});

// ── DoD assertions (the falsifiable gate, generated into M3 tests) ──────────────────────────────
/** One post-condition the M3 runner checks after replaying a drive script. The `check` vocabulary
 *  is closed so the generator can implement each against the live managers. */
export const AssertionSchema = z.object({
  check: z.enum(["gameState", "counterAtLeast", "flagTrue", "flagFalse", "hpAtLeast", "questStatus", "playerReachedXZ"]),
  /** The thing checked: a counter name, flag name, quest id, a state string, or "x,z" target. */
  target: z.string().optional(),
  /** Expected value (state string / numeric threshold / boolean). */
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/** A machine-runnable drive script: a sequence of fixed-step inputs (each optionally repeated)
 *  followed by post-conditions. The M3 generator builds a game and replays this to assert. */
export const InputScriptSchema = z.object({
  description: z.string().optional(),
  steps: z.array(z.object({
    forward: z.number().optional(),
    strafe: z.number().optional(),
    yaw: z.number().optional(),
    run: z.boolean().optional(),
    jump: z.boolean().optional(),
    choose: z.number().int().optional(),
    /** "walkToward:<entityId>" / "walkToward:<x,z>" — resolve the yaw each step toward a target. */
    toward: z.string().optional(),
    /** Repeat this frame N fixed steps (default 1). The script may also stop early on its own. */
    repeat: z.number().int().positive().default(1),
    /** Stop repeating this frame once a named predicate holds (e.g. "accepted", "reached"). */
    until: z.string().optional(),
  })).min(1),
  assert: z.array(AssertionSchema).min(1),
});

export const DoDAssertionSchema = z.object({
  id: z.string().min(1),
  /** Human-readable invariant (e.g. "declining keeps the quest unaccepted"). */
  statement: z.string().min(1),
  /** state-transition → automated (tier 1, MUST carry `drives`); feel → human UAT only. */
  kind: z.enum(["state-transition", "feel"]),
  drives: InputScriptSchema.optional(),
});

// ── World slice (the spatial layout the World Designer edits) ───────────────────────────────────
// The design-level `entities`/`content` above say WHAT exists; the world slice says WHERE each
// instance sits and how it looks. Every placement references a design entity OR a content item by id
// (referential integrity checked in `validateGDS`). The whole slice is OPTIONAL on the spec so
// pre-world specs stay valid — the World Designer fills it and Compile assembles it into a runnable
// world. Kept JSON-Schema-representable (only built-in constraints), like the rest of the structural
// schema; the xor/reference invariants are semantic checks, not refinements here.

/** A 3-number vector [x, y, z]. Exact length so the emitted JSON Schema stays a clean fixed array. */
export const Vec3Schema = z.array(z.number()).length(3);

export const TransformSchema = z.object({
  /** World-space position [x, y, z]. */
  position: Vec3Schema,
  /** Euler rotation in RADIANS [x, y, z] (yaw is y). The quaternion is derived at build time; Euler
   *  keeps the GDS human- and diff-readable. */
  rotation: Vec3Schema.default([0, 0, 0]),
  /** Per-axis scale [x, y, z]; [1, 1, 1] is unscaled. */
  scale: Vec3Schema.default([1, 1, 1]),
});

/** A per-placement look override applied over the asset's own material (via the `three.setMaterial`
 *  skill on build). All fields optional — absent means the asset's default. */
export const MaterialOverrideSchema = z.object({
  /** Named material id resolved by `three.setMaterial`, or a base-color token. */
  material: z.string().min(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
});

/** One placed instance in the world. Instances EXACTLY ONE of a design entity (a game entity like the
 *  player or an npc) or a content item (set dressing / props) — enforced in `validateGDS`. */
export const PlacementSchema = z.object({
  id: z.string().min(1),
  /** The design entity this instances (`EntitySchema.id`), when it's a game entity. */
  entity: z.string().min(1).optional(),
  /** The content/asset this instances (`ContentItemSchema.id`), when it's set dressing. */
  content: z.string().min(1).optional(),
  transform: TransformSchema,
  material: MaterialOverrideSchema.optional(),
});

/** Terrain generation inputs the World Designer picks; the terrain source builds the ground from these. */
export const TerrainSliceSchema = z.object({
  seed: z.number().int().optional(),
  /** Named biome/region preset the terrain source builds from (e.g. "eastern-watch"). */
  region: z.string().min(1).optional(),
});

/** Lighting/mood inputs; a named preset the render baseline installs. */
export const LightingSliceSchema = z.object({
  preset: z.string().min(1).optional(),
});

export const WorldSliceSchema = z.object({
  terrain: TerrainSliceSchema.optional(),
  lighting: LightingSliceSchema.optional(),
  placements: z.array(PlacementSchema).default([]),
});

// ── The spec ────────────────────────────────────────────────────────────────────────────────────
export const GameDesignSpecSchema = z.object({
  id: z.string().min(1),
  pitch: z.string().min(1),
  /** verb · objective · pressure · reward · fail · restart. */
  loopSentence: z.string().min(1),
  controls: ControlSchemeSchema,
  winCondition: z.string().min(1),
  loseCondition: z.string().min(1),
  artDirection: z.string().min(1),
  targetPlatforms: z.array(z.enum(["desktop", "mobile", "web"])).min(1),
  scopeTier: z.enum(["prototype", "polished", "premium"]),
  /** Which layers this game opts into. Drives the build shape + publishing options. */
  optIn: z.enum(["direct-path", "record+export", "multiplayer"]),
  entities: z.array(EntitySchema).min(1),
  mechanics: z.array(MechanicSchema).default([]),
  content: z.array(ContentItemSchema).default([]),
  /** The spatial layout the World Designer authors: where each entity/content instance sits and how
   *  it looks. OPTIONAL so pre-world specs stay valid; Compile assembles it into a runnable world. */
  world: WorldSliceSchema.optional(),
  dod: z.array(DoDAssertionSchema).min(1),
});

// ── Inferred types ──────────────────────────────────────────────────────────────────────────────
export type ControlScheme = z.infer<typeof ControlSchemeSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Mechanic = z.infer<typeof MechanicSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type MaterialOverride = z.infer<typeof MaterialOverrideSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type TerrainSlice = z.infer<typeof TerrainSliceSchema>;
export type LightingSlice = z.infer<typeof LightingSliceSchema>;
export type WorldSlice = z.infer<typeof WorldSliceSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type InputScript = z.infer<typeof InputScriptSchema>;
export type DoDAssertion = z.infer<typeof DoDAssertionSchema>;
export type GameDesignSpec = z.infer<typeof GameDesignSpecSchema>;

/** One semantic problem with a GDS that structural validation can't express. */
export interface GdsIssue {
  path: string;
  message: string;
}

export interface GdsValidation {
  ok: boolean;
  data?: GameDesignSpec;
  /** Structural (Zod) errors as flat path/message pairs, plus semantic issues. */
  issues: GdsIssue[];
}

/** Full GDS validation: structural parse (Zod) THEN cross-field semantic checks. Returns the
 *  parsed, defaulted spec when valid; otherwise a flat list of issues (no throw). */
export function validateGDS(input: unknown): GdsValidation {
  const parsed = GameDesignSpecSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, issues };
  }
  const spec = parsed.data;
  const issues: GdsIssue[] = [];

  // Exactly one player entity.
  const players = spec.entities.filter((e) => e.role === "player");
  if (players.length !== 1) {
    issues.push({ path: "entities", message: `exactly one player entity required (found ${players.length})` });
  }

  // Unique entity ids.
  const seen = new Set<string>();
  for (const e of spec.entities) {
    if (seen.has(e.id)) issues.push({ path: `entities.${e.id}`, message: `duplicate entity id "${e.id}"` });
    seen.add(e.id);
  }

  // ── World-slice referential integrity (only when the spec carries a world) ──
  if (spec.world) {
    const entityIds = new Set(spec.entities.map((e) => e.id));
    const contentIds = new Set(spec.content.map((c) => c.id));
    const placementIds = new Set<string>();
    for (const p of spec.world.placements) {
      if (placementIds.has(p.id)) {
        issues.push({ path: `world.placements.${p.id}`, message: `duplicate placement id "${p.id}"` });
      }
      placementIds.add(p.id);
      // A placement instances a game entity OR a content asset — exactly one.
      const refs = [p.entity, p.content].filter((r) => r !== undefined);
      if (refs.length !== 1) {
        issues.push({ path: `world.placements.${p.id}`, message: `placement "${p.id}" must reference exactly one of entity/content (found ${refs.length})` });
        continue;
      }
      if (p.entity !== undefined && !entityIds.has(p.entity)) {
        issues.push({ path: `world.placements.${p.id}`, message: `placement "${p.id}" references unknown entity "${p.entity}"` });
      }
      if (p.content !== undefined && !contentIds.has(p.content)) {
        issues.push({ path: `world.placements.${p.id}`, message: `placement "${p.id}" references unknown content "${p.content}"` });
      }
    }
  }

  // Every state-transition DoD MUST carry a runnable drive script (tier-1 automatability).
  for (const d of spec.dod) {
    if (d.kind === "state-transition" && d.drives === undefined) {
      issues.push({ path: `dod.${d.id}`, message: `state-transition DoD "${d.id}" must carry a "drives" script` });
    }
    // A walkToward / playerReachedXZ assertion must reference a known entity id or an x,z pair.
    if (d.drives) {
      for (const a of d.drives.assert) {
        if (a.check === "playerReachedXZ" && a.target !== undefined && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(a.target)) {
          issues.push({ path: `dod.${d.id}.assert`, message: `playerReachedXZ target must be "x,z" (got "${a.target}")` });
        }
      }
      for (const s of d.drives.steps) {
        if (s.toward !== undefined && s.toward.startsWith("walkToward:")) {
          // tolerated; the runner resolves it.
        }
      }
    }
  }

  // At least one automated (state-transition) DoD — a spec with only "feel" DoDs has no gate.
  if (!spec.dod.some((d) => d.kind === "state-transition")) {
    issues.push({ path: "dod", message: "at least one state-transition (automated) DoD is required" });
  }

  return issues.length === 0 ? { ok: true, data: spec, issues: [] } : { ok: false, data: spec, issues };
}

/** Emit the JSON Schema for the GDS (zod v4 native) so llmff's `validate_json` stage can gate the
 *  artifact at the pipeline boundary. Deterministic; no external dependency. */
export function gdsJsonSchema(): Record<string, unknown> {
  // `unrepresentable: "any"` keeps emission total even if a construct has no JSON-Schema form.
  const toJSONSchema = (z as unknown as {
    toJSONSchema: (s: unknown, o?: Record<string, unknown>) => Record<string, unknown>;
  }).toJSONSchema;
  return toJSONSchema(GameDesignSpecSchema, { unrepresentable: "any", target: "draft-7" });
}
