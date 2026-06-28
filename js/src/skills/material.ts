// Phase 2b — the material.import skill seam: import a CC0 texture pack (albedo + optional
// normal + roughness images, BY content-addressed id) as a NAMED PBR material usable by
// scene.createEntity / three.setMaterial — the path from procedural primitives to photoreal.
//
// PORTABILITY CONTRACT — identical to asset.place:
//   • Each image id resolves through the content-addressed AssetRegistry (id → bytes + stable
//     sha256). Resolving caches the bytes so they ride the export's assets.jsonl.
//   • The world log records only the REQUEST (name + image ids + committed hashes); NEVER bytes.
//     The recorder COMMITS the resolved hashes into the recorded command (commitFields), so the
//     log PINS the authored pack identity — a swapped texture fails loudly on replay.
//   • On replay the images load from the package bundle (AssetRegistry.fromBundle), are decoded
//     to sampleable DataTextures (the proven embedded-image→DataTexture bridge), and the named
//     material is rebuilt — no host asset root touched.

import { z } from "../../build/zod.bundle.mjs";
import type { AssetRegistry } from "../asset-registry.ts";
import type { MaterialRegistry, ImportedTextures } from "../materials/material-registry.ts";
import { decodeImageToDataTexture } from "./three.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const importInput = z.object({
  /** The name to register the material under (used by createEntity/setMaterial). */
  name: z.string().min(1),
  /** Asset id of the base-colour (albedo) image — required. */
  albedo: z.string().min(1),
  /** Asset id of the tangent-space normal map (optional). */
  normal: z.string().optional(),
  /** Asset id of the roughness map (optional; its R channel is read). */
  roughness: z.string().optional(),
  /** TRIPLANAR projection (no UV stretch on arbitrary primitives). Default false → classic
   *  UV-mapped slots (needs geometry UVs), the proven glTF texture path. */
  triplanar: z.boolean().default(false),
  /** Triplanar world tiling (cycles/m) — only used when `triplanar`. */
  scale: z.number().positive().default(0.5),
  /** Triplanar normal-map intensity — only used when `triplanar`. */
  normalStrength: z.number().min(0).default(1),
  /** Triplanar blend sharpness — only used when `triplanar`. */
  sharpness: z.number().positive().default(4),
  /** Metalness of the built material (CC0 packs are usually dielectric). */
  metalness: z.number().min(0).max(1).default(0),
  /** Fallback roughness when no roughness map is supplied. */
  baseRoughness: z.number().min(0).max(1).default(0.85),
  /** Optional albedo tint (sRGB hex) multiplied over the map. */
  color: z.number().int().min(0).max(0xffffff).optional(),
  /** The COMMITTED content addresses of the pack images (id → "sha256:..."). Absent at
   *  authoring (resolved + returned, then committed back by the recorder); present on REPLAY,
   *  where each resolved image is verified against it so a swapped texture is rejected. */
  hashes: z.record(z.string(), z.string()).optional(),
});

const importOutput = z.object({
  name: z.string(),
  /** The image ids that make up the pack (albedo first). */
  maps: z.array(z.string()),
  /** id → resolved content hash (pinned authored identity). */
  hashes: z.record(z.string(), z.string()),
});

/** Register the material.* skills bound to a content-addressed AssetRegistry (image bytes) and
 *  a MaterialRegistry (named built materials createEntity/setMaterial resolve). */
export function registerMaterialSkills(registry: SkillRegistry, assets: AssetRegistry, materials: MaterialRegistry): void {
  const importSkill: SkillDefinition<z.infer<typeof importInput>, z.infer<typeof importOutput>> = {
    name: "material.import",
    version: "1.0.0",
    description: "Import a CC0 texture pack (albedo + optional normal + roughness images, BY content-addressed id) as a NAMED PBR material usable by scene.createEntity / three.setMaterial. Resolves + decodes the images through the content-addressed asset registry (bytes ride the export's assets.jsonl); the world log records only the import REQUEST (name + ids + committed hashes), never bytes. Optionally TRIPLANAR so the pack never UV-stretches on arbitrary primitives. Returns the name + pinned hashes.",
    category: "three",
    permissions: ["scene.write"],
    // The recorder copies the resolved per-image hashes back into the recorded command's input
    // so the replay log PINS authored identity for every pack image (mirrors asset.scatter).
    commitFields: ["hashes"],
    input: importInput,
    output: importOutput,
    handler: async (input, ctx) => {
      // The pack's image ids, albedo first. Each gets resolved (id → bytes + hash) through the
      // content-addressed registry, which caches the bytes so they ride the export.
      const slots: { id: string; srgb: boolean; key: keyof ImportedTextures }[] = [
        { id: input.albedo, srgb: true, key: "albedo" },
      ];
      if (input.normal !== undefined) slots.push({ id: input.normal, srgb: false, key: "normal" });
      if (input.roughness !== undefined) slots.push({ id: input.roughness, srgb: false, key: "roughness" });

      const textures: ImportedTextures = { albedo: null, normal: null, roughness: null };
      const hashes: Record<string, string> = {};
      const maps: string[] = [];
      for (const slot of slots) {
        const resolved = assets.resolve(slot.id);
        // Replay/pinned path: a committed hash MUST match the resolved bytes, else the authored
        // pack was swapped out from under the log — fail loudly (mirrors asset.place).
        const committed = input.hashes?.[slot.id];
        if (committed !== undefined && committed !== resolved.hash) {
          throw new Error(`material.import: '${slot.id}' content hash mismatch (committed ${committed}, resolved ${resolved.hash}) — authored texture identity changed`);
        }
        hashes[slot.id] = resolved.hash;
        maps.push(slot.id);
        // Decode bytes → sampleable DataTexture (the proven embedded-image→DataTexture bridge).
        textures[slot.key] = await decodeImageToDataTexture(resolved.bytes, slot.srgb);
      }

      materials.define(input.name, {
        triplanar: input.triplanar,
        scale: input.scale,
        normalStrength: input.normalStrength,
        sharpness: input.sharpness,
        metalness: input.metalness,
        roughness: input.baseRoughness,
        color: input.color,
      }, textures, hashes);

      // Record the REQUEST on the trace: name + image ids + pinned hashes, NEVER bytes.
      ctx.emit("material.imported", { name: input.name, maps, hashes, triplanar: input.triplanar });
      return { name: input.name, maps, hashes };
    },
  };

  registry.register(importSkill);
}
