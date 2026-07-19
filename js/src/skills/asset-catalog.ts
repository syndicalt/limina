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
import { assertGenericAssetAuthoringCategory } from "../assets/generic-asset-authoring-policy.mjs";
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
  /** 360° turntable frames (task #66): /assets-relative paths to 8 yaw-rotated QC renders shot by
   *  architect-run.mjs --turntable, in rotation order. Optional — most entries only have the one
   *  hero qcRender; when present, the approval card's lightbox cycles through these on ←/→ or drag. */
  qcTurntable: z.array(z.string()).max(16).optional(),
  /** Automated QC pre-check flags (e.g. textured/scale/integrity/theme); null = not run. */
  qcChecks: z.record(z.string(), z.union([z.boolean(), z.null()])).optional(),
  /** Provenance: which model/agent authored the asset (e.g. "claude-fable-5"). The reviewer sees
   *  this on the approval card — model tier is a quality signal — and it stays on the entry. */
  authoredBy: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

const catalogInput = z.object({});

// A ＋New build request: the user's description of an asset that doesn't exist yet. Recording it is
// the editor's whole job — the ARCHITECT (a build agent + Blender, outside the engine) picks it up,
// authors the GLB, runs the QC pipeline (tools/design/architect-run.mjs) and proposes catalog.publish.
const requestInput = z.object({
  description: z.string().min(3),
  category: z.enum(CATALOG_CATEGORIES),
  /** Optional /assets-relative reference image the architect should match. */
  refImage: z.string().optional(),
});
const requestRecordSchema = requestInput.extend({
  requestId: z.string(),
  agentId: z.string(),
  tick: z.number(),
});
export type BuildRequest = z.infer<typeof requestRecordSchema>;

/** Per-host mutable catalog state: entries published THIS SESSION (upsert by id, insertion-ordered)
 *  plus the lazily-loaded seed catalog. Shared across invocations the same way terrain-edit.ts's
 *  `layers` Map is — each authoring context (headless authoritative, browser render) keeps its own,
 *  and both reconstruct identically by replaying the same recorded catalog.publish commands. */
export interface AssetCatalogState {
  /** Entries published this session, keyed by id (insertion order = publish order; a re-publish of
   *  an existing id REPLACES its entry in place, never duplicating). Wins over a seed entry with the
   *  same id when merged. */
  published: Map<string, CatalogEntry>;
  /** ＋New build requests recorded this session, in request order. Replay-reconstructed like
   *  `published` — asset.request is a recorded command with a DETERMINISTIC requestId. */
  requests: BuildRequest[];
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
  state: AssetCatalogState = { published: new Map(), requests: [] },
): AssetCatalogState {
  const catalog: SkillDefinition<z.infer<typeof catalogInput>, { entries: CatalogEntry[] }> = {
    name: "asset.catalog",
    version: "1.0.0",
    description: "Browse the asset catalog: curated, QC-approved building/prop assets (id, title, category, boundsM, QC render + checks, tags), for the editor's asset palette or an agent picking an id before asset.place. Read-only — the seed catalog (assets/catalog.json) merged with any entries catalog.publish added this session (published wins on id collision).",
    category: "world",
    permissions: ["catalog.read"],
    effect: "read",
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
      assertGenericAssetAuthoringCategory(input.category, "catalog.publish");
      state.published.set(input.id, input);
      ctx.emit("catalog.published", { id: input.id, title: input.title, category: input.category });
      const count = mergedEntries(state, ctx).length;
      return { published: true, id: input.id, count };
    },
  };

  const request: SkillDefinition<z.infer<typeof requestInput>, { requestId: string; queued: number }> = {
    name: "asset.request",
    version: "1.0.0",
    description: "Request a NEW asset by description (the editor's ＋New front door). Records the request for the architect — a build agent that authors the GLB with Blender, runs the QC pipeline and proposes catalog.publish. Non-blocking: this only records; nothing is generated in-engine.",
    category: "world",
    permissions: ["scene.write"],
    input: requestInput,
    output: z.object({ requestId: z.string(), queued: z.number().int() }),
    handler: (input, ctx) => {
      assertGenericAssetAuthoringCategory(input.category, "asset.request");
      // Deterministic id (tick + per-session ordinal) — NEVER wall-clock/random, so a worldlog
      // replay reconstructs the identical request list.
      const requestId = `req_${ctx.tick}_${state.requests.length}`;
      state.requests.push({ ...input, requestId, agentId: ctx.agentId, tick: ctx.tick });
      ctx.emit("asset.requested", { requestId, description: input.description, category: input.category });
      return { requestId, queued: state.requests.length };
    },
  };

  const requests: SkillDefinition<z.infer<typeof catalogInput>, { requests: BuildRequest[] }> = {
    name: "asset.requests",
    version: "1.0.0",
    description: "List the ＋New build requests recorded this session (requestId, description, category, requester) — what the architect picks up. Read-only.",
    category: "world",
    permissions: ["catalog.read"],
    effect: "read",
    input: catalogInput,
    output: z.object({ requests: z.array(requestRecordSchema) }),
    handler: () => ({ requests: [...state.requests] }),
  };

  registry.register(catalog as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(publish as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(request as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(requests as unknown as Parameters<SkillRegistry["register"]>[0]);
  return state;
}
