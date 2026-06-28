// Phase 2b — the IMPORTED texture-pack material registry. A named PBR material built from a
// CC0 texture set (albedo + optional normal + roughness), registered under a NAME that
// `scene.createEntity` / `three.setMaterial` accept exactly like a palette name — so an agent
// can upgrade from procedural primitives to photoreal by importing a pack, with no code change.
//
// PORTABILITY CONTRACT (mirrors asset.place): the heavy IMAGE BYTES are content-addressed and
// ride the AssetRegistry → the export's assets.jsonl; the world log records only the IMPORT
// REQUEST (name + image ids + committed hashes). On replay the images load from the package
// bundle (never the host root) and the material is rebuilt. This registry holds only the BUILT
// material recipe (decoded textures + knobs) — it carries no bytes itself.
//
// The `material.import` skill (skills/material.ts) resolves + decodes the images, then `define`s
// the recipe here; createEntity/setMaterial call `build(name)` for a fresh material instance.

import * as THREE from "../../build/three.bundle.mjs";
import { triplanarMapLayer } from "./triplanar-noise.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

/** The decoded texture set for one imported material (each map already a sampleable
 *  DataTexture; normal/roughness optional). */
export interface ImportedTextures {
  albedo: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
}

/** How an imported material is projected + tuned. */
export interface ImportedMaterialSpec {
  /** false (default): classic UV-mapped maps (map/normalMap/roughnessMap) — needs geometry UVs.
   *  true: TRIPLANAR projection of the maps (no UV stretch on arbitrary primitives), matching
   *  the procedural-PBR primitive path. */
  triplanar: boolean;
  /** Triplanar world tiling (cycles/m) — only used when `triplanar`. */
  scale: number;
  /** Detail-normal intensity for the triplanar normal map — only used when `triplanar`. */
  normalStrength: number;
  /** Triplanar blend sharpness — only used when `triplanar`. */
  sharpness: number;
  /** Metalness for the built material (CC0 packs are usually dielectric → 0). */
  metalness: number;
  /** Fallback roughness when no roughness map is supplied. */
  roughness: number;
  /** Optional albedo tint (sRGB hex) multiplied over the map (UV mode: material.color). */
  color?: number;
}

interface Entry {
  spec: ImportedMaterialSpec;
  textures: ImportedTextures;
  /** id → content hash for the pack's images (authored identity; pinned in the log). */
  hashes: Record<string, string>;
  build: () => THREE.MeshStandardNodeMaterial;
}

/**
 * A registry of imported texture-pack materials, keyed by agent-chosen name. The single seam
 * where an imported name resolves to a fresh, built MeshStandardNodeMaterial for createEntity /
 * setMaterial. Per-session (rebuilt on replay from the recorded import requests + package
 * images), exactly like the AssetRegistry it parallels.
 */
export class MaterialRegistry {
  private readonly map = new Map<string, Entry>();

  /** True when `name` is a registered imported material. */
  has(name: string): boolean {
    return this.map.has(name);
  }

  /** The registered imported-material names (stable order of definition). */
  names(): string[] {
    return [...this.map.keys()];
  }

  /** The content hashes of an imported material's source images (id → "sha256:..."). */
  hashesOf(name: string): Record<string, string> {
    const e = this.map.get(name);
    if (e === undefined) throw new Error(`unknown imported material "${name}"`);
    return { ...e.hashes };
  }

  /**
   * Register (or replace) an imported material recipe from already-DECODED textures. Builds the
   * per-material builder once (closing over the textures + spec); `build(name)` returns a fresh
   * MeshStandardNodeMaterial each call so per-entity tweaks never alias.
   */
  define(name: string, spec: ImportedMaterialSpec, textures: ImportedTextures, hashes: Record<string, string>): void {
    const build = (): THREE.MeshStandardNodeMaterial => {
      const material = new THREE.MeshStandardNodeMaterial({
        roughness: spec.roughness,
        metalness: spec.metalness,
        ...(spec.color !== undefined ? { color: spec.color } : {}),
      });
      if (spec.triplanar) {
        // Node-based triplanar projection of the imported maps (no UVs required).
        const layer = triplanarMapLayer(
          textures.albedo, textures.normal, textures.roughness,
          spec.scale, spec.normalStrength, spec.sharpness,
        );
        if (layer.color !== undefined) {
          material.colorNode = spec.color !== undefined
            ? layer.color.mul(new THREE.Color(spec.color))
            : layer.color;
        }
        if (layer.normal !== undefined) material.normalNode = T.transformNormalToView(layer.normal.normalize());
        if (layer.roughness !== undefined) material.roughnessNode = T.clamp(layer.roughness, 0, 1);
      } else {
        // Classic UV-mapped slots — the proven glTF texture path (uses geometry UVs).
        if (textures.albedo !== null) material.map = textures.albedo;
        if (textures.normal !== null) material.normalMap = textures.normal;
        if (textures.roughness !== null) material.roughnessMap = textures.roughness;
      }
      return material;
    };
    this.map.set(name, { spec, textures, hashes: { ...hashes }, build });
  }

  /** Build a fresh material instance for a registered imported name (throws if unknown). */
  build(name: string): THREE.MeshStandardNodeMaterial {
    const e = this.map.get(name);
    if (e === undefined) throw new Error(`unknown imported material "${name}"`);
    return e.build();
  }
}
