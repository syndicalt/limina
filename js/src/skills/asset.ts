// Phase 11 — the asset.* skill seam: place a curated GLTF asset BY ID at a
// transform. The id resolves through the content-addressed AssetRegistry
// (js/src/asset-registry.ts) to its bytes + content hash, then loads through THE
// SAME glTF pipeline as three.loadGLTF (loadGltfIntoScene — one loader, one
// WebGPU texture-rehome, no duplication).
//
// THE RECORD/REPLAY SPINE (same as terrain's world.generateRegion): asset.place is
// a SKILL, so the world log records its REQUEST — { assetId, position, rotation,
// scale, hash } — as a single command. NEVER the instance bytes. The recorder
// COMMITS the resolved content hash into the recorded command (via commitFields),
// so the log PINS the authored asset identity: on replay the resolved bytes are
// verified against that committed hash and a swapped asset fails loudly. The bytes
// ride the registry/export package (content-addressed assets.jsonl), never the log.

import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { gltfResourceSchema, loadGltfIntoScene } from "./three.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const placeInput = z.object({
  assetId: z.string(),
  position: Vec3.default([0, 0, 0]),
  /** Euler radians (x,y,z). */
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
  /** Optional PBR overrides applied across the placed glTF's meshes. */
  material: z.object({
    color: z.number().int().min(0).max(0xffffff).optional(),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
  }).optional(),
  /** The COMMITTED content address ("sha256:...") of the asset. Absent at
   *  authoring (resolved + returned), then committed into the recorded command by
   *  the recorder. Present on REPLAY: the resolved bytes are verified against it so
   *  the authored asset identity is pinned (a swapped/updated asset is rejected). */
  hash: z.string().optional(),
});

/** Permission scope for asset.place — also the scope handed to its nested
 *  three.setMaterial invoke (least-privilege: the override runs under asset.place's
 *  OWN declared capability, not the caller's full grant set). */
const PLACE_PERMS = ["scene.write"] as const;

/** Register the asset.* skills bound to a content-addressed AssetRegistry. The
 *  default core wiring constructs a registry over the host ops; a runtime may pass
 *  its own (e.g. a package-backed AssetRegistry.fromBundle for replay/browser). */
export function registerAssetSkills(registry: SkillRegistry, assets: AssetRegistry): void {
  const place: SkillDefinition<z.infer<typeof placeInput>, { entity: string; hash: string; resource: z.infer<typeof gltfResourceSchema> }> = {
    name: "asset.place",
    version: "1.0.0",
    description: "Place a curated glTF asset BY ID at a transform. Resolves the id through the content-addressed asset registry, loads it via the shared glTF pipeline, and spawns an entity. The world log records the REQUEST (assetId + transform + committed content hash); the bytes ride the registry/export package. Returns the entity id + content hash.",
    category: "three",
    permissions: [...PLACE_PERMS],
    // The recorder copies these OUTPUT fields into the recorded command's input so
    // the replay log COMMITS to the resolved content hash (pins authored identity).
    commitFields: ["hash"],
    input: placeInput,
    output: z.object({ entity: z.string(), hash: z.string(), resource: gltfResourceSchema }),
    handler: async (input, ctx) => {
      // Content-addressed resolve: id -> bytes + stable hash (the asset's portable
      // identity). Same id -> same content address on every resolve/replay.
      const resolved = assets.resolve(input.assetId);
      // Replay/pinned path: a committed hash MUST match the resolved bytes, else the
      // authored asset was swapped/updated out from under the log — fail loudly.
      if (input.hash !== undefined && input.hash !== resolved.hash) {
        throw new Error(`asset.place: '${input.assetId}' content hash mismatch (committed ${input.hash}, resolved ${resolved.hash}) — authored asset identity changed`);
      }
      const { entity, resource } = await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, {
        position: input.position,
        rotationEuler: input.rotation,
        scale: input.scale,
      });
      // Optional material override (reuses three.setMaterial's apply, by id). Scoped
      // to asset.place's OWN declared permission, NOT the caller's full grant set.
      if (input.material !== undefined) {
        const res = await registry.invoke("three.setMaterial", { entity, ...input.material }, {
          agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS), tick: ctx.tick, world: ctx.world,
        });
        if (!res.success) throw new Error(`asset.place: material override failed: ${JSON.stringify(res.error)}`);
      }
      // Record the REQUEST on the trace/log: assetId + transform + content hash,
      // never bytes. This is the durable, replayable, exportable place command.
      ctx.emit("asset.placed", {
        assetId: input.assetId,
        hash: resolved.hash,
        position: input.position,
        rotation: input.rotation ?? null,
        scale: input.scale ?? null,
        entity,
      });
      return { entity, hash: resolved.hash, resource };
    },
  };

  registry.register(place);
}
