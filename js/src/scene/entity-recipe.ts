// EntityRecipe — the DECLARATIVE, recorded wire format for a PREFAB: a named set of entities
// (a root and its subtree) captured once and stamped many times with per-instance variation.
//
// A prefab in limina is NOT an opaque template — it is a recorded "group create" the world log can
// re-instantiate. So a recipe is nothing more than the ORIGIN create-commands of a subtree plus each
// node's transform RELATIVE TO THE ROOT. scene.instantiateGroup REPLAYS those create-commands under a
// fresh root at a target transform; the EXISTING origin/parent/localOffset machinery does the rest.
// The recipe is a pure, serializable value written into the world log, so its shape is EXPENSIVE to
// change later — it is designed once, here, as a clean versioned schema.
//
// It follows js/src/world/world-config.ts and js/src/geometry/geometry-spec.ts EXACTLY:
//   • a `version` literal on every recipe (migration hook — bump when the wire format changes),
//   • `.strict()` sub-objects (an unknown key is REJECTED, never silently dropped),
//   • parse* / canonical* / serialize* with a byte-stable canonical JSON round-trip,
//   • NO Date / Math.random anywhere — a recipe is inert data, so serialize(parse(x)) is deterministic.
//
// Nodes are stored in a PARENT-BEFORE-CHILD order (root first), so a replayer can create each node
// after its parent already exists. `parent` is an INDEX into `nodes` (not an entity id) so the recipe
// is self-contained and portable — it never references live, per-session `ent_` ids.

import { z } from "../../build/zod.bundle.mjs";

/** Bump when the wire format changes. Every recipe carries it so a replayer can route by version. */
export const ENTITY_RECIPE_VERSION = 1;

const Ver = z.literal(ENTITY_RECIPE_VERSION);
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);

// A node's transform relative to the recipe ROOT (root = identity). Mirrors engine.ts TransformOffset
// field-for-field (pos/rot/scale) so the recipe can never drift from the hierarchy machinery it feeds.
const OffsetSchema = z.object({
  pos: Vec3,
  rot: Quat,
  scale: Vec3,
}).strict();

// The create-command that BUILT one node: the exact tool + input a replay re-invokes (e.g.
// scene.createEntity / scene.createMesh). The input is left OPAQUE (a JSON record) on purpose — the
// recipe layer does not re-declare every create skill's schema (that would drift); the create skill
// re-validates its own input on replay. Canonicalization deep-sorts the input keys so serialize() is
// byte-stable regardless of the key order the create command was authored with.
const OriginSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
}).strict();

const NodeSchema = z.object({
  // Index into `nodes` of this node's parent, or null for the ROOT. A valid recipe references only
  // EARLIER indices (parent-before-child); validated structurally by validateEntityRecipe.
  parent: z.number().int().min(0).nullable(),
  origin: OriginSchema,
  offset: OffsetSchema,
}).strict();

export const EntityRecipeSchema = z.object({
  version: Ver,
  name: z.string().min(1),
  nodes: z.array(NodeSchema).min(1),
}).strict();

export type EntityRecipe = z.infer<typeof EntityRecipeSchema>;
export type EntityRecipeNode = z.infer<typeof NodeSchema>;

export function parseEntityRecipe(json: string): EntityRecipe {
  return EntityRecipeSchema.parse(JSON.parse(json));
}

/** Structural (beyond-schema) invariants the discriminated schema can't express on its own:
 *  the first node is the ROOT (parent === null), every other node's parent is an EARLIER index
 *  (so a replayer can build parent-before-child), and exactly one root exists. Returns an error
 *  string, or undefined when the recipe is well-formed. Kept separate from the Zod schema so both
 *  the skill AND the gate can call it. */
export function validateEntityRecipe(recipe: EntityRecipe): string | undefined {
  if (recipe.nodes[0].parent !== null) return "node 0 must be the root (parent === null)";
  for (let i = 0; i < recipe.nodes.length; i++) {
    const p = recipe.nodes[i].parent;
    if (i === 0) continue;
    if (p === null) return `node ${i}: only node 0 may be a root (parent === null)`;
    if (p < 0 || p >= i) return `node ${i}: parent index ${p} must reference an earlier node (< ${i})`;
  }
  return undefined;
}

// ── Canonicalization: a stable, key-ordered clone so serialize() is byte-identical for equal values
// (deterministic wire format). Fixed field order for the known fields; the opaque origin.input is
// deep key-sorted (a create command carries only JSON-serializable values, so a recursive key sort is
// a well-defined canonical form). Node ARRAY order is preserved — it is meaningful (parent-before-child). ─

/** Recursively rebuild a JSON value with object keys in sorted order (arrays keep their order).
 *  Pure + deterministic — no Date / Math.random. Used to canonicalize the opaque origin.input. */
function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) {
    const cv = canonicalJson(rec[k]);
    if (cv !== undefined) out[k] = cv; // drop undefined so memory- and disk-round-trip agree (JSON drops it)
  }
  return out;
}

function canonicalEntityRecipe(r: EntityRecipe): EntityRecipe {
  return {
    version: r.version,
    name: r.name,
    nodes: r.nodes.map((n) => ({
      parent: n.parent,
      origin: { tool: n.origin.tool, input: canonicalJson(n.origin.input) as Record<string, unknown> },
      offset: {
        pos: [n.offset.pos[0], n.offset.pos[1], n.offset.pos[2]],
        rot: [n.offset.rot[0], n.offset.rot[1], n.offset.rot[2], n.offset.rot[3]],
        scale: [n.offset.scale[0], n.offset.scale[1], n.offset.scale[2]],
      },
    })),
  };
}

export function canonicalizeEntityRecipe(r: EntityRecipe): EntityRecipe {
  return canonicalEntityRecipe(r);
}

export function serializeEntityRecipe(r: EntityRecipe): string {
  return JSON.stringify(canonicalEntityRecipe(r));
}
