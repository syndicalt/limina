// three.* skills — transform/material/lighting + glTF load over the live scene.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { Position, Rotation, Scale, spawnRenderable } from "../ecs/world.ts";
import type { LoadedResourceMetadata, SceneObject, SceneLike } from "../engine.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import { createMaterial, getMaterialParams, isMaterialName } from "../materials/palette.ts";
import type { MaterialRegistry } from "../materials/material-registry.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** The shape of a loaded-glTF resource as a skill output (three.loadGLTF +
 *  asset.place share it). Carries the content `hash` (Phase 11). */
export const gltfResourceSchema = z.object({
  kind: z.literal("gltf"),
  assetId: z.string(),
  source: z.string(),
  hash: z.string(),
  bytes: z.number().int(),
  rootName: z.string().optional(),
  objectCount: z.number().int(),
  meshCount: z.number().int(),
  materialCount: z.number().int(),
  textureCount: z.number().int(),
});

const setTransformInput = z.object({
  entity: z.string(),
  position: Vec3.optional(),
  rotationEuler: Vec3.optional(), // radians (x,y,z)
  scale: Vec3.optional(),
});
const setTransform: SkillDefinition<z.infer<typeof setTransformInput>, { ok: boolean }> = {
  name: "three.setTransform",
  version: "1.0.0",
  description: "Set an entity's position, rotation (Euler radians), and/or scale.",
  category: "three",
  permissions: ["scene.write"],
  input: setTransformInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const eid = ctx.world.entities.resolve(input.entity)?.eid;
    if (eid === undefined) return { ok: false };
    if (input.position) {
      Position.x[eid] = input.position[0]; Position.y[eid] = input.position[1]; Position.z[eid] = input.position[2];
    }
    if (input.rotationEuler) {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(input.rotationEuler[0], input.rotationEuler[1], input.rotationEuler[2]),
      );
      Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w;
    }
    if (input.scale) {
      Scale.x[eid] = input.scale[0]; Scale.y[eid] = input.scale[1]; Scale.z[eid] = input.scale[2];
    }
    ctx.world.spatial?.invalidate();
    ctx.emit("ecs.component.updated", { entity: input.entity, via: "three.setTransform" });
    return { ok: true };
  },
};

const setMaterialInput = z.object({
  entity: z.string(),
  // Pick a material by intent ("sand", "wood", ...) from the named palette, OR an
  // imported texture-pack material name (material.import). A palette name supplies
  // color/roughness/metalness; explicit numeric fields below still win, so you can
  // start from a preset and tweak a single value.
  material: z.string().optional(),
  // Opt-in: when the `material` is a PALETTE name, REPLACE the entity's material with a
  // procedural-PBR surface (triplanar noise albedo + detail normal + honest roughness).
  // Imported materials are always PBR (this flag is ignored for them). Default false →
  // the legacy in-place preset/numeric update, byte-identical to before.
  pbr: z.boolean().default(false),
  color: z.number().int().min(0).max(0xffffff).optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
});
function makeSetMaterial(materials?: MaterialRegistry): SkillDefinition<z.infer<typeof setMaterialInput>, { ok: boolean }> {
 return {
  name: "three.setMaterial",
  version: "1.0.0",
  description: "Update an entity's PBR material (color, roughness, metalness) and/or shadow participation (castShadow/receiveShadow), across all meshes of a glTF entity. `material` accepts a palette name (optionally procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import); a PBR/imported material REPLACES the mesh material.",
  category: "three",
  permissions: ["scene.write"],
  input: setMaterialInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const root = ctx.world.entities.resolve(input.entity)?.mesh;
    if (root === undefined) return { ok: false };

    // REPLACE path: an imported texture-pack material, or a palette material upgraded to
    // procedural-PBR (`pbr: true`), swaps in a freshly-built node material per mesh. (Throws
    // cleanly on an unknown name via the registry/createMaterial.)
    let buildReplacement: (() => THREE.MeshStandardNodeMaterial) | undefined;
    if (input.material !== undefined && materials?.has(input.material)) {
      buildReplacement = () => materials.build(input.material!);
    } else if (input.material !== undefined && input.pbr && isMaterialName(input.material)) {
      buildReplacement = () => createMaterial(input.material!, { pbr: true });
    }

    // A palette `material` name supplies preset color/roughness/metalness (throws cleanly on an
    // unknown name); explicit numeric fields override the preset. Skipped when replacing.
    const preset = buildReplacement === undefined && input.material !== undefined ? getMaterialParams(input.material) : undefined;
    const color = input.color ?? preset?.color;
    const roughness = input.roughness ?? preset?.roughness;
    const metalness = input.metalness ?? preset?.metalness;

    const hasMaterialChange = color !== undefined || roughness !== undefined || metalness !== undefined;

    const applyMaterialProps = (material: MaterialLike): void => {
      if (color !== undefined) material.color.set(color);
      if (roughness !== undefined) material.roughness = roughness;
      if (metalness !== undefined) material.metalness = metalness;
    };

    const visit = (object: SceneObject): void => {
      if (input.castShadow !== undefined) object.castShadow = input.castShadow;
      if (input.receiveShadow !== undefined) object.receiveShadow = input.receiveShadow;
      if (buildReplacement !== undefined && (object as unknown as { isMesh?: boolean }).isMesh === true) {
        // Swap in the new material, then let any explicit numeric overrides still apply.
        const next = buildReplacement() as unknown as { color: { set(v: number): void }; roughness: number; metalness: number };
        if (color !== undefined) next.color.set(color);
        if (roughness !== undefined) next.roughness = roughness;
        if (metalness !== undefined) next.metalness = metalness;
        (object as unknown as { material: unknown }).material = next;
      } else if (hasMaterialChange && object.material !== undefined) {
        const material = object.material;
        if (Array.isArray(material)) {
          for (const sub of material) applyMaterialProps(sub);
        } else {
          applyMaterialProps(material);
        }
      }
    };

    if (typeof root.traverse === "function") root.traverse(visit);
    else visit(root);

    ctx.emit("three.material.updated", { entity: input.entity });
    return { ok: true };
  },
 };
}

// Limina-managed lights per scene, so repeated setLighting calls replace them.
const sceneLights = new Map<SceneLike, { ambient: unknown; directional: unknown }>();

const setLightingInput = z.object({
  ambientColor: z.number().int().min(0).max(0xffffff).default(0x404060),
  ambientIntensity: z.number().min(0).max(10).default(1.2),
  directionalColor: z.number().int().min(0).max(0xffffff).default(0xffffff),
  directionalIntensity: z.number().min(0).max(10).default(3),
  direction: Vec3.default([5, 9, 6]),
  // Real shadow mapping: when castShadow is set the directional light renders a
  // depth map each frame (renderer.shadowMap must be enabled, which engine.ts
  // does). The shadow camera is an orthographic frustum sized to cover the floor.
  castShadow: z.boolean().default(false),
  shadowMapSize: z.number().int().min(256).max(4096).default(2048),
  shadowCameraExtent: z.number().positive().max(500).default(20),
  shadowCameraNear: z.number().positive().default(0.5),
  shadowCameraFar: z.number().positive().default(120),
  shadowBias: z.number().min(-0.01).max(0.01).default(-0.0008),
});
const setLighting: SkillDefinition<z.infer<typeof setLightingInput>, { ok: boolean }> = {
  name: "three.setLighting",
  version: "1.0.0",
  description: "Set scene lighting: one ambient + one directional light, optionally casting real shadow maps.",
  category: "three",
  permissions: ["scene.write"],
  input: setLightingInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const scene = ctx.world.scene;
    const prev = sceneLights.get(scene);
    if (prev !== undefined) {
      scene.remove(prev.ambient);
      scene.remove(prev.directional);
    }
    const ambient = new THREE.AmbientLight(input.ambientColor, input.ambientIntensity);
    const directional = new THREE.DirectionalLight(input.directionalColor, input.directionalIntensity);
    directional.position.set(input.direction[0], input.direction[1], input.direction[2]);
    if (input.castShadow) {
      directional.castShadow = true;
      directional.shadow.mapSize.width = input.shadowMapSize;
      directional.shadow.mapSize.height = input.shadowMapSize;
      const cam = directional.shadow.camera;
      cam.left = -input.shadowCameraExtent;
      cam.right = input.shadowCameraExtent;
      cam.top = input.shadowCameraExtent;
      cam.bottom = -input.shadowCameraExtent;
      cam.near = input.shadowCameraNear;
      cam.far = input.shadowCameraFar;
      cam.updateProjectionMatrix();
      directional.shadow.bias = input.shadowBias;
    }
    scene.add(ambient);
    scene.add(directional);
    sceneLights.set(scene, { ambient, directional });
    ctx.emit("three.lighting.updated", { castShadow: input.castShadow });
    return { ok: true };
  },
};

const loadGltfInput = z.object({
  assetId: z.string(),
  position: Vec3.default([0, 0, 0]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMaterialLike(value: unknown): value is { map?: { image?: unknown } } {
  return isRecord(value);
}

/** Decoded-pixel bridge installed by crates/limina-render/js/00_bootstrap.js.
 *  Returns the RGBA8 pixels of a decoded ImageBitmap, or null for non-bitmaps. */
declare const __liminaImageBitmapToRGBA:
  | ((image: unknown) => { width: number; height: number; data: Uint8Array } | null)
  | undefined;

// glTF baseColor + the other standard PBR texture slots GLTFLoader may populate.
const GLTF_TEXTURE_SLOTS = [
  "map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap",
  "aoMap", "alphaMap", "bumpMap", "displacementMap", "specularMap",
  "specularColorMap", "clearcoatMap", "sheenColorMap", "lightMap",
] as const;

interface DataTextureUpload {
  image: { data: Uint8Array; width: number; height: number };
  isDataTexture: boolean;
  needsUpdate: boolean;
}

/** Re-home an ImageBitmap-backed texture onto three's CPU-data upload path.
 *  deno_webgpu (0.218) has no GPUQueue.copyExternalImageToTexture, and three's
 *  WebGPU backend swallows the resulting throw, so ImageBitmap textures upload as
 *  black. Marking the texture isDataTexture + giving it raw RGBA pixels makes the
 *  backend use queue.writeTexture, which works here. Idempotent: an already-data
 *  image yields no pixels and is skipped. */
function rehomeTextureToData(tex: unknown): boolean {
  if (typeof __liminaImageBitmapToRGBA !== "function") return false;
  if (!isRecord(tex) || !("image" in tex)) return false;
  const rgba = __liminaImageBitmapToRGBA(tex.image);
  if (rgba === null) return false;
  // three.Texture upload-surface fields, outside our minimal scene typing. Safe:
  // rgba is non-null only for a real decoded ImageBitmap-backed THREE.Texture.
  const upload = tex as unknown as DataTextureUpload;
  upload.image = rgba;
  upload.isDataTexture = true;
  upload.needsUpdate = true;
  return true;
}

/** Decode raw image BYTES (PNG/JPG/etc.) into a sampleable WebGPU DataTexture. Reuses the
 *  SAME embedded-image→RGBA bridge the glTF path uses: createImageBitmap decodes the bytes,
 *  __liminaImageBitmapToRGBA exposes the decoded RGBA8 pixels, and the result is wrapped in a
 *  THREE.DataTexture (the proven upload path on deno_webgpu — an ImageBitmap-backed texture
 *  would render black). This is the texture-pack IMPORT decode seam (materials/material-
 *  registry.ts). `srgb` tags a colour (albedo) map; normal/roughness maps stay linear.
 *  Returns null when no image decode bridge is present (non-render host). */
export async function decodeImageToDataTexture(bytes: Uint8Array, srgb: boolean): Promise<THREE.DataTexture | null> {
  if (typeof createImageBitmap !== "function" || typeof __liminaImageBitmapToRGBA !== "function") return null;
  const copy = bytes.slice();
  const bitmap = await createImageBitmap(new Blob([copy]));
  const rgba = __liminaImageBitmapToRGBA(bitmap);
  if (rgba === null) return null;
  const tex = new THREE.DataTexture(rgba.data, rgba.width, rgba.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  if (srgb && THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function rehomeMaterialTextures(material: unknown): void {
  if (Array.isArray(material)) {
    for (const m of material) rehomeMaterialTextures(m);
    return;
  }
  if (!isRecord(material)) return;
  for (const slot of GLTF_TEXTURE_SLOTS) {
    if (slot in material) rehomeTextureToData(material[slot]);
  }
}

/** Walk a loaded glTF scene and re-home every ImageBitmap texture so it samples
 *  for real on the GPU (see rehomeTextureToData). */
function prepareGltfTextures(root: SceneObject): void {
  const visit = (object: SceneObject): void => {
    if (object.material !== undefined) rehomeMaterialTextures(object.material);
  };
  if (typeof root.traverse === "function") root.traverse(visit);
  else visit(root);
}

function collectGltfMetadata(assetId: string, hash: string, bytes: Uint8Array, root: SceneObject): LoadedResourceMetadata {
  let objectCount = 0;
  let meshCount = 0;
  const materials = new Set<unknown>();
  const textures = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    objectCount += 1;
    if (node.isMesh === true) meshCount += 1;
    const material = node.material;
    if (Array.isArray(material)) {
      for (const m of material) {
        materials.add(m);
        if (isMaterialLike(m) && m.map?.image !== undefined) textures.add(m.map);
      }
    } else if (material !== undefined) {
      materials.add(material);
      if (isMaterialLike(material) && material.map?.image !== undefined) textures.add(material.map);
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  visit(root);

  const name = isRecord(root) && typeof root.name === "string" && root.name.length > 0 ? root.name : undefined;
  return {
    kind: "gltf",
    assetId,
    source: `assets/${assetId}`,
    hash,
    bytes: bytes.byteLength,
    rootName: name,
    objectCount,
    meshCount,
    materialCount: materials.size,
    textureCount: textures.size,
  };
}

/** A glTF placement transform: position (required) + optional Euler-radian
 *  rotation and per-axis scale. Shared by three.loadGLTF and asset.place. */
export interface GltfPlacement {
  position: [number, number, number];
  rotationEuler?: [number, number, number];
  scale?: [number, number, number];
}

/** Parse `bytes` as the glTF named `assetId` and return its scene root with textures
 *  re-homed for the WebGPU backend (see rehomeTextureToData). THE ONE place the
 *  GLTFLoader + the texture-rehome live: loadGltfIntoScene spawns an ENTITY from it,
 *  while asset.scatter INSTANCES its meshes — neither duplicates the loader setup. */
export async function parseGltfScene(assetId: string, bytes: Uint8Array): Promise<SceneObject> {
  const manager = new THREE.LoadingManager();
  const base = assetId.includes("/") ? assetId.slice(0, assetId.lastIndexOf("/") + 1) : "";
  manager.setURLModifier((url: string) => {
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("limina-asset://")) return url;
    return `limina-asset://${base}${url}`;
  });
  const loader = new THREE.GLTFLoader(manager);
  const payload = assetId.endsWith(".gltf")
    ? new TextDecoder().decode(bytes)
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise<{ scene: SceneObject; animations?: unknown[] }>((resolve, reject) => {
    loader.parse(
      payload,
      `limina-asset://${base}`,
      (g: { scene: SceneObject; animations?: unknown[] }) => resolve(g),
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  const root = gltf.scene;
  prepareGltfTextures(root);
  // Retain the parsed animation clips on the root: three's GLTFLoader hangs them off
  // gltf.animations, NOT gltf.scene, so without this a rigged character's clips
  // (idle/walk/run) are silently dropped and animation.play can't find them.
  (root as unknown as { animations?: unknown[] }).animations = gltf.animations ?? [];
  return root;
}

/** THE shared asset->entity pipeline. Parses `bytes` as the glTF named `assetId`
 *  (parseGltfScene), adds it to the scene, spawns a renderable at `placement`, and
 *  records the content `hash` on its LoadedResourceMetadata. Both three.loadGLTF and
 *  asset.place call this — no duplicated loader/rehome code. */
export async function loadGltfIntoScene(
  ctx: { world: { scene: SceneLike; ecs: unknown; entities: { create(e: { eid: number; mesh: SceneObject; resource: LoadedResourceMetadata }): string } } },
  assetId: string,
  bytes: Uint8Array,
  hash: string,
  placement: GltfPlacement,
): Promise<{ entity: string; resource: LoadedResourceMetadata }> {
  const root = await parseGltfScene(assetId, bytes);
  const [x, y, z] = placement.position;
  ctx.world.scene.add(root);
  const eid = spawnRenderable(ctx.world.ecs, root, x, y, z);
  if (placement.rotationEuler !== undefined) {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(placement.rotationEuler[0], placement.rotationEuler[1], placement.rotationEuler[2]),
    );
    Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w;
  }
  if (placement.scale !== undefined) {
    Scale.x[eid] = placement.scale[0]; Scale.y[eid] = placement.scale[1]; Scale.z[eid] = placement.scale[2];
  }
  const resource = collectGltfMetadata(assetId, hash, bytes, root);
  const entity = ctx.world.entities.create({ eid, mesh: root, resource });
  return { entity, resource };
}

/** three.loadGLTF over a content-addressed AssetRegistry: the id resolves to bytes
 *  + a CACHED content hash (no re-hash per load), then loads via the shared
 *  pipeline. */
function makeLoadGltf(assets: AssetRegistry): SkillDefinition<z.infer<typeof loadGltfInput>, { entity: string; resource: LoadedResourceMetadata }> {
  return {
    name: "three.loadGLTF",
    version: "1.0.0",
    description: "Load a glTF/glb model from a sandboxed asset id and add it to the scene at a position.",
    category: "three",
    permissions: ["scene.write"],
    input: loadGltfInput,
    output: z.object({
      entity: z.string(),
      resource: gltfResourceSchema,
    }),
    handler: async (input, ctx) => {
      const resolved = assets.resolve(input.assetId);
      const { entity, resource } = await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, { position: input.position });
      ctx.emit("three.gltf.loaded", { entity, ...resource });
      return { entity, resource };
    },
  };
}

export function registerThreeSkills(registry: SkillRegistry, assets: AssetRegistry, materials?: MaterialRegistry): void {
  registry.register(setTransform);
  registry.register(makeSetMaterial(materials));
  registry.register(setLighting);
  registry.register(makeLoadGltf(assets));
}
