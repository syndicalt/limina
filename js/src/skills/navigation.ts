// navigation.* / npc.* skills — the runtime GAZETTEER + place-based navigation (Places Stage 4).
// All inputs accept optional `meta` for agent-supplied extension data.
//
// WHAT THIS IS: the design-space "Places" tree compiles (design-map-compile.mjs) into a `gazetteer`
// on the WorldMap IR — one entry per PLACED place (placeId, name, kind, parentId, [x,z], radiusM?).
// This module turns that static index into a runtime one an NPC brain navigates by NAME instead of
// raw coordinates: `gazetteer.load` reads the compiled map asset into a manager; `npc.goToPlace`
// resolves a placeId to its world position and walks the entity there THROUGH the navmesh system
// (nested navmesh.moveTo — never a hand-rolled move), so all the deterministic A* / CCT machinery is
// reused, not reinvented.
//
// CLOSURE WIRING (mirrors navmesh.ts / terrain.ts): the SkillDefinitions are built INSIDE
// registerNavigationSkills, closing over ONE local GazetteerManager. There is no
// `ctx.world.gazetteerManager` — the manager lives in the registry's closure; a fresh replay
// registry starts empty and rebuilds its state by re-invoking the recorded `gazetteer.load` (which
// re-reads the same committed map asset — the identical pattern terrain.create uses on replay).
// registerNavigationSkills returns `{ gazetteerManager }` so the core wiring can expose it.
//
// DETERMINISM (CRITICAL — npc.goToPlace AFFECTS SIM via navmesh.moveTo): no Date.now / new Date /
// Math.random / performance.now anywhere here, and no async I/O in a handler (gazetteer.load reads
// the map asset with the SYNCHRONOUS sandboxed op_read_asset, the same call terrain.create makes —
// never `await fetch`, which would freeze the browser sim worker). npc.goToPlace forwards
// `chainId: ctx.chainId` into the nested navmesh.moveTo so the WorldRecorder folds it into the parent
// command (no double-apply on replay). Same inputs ⇒ identical resolution and identical movement.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** One resolved gazetteer place: a NAME the NPC brain can navigate to, pinned to a world position.
 *  `position` is [x, z] world meters (the IR is 2D — height is resolved at move time from the
 *  entity's own body); `parentId` preserves the nested-place hierarchy; `radiusM` is present only
 *  for area-bound places. */
export interface GazetteerRecord {
  placeId: string;
  name: string;
  kind: string;
  parentId: string | null;
  position: [number, number];
  radiusM?: number;
}

/** The runtime named-place index. Holds the gazetteer of the currently-loaded map; `npc.goToPlace`
 *  resolves against it. `load` REPLACES the index (a world tracks one map's places at a time), so a
 *  fresh load of a different map cannot leave stale entries behind. */
export class GazetteerManager {
  private byId = new Map<string, GazetteerRecord>();

  load(entries: GazetteerRecord[]): number {
    this.byId.clear();
    for (const e of entries) this.byId.set(e.placeId, e);
    return this.byId.size;
  }
  resolve(placeId: string): GazetteerRecord | undefined {
    return this.byId.get(placeId);
  }
  has(placeId: string): boolean {
    return this.byId.has(placeId);
  }
  size(): number {
    return this.byId.size;
  }
  all(): GazetteerRecord[] {
    return [...this.byId.values()];
  }
  clear(): void {
    this.byId.clear();
  }
  /** Deterministic capture, placeId-sorted (snapshot participant, H2). */
  captureSnapshot(): GazetteerRecord[] {
    return [...this.byId.values()]
      .sort((a, b) => (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0))
      .map((r) => ({ ...r, position: [r.position[0], r.position[1]] }));
  }
  /** Wholesale replace the index (participant restore) — `load` already replaces. */
  restoreSnapshot(records: readonly GazetteerRecord[]): void {
    this.load(records.map((r) => ({ ...r, position: [r.position[0], r.position[1]] })));
  }
}

const gazetteerLoadInput = z.object({
  mapAssetId: z.string().min(1).describe("The compiled WorldMap asset (e.g. maps/<project>-<id>.worldmap.json) whose gazetteer to load into the runtime index."),
  meta: MetaField,
});

const goToPlaceInput = z.object({
  entity: z.string().describe("Entity to navigate."),
  placeId: z.string().min(1).describe("Gazetteer place id to walk toward — resolved to its world position via the loaded gazetteer."),
  speed: z.number().positive().optional().describe("Movement speed (world units/second); forwarded to navmesh.moveTo."),
  dt: z.number().positive().optional().describe("Integration timestep (seconds, default 1/60). Deterministic — never wall-clock."),
  from: Vec3.optional().describe("Seed position for the FIRST step (when the entity has no body and no tracked position)."),
  meta: MetaField,
});

/** Normalize the raw `gazetteer` array off a compiled WorldMap into GazetteerRecords, dropping any
 *  malformed entry (defensive: a hand-edited/older asset must never crash the load — mirrors the
 *  WARN-and-continue posture of the asset-hash sites). */
function normalizeGazetteer(raw: unknown): GazetteerRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: GazetteerRecord[] = [];
  for (const g of raw) {
    if (g === null || typeof g !== "object") continue;
    const e = g as Record<string, unknown>;
    if (typeof e.placeId !== "string" || e.placeId.length === 0) continue;
    if (!Array.isArray(e.position) || e.position.length < 2) continue;
    const rec: GazetteerRecord = {
      placeId: e.placeId,
      name: typeof e.name === "string" && e.name.length > 0 ? e.name : e.placeId,
      kind: typeof e.kind === "string" && e.kind.length > 0 ? e.kind : "place",
      parentId: typeof e.parentId === "string" && e.parentId.length > 0 ? e.parentId : null,
      position: [Number(e.position[0]), Number(e.position[1])],
    };
    if (typeof e.radiusM === "number") rec.radiusM = e.radiusM;
    out.push(rec);
  }
  return out;
}

/**
 * Register the gazetteer.* / npc.goToPlace skills bound to ONE GazetteerManager. The handlers CLOSE
 * OVER the manager (there is no ctx.world.gazetteerManager). Returns the manager so the core wiring
 * can expose it (core.navigation.gazetteerManager).
 */
export function registerNavigationSkills(
  registry: SkillRegistry,
  opts?: { gazetteerManager?: GazetteerManager },
): { gazetteerManager: GazetteerManager } {
  const mgr = opts?.gazetteerManager ?? new GazetteerManager();

  const loadGazetteer: SkillDefinition<z.infer<typeof gazetteerLoadInput>, { ok: boolean; count: number }> = {
    name: "gazetteer.load",
    version: "1.0.0",
    description: "Load the named-place index (gazetteer) from a compiled WorldMap asset so npc.goToPlace can resolve place ids to world positions. Reads the asset with the synchronous sandboxed op_read_asset (same as terrain.create) — never async I/O. REPLACES any previously-loaded gazetteer. A map with no gazetteer loads an empty index (count 0). Recorded + replay-safe: replay re-reads the same committed asset.",
    category: "nav",
    permissions: ["nav.configure"],
    input: gazetteerLoadInput,
    output: z.object({ ok: z.boolean(), count: z.number().int() }),
    handler: (input, ctx) => {
      let text: string;
      try {
        text = new TextDecoder().decode(ctx.world.ops.op_read_asset(input.mapAssetId));
      } catch (e) {
        ctx.emit("gazetteer.loadFailed", { mapAssetId: input.mapAssetId, reason: String(e), ...input.meta });
        return { ok: false, count: 0 };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        ctx.emit("gazetteer.loadFailed", { mapAssetId: input.mapAssetId, reason: "not JSON: " + String(e), ...input.meta });
        return { ok: false, count: 0 };
      }
      const entries = normalizeGazetteer((parsed as Record<string, unknown>)?.gazetteer);
      const count = mgr.load(entries);
      ctx.emit("gazetteer.loaded", { mapAssetId: input.mapAssetId, count, ...input.meta });
      return { ok: true, count };
    },
  };

  const goToPlace: SkillDefinition<
    z.infer<typeof goToPlaceInput>,
    { ok: boolean; arrived: boolean; resolved: boolean; placeId: string; position?: [number, number, number]; remaining?: number; target?: [number, number, number] }
  > = {
    name: "npc.goToPlace",
    version: "1.0.0",
    description: "Advance an entity ONE deterministic navmesh step toward a NAMED place (resolved via the loaded gazetteer) instead of raw coordinates. Delegates to navmesh.moveTo (real A* / CCT) — the caller loops until `arrived`. The target keeps the entity's own height (the gazetteer is 2D), so movement is horizontal. Returns resolved:false (ok:false) when the place id is unknown or the gazetteer is not loaded.",
    category: "nav",
    permissions: ["nav.write"],
    priority: "core",
    input: goToPlaceInput,
    output: z.object({
      ok: z.boolean(),
      arrived: z.boolean(),
      resolved: z.boolean(),
      placeId: z.string(),
      position: Vec3.optional(),
      remaining: z.number().optional(),
      target: Vec3.optional(),
    }),
    handler: async (input, ctx) => {
      const rec = mgr.resolve(input.placeId);
      if (rec === undefined) {
        ctx.emit("npc.goToPlace.unresolved", {
          entity: input.entity,
          placeId: input.placeId,
          reason: mgr.size() === 0 ? "gazetteer not loaded" : "unknown place",
          ...input.meta,
        });
        return { ok: false, arrived: false, resolved: false, placeId: input.placeId };
      }

      // Keep the entity's own height: the gazetteer is 2D, so the move target's y is the entity's
      // current body height (sim truth) — otherwise navmesh.moveTo would drag it toward y=0.
      const entry = ctx.world.entities.resolve(input.entity);
      let curY = 0;
      if (entry?.bodyId !== undefined) {
        const out = new Float32Array(3);
        ctx.world.ops.op_physics_body_pos(entry.bodyId, out);
        curY = out[1];
      }
      const target: [number, number, number] = [rec.position[0], curY, rec.position[1]];

      const res = await registry.invoke(
        "navmesh.moveTo",
        {
          entity: input.entity,
          target,
          ...(input.speed !== undefined ? { speed: input.speed } : {}),
          ...(input.dt !== undefined ? { dt: input.dt } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
        },
        {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          permissions: ctx.permissions,
          tick: ctx.tick,
          world: ctx.world,
          chainId: ctx.chainId,
        },
      );
      if (res === undefined || !res.success) {
        ctx.emit("npc.goToPlace.failed", { entity: input.entity, placeId: input.placeId, reason: res?.error ?? "moveTo failed", target, ...input.meta });
        return { ok: false, arrived: false, resolved: true, placeId: input.placeId, target };
      }
      const r = res.result as { arrived: boolean; position?: [number, number, number]; remaining?: number };
      ctx.emit("npc.goToPlace.step", {
        entity: input.entity,
        placeId: input.placeId,
        name: rec.name,
        position: r.position,
        arrived: r.arrived,
        remaining: r.remaining,
        tick: ctx.tick,
        ...input.meta,
      });
      return { ok: true, arrived: r.arrived, resolved: true, placeId: input.placeId, position: r.position, remaining: r.remaining, target };
    },
  };

  registry.register(loadGazetteer);
  registry.register(goToPlace);

  return { gazetteerManager: mgr };
}
