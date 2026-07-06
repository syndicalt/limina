// asset.catalog / catalog.publish — a browsable catalog of curated, QC-approved building/prop
// assets (id, title, category, boundsM, QC render + checks, tags) for the editor's asset palette.
// Distinct from the content-addressed AssetRegistry (asset-registry.ts, which resolves an id to
// BYTES): this is METADATA about which ids exist and whether they cleared QC — a lightweight index
// an agent or the editor browses BEFORE calling asset.place.
//
// THE RECORD/REPLAY SPINE: the SEED catalog (assets/catalog.json) ships with the project and is
// read once via the host's op_read_asset — the SAME sandboxed read asset/file-source.ts and
// village.ts's footprintRadius use. New entries published THIS SESSION (e.g. a freshly authored +
// QC'd building) are NOT written back to that file — there is no asset WRITE op — they live only in
// the in-memory `state.published` map and are durable the same way every other skill's state is:
// catalog.publish is a RECORDED command, so a worldlog replay re-invokes it and reconstructs the
// same published set. asset.catalog is read-only (never held by the review gate); catalog.publish
// is a real write (scene.write) so a reviewed agent's newly authored entries are held for approval
// like any other authored content.

import { z } from "../../build/zod.bundle.mjs";
import type { ExecutionContext, SkillDefinition, SkillRegistry } from "./registry.ts";

const CATALOG_CATEGORIES = ["prop", "dwelling", "civic", "military", "religious"] as const;

const catalogEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(CATALOG_CATEGORIES),
  /** World-meters bounding box [width, height, depth], measured at bake time. */
  boundsM: z.tuple([z.number(), z.number(), z.number()]),
  /** /assets-relative path to the asset's GPU QC render (falls back gracefully if it 404s). */
  qcRender: z.string().optional(),
  /** Automated QC pre-check flags (e.g. textured/scale/integrity/theme); null = not run. */
  qcChecks: z.record(z.string(), z.union([z.boolean(), z.null()])).optional(),
  tags: z.array(z.string()).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

const catalogInput = z.object({});

/** Per-host mutable catalog state: entries published THIS SESSION (upsert by id, insertion-ordered)
 *  plus the lazily-loaded seed catalog. Shared across invocations the same way terrain-edit.ts's
 *  `layers` Map is — each authoring context (headless authoritative, browser render) keeps its own,
 *  and both reconstruct identically by replaying the same recorded catalog.publish commands. */
export interface AssetCatalogState {
  /** Entries published this session, keyed by id (insertion order = publish order; a re-publish of
   *  an existing id REPLACES its entry in place, never duplicating). Wins over a seed entry with the
   *  same id when merged. */
  published: Map<string, CatalogEntry>;
  /** The seed catalog (assets/catalog.json), loaded once and cached. `undefined` = not yet attempted;
   *  an empty array is a valid (and terminal) result of a missing/unparsable seed file — it is never
   *  retried. */
  seed?: CatalogEntry[];
}

/** Read + parse the seed catalog once (cached on `state.seed`). Tolerates a missing or unparsable
 *  file (no such asset, invalid JSON, not an array) by treating the seed as empty — the catalog then
 *  degrades to whatever has been published this session, rather than failing the skill. */
function loadSeed(state: AssetCatalogState, ctx: ExecutionContext): CatalogEntry[] {
  if (state.seed !== undefined) return state.seed;
  let seed: CatalogEntry[] = [];
  try {
    const bytes = ctx.world.ops.op_read_asset("catalog.json");
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(parsed)) {
      const entries: CatalogEntry[] = [];
      for (const raw of parsed) {
        const r = catalogEntrySchema.safeParse(raw);
        if (r.success) entries.push(r.data);
      }
      seed = entries;
    }
  } catch {
    // Missing/unreadable/unparsable seed file — fall back to an empty seed.
  }
  state.seed = seed;
  return seed;
}

/** Merge the seed catalog with this-session publishes: seed order first (a published entry with the
 *  same id REPLACES the seed entry AT ITS SEED POSITION), then any published entries with no seed
 *  counterpart, in publish (insertion) order. Deterministic — a fresh state replaying the same
 *  publish sequence over the same seed produces an identical array. */
function mergedEntries(state: AssetCatalogState, ctx: ExecutionContext): CatalogEntry[] {
  const seed = loadSeed(state, ctx);
  const seedIds = new Set(seed.map((e) => e.id));
  const merged = seed.map((e) => state.published.get(e.id) ?? e);
  for (const [id, entry] of state.published) {
    if (!seedIds.has(id)) merged.push(entry);
  }
  return merged;
}

/** Register asset.catalog (read-only browse) + catalog.publish (record a newly authored/QC'd entry).
 *  `state` is the per-host mutable catalog (each authoring context keeps its own; replay reconstructs
 *  it identically from the recorded catalog.publish commands). */
export function registerAssetCatalogSkills(
  registry: SkillRegistry,
  state: AssetCatalogState = { published: new Map() },
): AssetCatalogState {
  const catalog: SkillDefinition<z.infer<typeof catalogInput>, { entries: CatalogEntry[] }> = {
    name: "asset.catalog",
    version: "1.0.0",
    description: "Browse the asset catalog: curated, QC-approved building/prop assets (id, title, category, boundsM, QC render + checks, tags), for the editor's asset palette or an agent picking an id before asset.place. Read-only — the seed catalog (assets/catalog.json) merged with any entries catalog.publish added this session (published wins on id collision).",
    category: "world",
    permissions: ["catalog.read"],
    input: catalogInput,
    output: z.object({ entries: z.array(catalogEntrySchema) }),
    handler: (_input, ctx) => ({ entries: mergedEntries(state, ctx) }),
  };

  const publish: SkillDefinition<CatalogEntry, { published: boolean; id: string; count: number }> = {
    name: "catalog.publish",
    version: "1.0.0",
    description: "Publish (or re-publish) a catalog entry — a newly authored + QC'd asset becoming browsable via asset.catalog. Idempotent: re-publishing an existing id REPLACES its entry rather than duplicating it. Recorded, so a worldlog replay reconstructs the published set (there is no asset write op — this is the durable path, not a file write).",
    category: "world",
    permissions: ["scene.write"],
    input: catalogEntrySchema,
    output: z.object({ published: z.boolean(), id: z.string(), count: z.number().int() }),
    handler: (input, ctx) => {
      state.published.set(input.id, input);
      ctx.emit("catalog.published", { id: input.id, title: input.title, category: input.category });
      const count = mergedEntries(state, ctx).length;
      return { published: true, id: input.id, count };
    },
  };

  registry.register(catalog as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(publish as unknown as Parameters<SkillRegistry["register"]>[0]);
  return state;
}
