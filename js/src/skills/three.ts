// three.* skills — transform/material/lighting + glTF load over the live scene.

import * as THREE from "../../build/three.bundle.mjs";
import type { World } from "bitecs";
import { z } from "../../build/zod.bundle.mjs";
import { Position, Rotation, Scale, spawnRenderable } from "../ecs/world.ts";
import type { EntityOrigin, LoadedResourceMetadata, MaterialLike, SceneObject, SceneLike } from "../engine.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import { createMaterial, getMaterialParams, isMaterialName } from "../materials/palette.ts";
import type { MaterialRegistry } from "../materials/material-registry.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { sha256 } from "../world/sha256.mjs";

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
    const entry = ctx.world.entities.resolve(input.entity);
    if (entry === undefined) return { ok: false };
    const root = entry.mesh;

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

    // First-class material state: record the surface ON THE ENTITY so it survives even when this
    // (authoritative/headless) context has no local mesh to mutate — an asset-backed entity loads
    // its real mesh only in the browser. The inspector reads this state and a self-sufficient
    // snapshot carries it; the browser still applies the recorded command to its mesh (LIVE_IN_PLACE).
    if (hasMaterialChange || input.material !== undefined) {
      ctx.world.entities.bindMaterial(input.entity, {
        color,
        roughness,
        metalness,
        name: input.material,
        pbr: input.material !== undefined ? input.pbr : undefined,
      });
    }

    const applyMaterialProps = (material: MaterialLike): void => {
      if (color !== undefined) material.color.set(color);
      if (roughness !== undefined) material.roughness = roughness;
      if (metalness !== undefined) material.metalness = metalness;
    };

    const replacedMaterials = new Set<unknown>();
    const visit = (object: SceneObject): void => {
      if (input.castShadow !== undefined) object.castShadow = input.castShadow;
      if (input.receiveShadow !== undefined) object.receiveShadow = input.receiveShadow;
      if (buildReplacement !== undefined && (object as unknown as { isMesh?: boolean }).isMesh === true) {
        // Swap in the new material, then let any explicit numeric overrides still apply.
        const next = buildReplacement() as unknown as { color: { set(v: number): void }; roughness: number; metalness: number };
        if (color !== undefined) next.color.set(color);
        if (roughness !== undefined) next.roughness = roughness;
        if (metalness !== undefined) next.metalness = metalness;
        const target = object as unknown as { material: unknown };
        const previous = target.material;
        target.material = next;
        for (const material of Array.isArray(previous) ? previous : [previous]) {
          if (material === null || typeof material !== "object" || replacedMaterials.has(material)) continue;
          replacedMaterials.add(material);
          if ((material as { userData?: { liminaLifetime?: unknown } }).userData?.liminaLifetime !== "host") {
            (material as { dispose?(): void }).dispose?.();
          }
        }
      } else if (hasMaterialChange && object.material !== undefined) {
        const material = object.material;
        if (Array.isArray(material)) {
          for (const sub of material) applyMaterialProps(sub);
        } else {
          applyMaterialProps(material);
        }
      }
    };

    // Apply to the local mesh when this context has one (browser render context; the headless
    // host for primitives). A mesh-less entity has already updated its material state above.
    if (root !== undefined) {
      if (typeof root.traverse === "function") root.traverse(visit);
      else visit(root);
    }

    ctx.emit("three.material.updated", { entity: input.entity });
    return { ok: true };
  },
 };
}

// Limina-managed lights belong to one logical world, not to the reusable browser Scene object.
const sceneLights = new WeakMap<WorldContext, { ambient: unknown; directional: unknown }>();

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
    const prev = sceneLights.get(ctx.world);
    if (prev !== undefined) {
      scene.remove(prev.ambient);
      scene.remove(prev.directional);
      (prev.ambient as { dispose?(): void }).dispose?.();
      (prev.directional as { dispose?(): void }).dispose?.();
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
    sceneLights.set(ctx.world, { ambient, directional });
    ctx.emit("three.lighting.updated", { castShadow: input.castShadow });
    return { ok: true };
  },
};

// Lights authored one-at-a-time via three.addLight. The namespace resets with each
// logical world even when BrowserRenderHost retains the same Scene across reboots.
interface AddedLightState { nextId: number; lights: Map<string, unknown> }
const addedLights = new WeakMap<WorldContext, AddedLightState>();

const LIGHT_KINDS = ["directional", "point", "spot"] as const;

const addLightInput = z.object({
  kind: z.enum(LIGHT_KINDS),
  color: z.number().int().min(0).max(0xffffff).default(0xffffff),
  intensity: z.number().min(0).max(100).default(1),
  // directional: the light's position (it points at `target`, default origin).
  // point/spot: the light's world position.
  position: Vec3.default([0, 0, 0]),
  // directional/spot only: the point the light aims at. Default is three's own
  // default target (world origin) — set only when the caller wants otherwise, so
  // its Object3D (which three requires added to the scene to take effect) is only
  // created when actually needed.
  target: Vec3.optional(),
  // point/spot: max range before falloff hits zero. 0 = no limit (three.js default).
  distance: z.number().min(0).default(0),
  // point/spot: physical falloff exponent (2 = physically correct, three.js default).
  decay: z.number().min(0).default(2),
  // spot: cone half-angle in radians (three.js default Math.PI/3).
  angle: z.number().min(0).max(Math.PI / 2).default(Math.PI / 3),
  // spot: soft-edge fraction of the cone, 0 (hard) - 1 (fully soft).
  penumbra: z.number().min(0).max(1).default(0),
  // Real shadow mapping, same idea as setLighting's directional shadow: point/spot
  // get a perspective shadow camera (near/far only — three sizes the frustum from
  // distance/angle itself); directional keeps the orthographic frustum, sized via
  // shadowCameraExtent exactly like setLighting.
  castShadow: z.boolean().default(false),
  shadowMapSize: z.number().int().min(256).max(4096).default(1024),
  shadowCameraExtent: z.number().positive().max(500).default(20),
  shadowCameraNear: z.number().positive().default(0.5),
  shadowCameraFar: z.number().positive().default(120),
  shadowBias: z.number().min(-0.01).max(0.01).default(-0.0008),
});
const addLight: SkillDefinition<z.infer<typeof addLightInput>, { ok: boolean; id: string }> = {
  name: "three.addLight",
  version: "1.0.0",
  description: "Add one directional/point/spot light to the scene (on top of setLighting's single ambient+directional pair) and return its id for later three.removeLight. Supports color/intensity, position, a directional/spot target, point/spot range+decay, spot angle+penumbra, and real shadow-map casting.",
  category: "three",
  permissions: ["scene.write"],
  input: addLightInput,
  output: z.object({ ok: z.boolean(), id: z.string() }),
  handler: (input, ctx) => {
    const scene = ctx.world.scene;
    let light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;
    switch (input.kind) {
      case "directional": {
        const l = new THREE.DirectionalLight(input.color, input.intensity);
        l.position.set(input.position[0], input.position[1], input.position[2]);
        if (input.target !== undefined) {
          l.target.position.set(input.target[0], input.target[1], input.target[2]);
          scene.add(l.target);
        }
        light = l;
        break;
      }
      case "point": {
        const l = new THREE.PointLight(input.color, input.intensity, input.distance, input.decay);
        l.position.set(input.position[0], input.position[1], input.position[2]);
        light = l;
        break;
      }
      case "spot": {
        const l = new THREE.SpotLight(input.color, input.intensity, input.distance, input.angle, input.penumbra, input.decay);
        l.position.set(input.position[0], input.position[1], input.position[2]);
        if (input.target !== undefined) {
          l.target.position.set(input.target[0], input.target[1], input.target[2]);
          scene.add(l.target);
        }
        light = l;
        break;
      }
    }
    if (input.castShadow) {
      light.castShadow = true;
      light.shadow.mapSize.width = input.shadowMapSize;
      light.shadow.mapSize.height = input.shadowMapSize;
      light.shadow.bias = input.shadowBias;
      const cam = light.shadow.camera;
      cam.near = input.shadowCameraNear;
      cam.far = input.shadowCameraFar;
      if (light instanceof THREE.DirectionalLight) {
        const orthographicCamera = light.shadow.camera;
        orthographicCamera.left = -input.shadowCameraExtent;
        orthographicCamera.right = input.shadowCameraExtent;
        orthographicCamera.top = input.shadowCameraExtent;
        orthographicCamera.bottom = -input.shadowCameraExtent;
      }
      cam.updateProjectionMatrix();
    }
    scene.add(light);
    let state = addedLights.get(ctx.world);
    if (state === undefined) {
      state = { nextId: 0, lights: new Map() };
      addedLights.set(ctx.world, state);
    }
    const id = `light_${state.nextId++}`;
    state.lights.set(id, light);
    ctx.emit("three.light.added", { id, kind: input.kind });
    return { ok: true, id };
  },
};

const removeLightInput = z.object({ id: z.string() });
const removeLight: SkillDefinition<z.infer<typeof removeLightInput>, { ok: boolean }> = {
  name: "three.removeLight",
  version: "1.0.0",
  description: "Remove a light previously added via three.addLight, by its id.",
  category: "three",
  permissions: ["scene.write"],
  input: removeLightInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const scene = ctx.world.scene;
    const state = addedLights.get(ctx.world);
    const light = state?.lights.get(input.id) as { target?: unknown; dispose?(): void } | undefined;
    if (light === undefined) return { ok: false };
    scene.remove(light);
    if (light.target !== undefined) scene.remove(light.target);
    light.dispose?.();
    state!.lights.delete(input.id);
    ctx.emit("three.light.removed", { id: input.id });
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

export interface GltfSceneCacheOptions {
  maxEntries?: number;
  maxSourceBytes?: number;
  maxResidentBytes?: number;
  /** Project-owned Basis runtime URL. Must end in '/'. Configure after renderer init. */
  ktx2TranscoderPath?: string;
  ktx2TranscoderBytes?: { js: Uint8Array; wasm: Uint8Array };
}

export interface GltfSceneCacheStats {
  entries: number;
  sourceBytes: number;
  residentBytes: number;
  inFlight: number;
  parses: number;
  evictions: number;
}

interface GltfCacheEntry {
  readonly key: string;
  readonly sourceBytes: number;
  readonly residentBytes: number;
  readonly template: SceneObject;
}

export class GltfSceneParseError extends Error {
  readonly assetId: string;

  constructor(assetId: string, cause: unknown) {
    super(`failed to parse glTF '${assetId}': ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "GltfSceneParseError";
    this.assetId = assetId;
  }
}

export class GltfSceneCacheMissError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super(`glTF cache miss for '${assetId}' while a world session is active; prewarm it before acquireWorld()`);
    this.name = "GltfSceneCacheMissError";
    this.assetId = assetId;
  }
}

const DEFAULT_GLTF_CACHE_ENTRIES = 256;
const DEFAULT_GLTF_CACHE_SOURCE_BYTES = 512 * 1024 * 1024;
const DEFAULT_GLTF_CACHE_RESIDENT_BYTES = 2 * 1024 * 1024 * 1024;

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return resolved;
}

/** The loader's interpretation depends on both the bytes and the relative-resource base. */
export function gltfSceneContentKey(assetId: string, bytes: Uint8Array): string {
  if (typeof assetId !== "string" || assetId.length === 0) throw new TypeError("glTF asset id must be a non-empty string");
  if (!(bytes instanceof Uint8Array)) throw new TypeError("glTF source must be a Uint8Array");
  const base = assetId.includes("/") ? assetId.slice(0, assetId.lastIndexOf("/") + 1) : "";
  const format = assetId.toLowerCase().endsWith(".gltf") ? "gltf-json" : "glb";
  const parseContext = `limina-gltf-loader-v1\u0000rgba-rehome-v1\u0000${format}\u0000${base}`;
  return `sha256:${sha256(bytes)}:${sha256(parseContext)}`;
}

function markGltfHostResources(root: SceneObject): void {
  const mark = (resource: unknown): void => {
    if (!isRecord(resource)) return;
    const userData = isRecord(resource.userData) ? resource.userData : undefined;
    if (userData !== undefined) userData.liminaLifetime = "host";
  };
  const visit = (object: unknown): void => {
    if (!isRecord(object)) return;
    mark(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!isRecord(material)) continue;
      mark(material);
      for (const value of Object.values(material)) if (isRecord(value) && value.isTexture === true) mark(value);
    }
  };
  const candidate = root as unknown as { traverse?: (visitor: (object: unknown) => void) => void };
  if (typeof candidate.traverse === "function") candidate.traverse(visit);
  else visit(root);
}

function disposeGltfTemplate(root: SceneObject, disposedResources: WeakSet<object>): unknown[] {
  const geometries = new Set<Record<string, unknown>>();
  const materials = new Set<Record<string, unknown>>();
  const textures = new Set<Record<string, unknown>>();
  const visit = (object: unknown): void => {
    if (!isRecord(object)) return;
    if (isRecord(object.geometry)) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!isRecord(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (isRecord(value) && value.isTexture === true) textures.add(value);
      }
    }
  };
  const candidate = root as unknown as { traverse?: (visitor: (object: unknown) => void) => void };
  if (typeof candidate.traverse === "function") candidate.traverse(visit);
  else visit(root);
  const errors: unknown[] = [];
  const dispose = (resource: Record<string, unknown>): void => {
    if (disposedResources.has(resource)) return;
    disposedResources.add(resource);
    if (typeof resource.dispose === "function") {
      try { resource.dispose(); } catch (error) { errors.push(error); }
    }
  };
  for (const texture of textures) dispose(texture);
  for (const material of materials) dispose(material);
  for (const geometry of geometries) dispose(geometry);
  return errors;
}

function arrayView(value: unknown): ArrayBufferView | undefined {
  if (!isRecord(value)) return undefined;
  const array = ArrayBuffer.isView(value.array) ? value.array
    : isRecord(value.data) && ArrayBuffer.isView(value.data.array) ? value.data.array
    : undefined;
  return array;
}

/** Conservative CPU+GPU residency estimate for one parsed glTF template. */
export function estimateGltfSceneResidentBytes(root: SceneObject): number {
  const geometries = new Set<Record<string, unknown>>();
  const materials = new Set<Record<string, unknown>>();
  const textures = new Set<Record<string, unknown>>();
  let objects = 0;
  const visit = (object: unknown): void => {
    if (!isRecord(object)) return;
    objects++;
    if (isRecord(object.geometry)) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!isRecord(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (isRecord(value) && value.isTexture === true) textures.add(value);
    }
  };
  const candidate = root as unknown as { traverse?: (visitor: (object: unknown) => void) => void };
  if (typeof candidate.traverse === "function") candidate.traverse(visit);
  else visit(root);

  const geometryBuffers = new Map<ArrayBufferLike, number>();
  const takeGeometryArray = (value: unknown): void => {
    const view = arrayView(value);
    if (view !== undefined && !geometryBuffers.has(view.buffer)) geometryBuffers.set(view.buffer, view.buffer.byteLength);
  };
  for (const geometry of geometries) {
    takeGeometryArray(geometry.index);
    if (isRecord(geometry.attributes)) for (const attribute of Object.values(geometry.attributes)) takeGeometryArray(attribute);
    if (isRecord(geometry.morphAttributes)) {
      for (const attributes of Object.values(geometry.morphAttributes)) {
        if (Array.isArray(attributes)) for (const attribute of attributes) takeGeometryArray(attribute);
      }
    }
  }
  // Parsed backing stores remain CPU-resident while GPU buffers hold another copy.
  const geometryBytes = [...geometryBuffers.values()].reduce((sum, bytes) => sum + bytes, 0) * 2;

  let textureBytes = 0;
  for (const texture of textures) {
    const images = [];
    if (isRecord(texture.image)) images.push(texture.image);
    if (Array.isArray(texture.mipmaps)) for (const mip of texture.mipmaps) if (isRecord(mip)) images.push(mip);
    let baseBytes = 0;
    for (const image of images) {
      if (ArrayBuffer.isView(image.data)) baseBytes += image.data.byteLength;
      else {
        const width = image.width, height = image.height;
        if (typeof width === "number" && typeof height === "number"
            && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
          baseBytes += width * height * 4;
        }
      }
    }
    // CPU decoded pixels plus GPU base level; generated mip chains add at most 1/3 GPU overhead.
    textureBytes += baseBytes * (texture.generateMipmaps === true ? 7 / 3 : 2);
  }
  // Bounded structural overhead prevents empty/lightweight scenes from estimating as zero.
  const structuralBytes = objects * 1024 + materials.size * 2048 + geometries.size * 512 + textures.size * 512;
  return Math.max(1, Math.ceil(geometryBytes + textureBytes + structuralBytes));
}

function cloneGltfRoot(root: SceneObject): SceneObject {
  const r = root as unknown as { clone?: (recursive?: boolean) => SceneObject; animations?: unknown[] };
  if (typeof r.clone !== "function") return root;
  const copy = r.clone(true);
  // Geometry and decoded textures are immutable cache assets; materials are mutable
  // placement state and must never be shared across clones or with the template.
  const cloneMaterial = (material: unknown): unknown => {
    if (!isRecord(material) || typeof material.clone !== "function") return material;
    const cloned = material.clone() as Record<string, unknown>;
    if (isRecord(cloned.userData)) delete cloned.userData.liminaLifetime;
    return cloned;
  };
  const visit = (object: unknown): void => {
    if (!isRecord(object) || object.material === undefined) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  };
  const candidate = copy as unknown as { traverse?: (visitor: (object: unknown) => void) => void };
  if (typeof candidate.traverse === "function") candidate.traverse(visit);
  else visit(copy);
  // Carry the retained animation clips across too.
  (copy as unknown as { animations?: unknown[] }).animations = r.animations ?? [];
  return copy;
}

function gltfJson(bytes: Uint8Array, assetId: string): Record<string, unknown> | undefined {
  try {
    let json: unknown;
    if (assetId.toLowerCase().endsWith(".gltf")) json = JSON.parse(new TextDecoder().decode(bytes));
    else if (bytes.byteLength >= 20 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x46546c67) {
      const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)).replace(/\0+$/, ""));
    }
    return json as Record<string, unknown>;
  } catch { return undefined; }
}
function usesKtx2(bytes: Uint8Array, assetId: string): boolean {
  const document = gltfJson(bytes, assetId) as { extensionsUsed?: unknown; textures?: Array<{ extensions?: Record<string, unknown> }> } | undefined;
  return document?.extensionsUsed instanceof Array && document.extensionsUsed.includes("KHR_texture_basisu")
    || document?.textures?.some((texture) => texture.extensions?.KHR_texture_basisu !== undefined) === true;
}

async function parseGltfTemplate(assetId: string, bytes: Uint8Array, ktx2Loader?: unknown): Promise<SceneObject> {
  const manager = new THREE.LoadingManager();
  const base = assetId.includes("/") ? assetId.slice(0, assetId.lastIndexOf("/") + 1) : "";
  manager.setURLModifier((url: string) => {
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("limina-asset://")) return url;
    return `limina-asset://${base}${url}`;
  });
  const loader = new THREE.GLTFLoader(manager);
  if (usesKtx2(bytes, assetId)) {
    if (ktx2Loader === undefined) throw new GltfSceneParseError(assetId, new Error("KHR_texture_basisu requires a renderer-configured project Basis transcoder"));
    loader.setKTX2Loader(ktx2Loader as never);
  }
  const payload: string | ArrayBuffer = assetId.toLowerCase().endsWith(".gltf")
    ? new TextDecoder().decode(bytes)
    : bytes.slice().buffer as ArrayBuffer;
  let gltf: { scene: SceneObject; animations?: unknown[]; parser?: { getDependency(type: string, index: number): Promise<SceneObject> } };
  try {
    gltf = await new Promise<{ scene: SceneObject; animations?: unknown[] }>((resolve, reject) => {
      loader.parse(
        payload,
        `limina-asset://${base}`,
        (loaded: { scene: SceneObject; animations?: unknown[] }) => resolve(loaded),
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  } catch (error) {
    throw new GltfSceneParseError(assetId, error);
  }
  const root = gltf.scene;
  const document = gltfJson(bytes, assetId) as { asset?: { extras?: { liminaStaticBatch?: { lodRoots?: number[] } } } } | undefined;
  const lodRoots = document?.asset?.extras?.liminaStaticBatch?.lodRoots;
  if (Array.isArray(lodRoots) && lodRoots.length > 1 && gltf.parser !== undefined) {
    for (const [level, index] of lodRoots.entries()) {
      const node = await gltf.parser.getDependency("node", index); node.visible = level === 0; root.add(node);
    }
  }
  prepareGltfTextures(root);
  (root as unknown as { animations?: unknown[] }).animations = gltf.animations ?? [];
  markGltfHostResources(root);
  return root;
}

/**
 * Owns immutable parsed templates for one renderer host. Entries are content addressed; asset ids
 * are only aliases to the latest successfully parsed content. Cache fills and eviction are forbidden
 * while a world is active, making render-session reads deterministic and synchronous.
 */
export class GltfSceneCache {
  readonly #maxEntries: number;
  readonly #maxSourceBytes: number;
  readonly #maxResidentBytes: number;
  readonly #entries = new Map<string, GltfCacheEntry>();
  readonly #aliases = new Map<string, string>();
  readonly #aliasRequests = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<GltfCacheEntry>>();
  readonly #disposedResources = new WeakSet<object>();
  readonly #ktx2TranscoderPath?: string;
  readonly #ktx2TranscoderBytes?: { js: Uint8Array; wasm: Uint8Array };
  #ktx2Loader?: { dispose(): void };
  #sourceBytes = 0;
  #residentBytes = 0;
  #activeWorlds = 0;
  #requestSequence = 0;
  #parses = 0;
  #evictions = 0;
  #activePrewarm = false;
  #disposed = false;

  constructor(options: GltfSceneCacheOptions = {}) {
    this.#maxEntries = positiveSafeInteger(options.maxEntries, DEFAULT_GLTF_CACHE_ENTRIES, "glTF cache maxEntries");
    this.#maxSourceBytes = positiveSafeInteger(options.maxSourceBytes, DEFAULT_GLTF_CACHE_SOURCE_BYTES, "glTF cache maxSourceBytes");
    this.#maxResidentBytes = positiveSafeInteger(options.maxResidentBytes, DEFAULT_GLTF_CACHE_RESIDENT_BYTES, "glTF cache maxResidentBytes");
    if (options.ktx2TranscoderPath !== undefined && (!options.ktx2TranscoderPath.startsWith("/") || !options.ktx2TranscoderPath.endsWith("/"))) throw new Error("KTX2 transcoder path must be an absolute project URL ending in '/'");
    this.#ktx2TranscoderPath = options.ktx2TranscoderPath;
    this.#ktx2TranscoderBytes = options.ktx2TranscoderBytes;
  }

  configureKtx2(renderer: unknown): void {
    if (this.#disposed) throw new Error("glTF scene cache is disposed");
    // Late configuration is SAFE for already-parsed entries: a GLB that actually
    // carries KTX2 textures fails its parse loudly when no loader is registered
    // (GLTFLoader's setKTX2Loader contract), so nothing KTX2-textured can be
    // resident from before this call. It cannot be earlier by design: runLive
    // pre-warms asset bytes BEFORE renderer.init() (frame-collapse law), and the
    // transcoder's detectSupport needs the initialized renderer.
    if (this.#ktx2TranscoderPath === undefined) return;
    if (this.#ktx2Loader !== undefined) return;
    const manager = new THREE.LoadingManager();
    if (this.#ktx2TranscoderBytes !== undefined) {
      const encode = (bytes: Uint8Array, mime: string): string => {
        let binary = ""; for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
        return `data:${mime};base64,${btoa(binary)}`;
      };
      const js = encode(this.#ktx2TranscoderBytes.js, "text/javascript");
      const wasm = encode(this.#ktx2TranscoderBytes.wasm, "application/wasm");
      manager.setURLModifier((url: string) => url.endsWith("basis_transcoder.js") ? js : url.endsWith("basis_transcoder.wasm") ? wasm : url);
    }
    const loader = new THREE.KTX2Loader(manager);
    loader.setTranscoderPath(this.#ktx2TranscoderPath);
    // Native transcoding uses the deliberately bounded same-isolate Worker shim.
    // Multiple workers cannot run in parallel there and would instantiate the
    // Basis WASM module repeatedly on the render isolate before useful work.
    if (this.#ktx2TranscoderBytes !== undefined) loader.setWorkerLimit(1);
    loader.detectSupport(renderer as never);
    this.#ktx2Loader = loader;
  }

  beginWorld(): void {
    if (this.#disposed) throw new Error("glTF scene cache is disposed");
    if (this.#inFlight.size > 0) throw new Error("cannot begin a world while glTF cache prewarming is in flight");
    if (this.#activeWorlds !== 0) throw new Error("glTF scene cache already has an active world");
    this.#activeWorlds = 1;
  }

  endWorld(): void {
    if (this.#activeWorlds < 1) throw new Error("glTF scene cache has no active world");
    if (this.#activePrewarm || this.#inFlight.size > 0) {
      throw new Error("cannot end a world while active-world glTF prewarming is in flight");
    }
    this.#activeWorlds -= 1;
  }

  has(assetId: string, bytes?: Uint8Array): boolean {
    if (this.#disposed) return false;
    const aliasedKey = this.#aliases.get(assetId);
    if (aliasedKey === undefined) return false;
    return bytes === undefined
      ? this.#entries.has(aliasedKey)
      : aliasedKey === gltfSceneContentKey(assetId, bytes) && this.#entries.has(aliasedKey);
  }

  stats(): Readonly<GltfSceneCacheStats> {
    return Object.freeze({
      entries: this.#entries.size,
      sourceBytes: this.#sourceBytes,
      residentBytes: this.#residentBytes,
      inFlight: this.#inFlight.size,
      parses: this.#parses,
      evictions: this.#evictions,
    });
  }

  async prewarm(assetId: string, bytes: Uint8Array): Promise<void> {
    await this.#template(assetId, bytes);
  }

  /**
   * Fill previously unknown content while the sole world is active. The caller must suspend every
   * render frame for the complete await; this method is reserved for atomic derived activation.
   * Existing entries are never evicted because active clones may share their immutable resources.
   */
  async prewarmActiveWorld(entries: readonly Readonly<{ assetId: string; bytes: Uint8Array }>[]): Promise<void> {
    if (this.#disposed) throw new Error("glTF scene cache is disposed");
    if (this.#activeWorlds !== 1) throw new Error("active-world glTF prewarming requires exactly one active world");
    if (this.#activePrewarm || this.#inFlight.size > 0) throw new Error("active-world glTF prewarming is already in flight");
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype
        || Object.getOwnPropertySymbols(entries).length !== 0
        || Object.getOwnPropertyNames(entries).length !== entries.length + 1) {
      throw new TypeError("active-world glTF prewarm entries must be a dense standard array");
    }
    const seen = new Map<string, string>();
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)
          || Object.getOwnPropertyNames(entry).sort().join() !== "assetId,bytes"
          || typeof entry.assetId !== "string" || entry.assetId.length === 0
          || !(entry.bytes instanceof Uint8Array)) {
        throw new TypeError(`active-world glTF prewarm entry ${index} is invalid`);
      }
      const key = gltfSceneContentKey(entry.assetId, entry.bytes);
      const prior = seen.get(entry.assetId);
      if (prior !== undefined) throw new Error(`active-world glTF prewarm duplicates asset id '${entry.assetId}'`);
      seen.set(entry.assetId, key);
    }
    this.#activePrewarm = true;
    try { await Promise.all(entries.map((entry) => this.#template(entry.assetId, entry.bytes, true))); }
    finally { this.#activePrewarm = false; }
  }

  async parse(assetId: string, bytes: Uint8Array): Promise<SceneObject> {
    return cloneGltfRoot(await this.#template(assetId, bytes));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled(this.#inFlight.values());
    const errors: unknown[] = [];
    for (const entry of this.#entries.values()) errors.push(...disposeGltfTemplate(entry.template, this.#disposedResources));
    try { this.#ktx2Loader?.dispose(); } catch (error) { errors.push(error); }
    this.#ktx2Loader = undefined;
    this.#entries.clear();
    this.#aliases.clear();
    this.#aliasRequests.clear();
    this.#sourceBytes = 0;
    this.#residentBytes = 0;
    if (errors.length > 0) throw new AggregateError(errors, `glTF cache disposal failed for ${errors.length} resource(s)`);
  }

  async #template(assetId: string, bytes: Uint8Array, allowActiveFill = false): Promise<SceneObject> {
    if (this.#disposed) throw new Error("glTF scene cache is disposed");
    const key = gltfSceneContentKey(assetId, bytes);
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      if (this.#activeWorlds === 0) {
        this.#entries.delete(key);
        this.#entries.set(key, cached);
        this.#aliases.set(assetId, key);
      } else if (allowActiveFill) this.#aliases.set(assetId, key);
      return cached.template;
    }
    if (this.#activeWorlds > 0 && !allowActiveFill) throw new GltfSceneCacheMissError(assetId);
    const pending = this.#inFlight.get(key);
    if (pending !== undefined) {
      const request = ++this.#requestSequence;
      this.#aliasRequests.set(assetId, request);
      const entry = await pending;
      if (this.#aliasRequests.get(assetId) === request) this.#aliases.set(assetId, key);
      return entry.template;
    }
    if (bytes.byteLength > this.#maxSourceBytes) {
      throw new RangeError(`glTF source '${assetId}' is ${bytes.byteLength} bytes, exceeding cache budget ${this.#maxSourceBytes}`);
    }
    const request = ++this.#requestSequence;
    this.#aliasRequests.set(assetId, request);
    this.#parses += 1;
    const loading = (async (): Promise<GltfCacheEntry> => {
      const template = await parseGltfTemplate(assetId, bytes, this.#ktx2Loader);
      const residentBytes = estimateGltfSceneResidentBytes(template);
      if (residentBytes > this.#maxResidentBytes) {
        const budgetError = new RangeError(`decoded glTF '${assetId}' is estimated at ${residentBytes} resident bytes, exceeding cache budget ${this.#maxResidentBytes}`);
        const disposalErrors = disposeGltfTemplate(template, this.#disposedResources);
        if (disposalErrors.length > 0) throw new AggregateError([budgetError, ...disposalErrors], budgetError.message);
        throw budgetError;
      }
      const entry: GltfCacheEntry = { key, sourceBytes: bytes.byteLength, residentBytes, template };
      if (this.#disposed) {
        const errors = disposeGltfTemplate(template, this.#disposedResources);
        throw new AggregateError(
          [new Error("glTF scene cache was disposed during parse"), ...errors],
          "glTF scene cache was disposed during parse",
        );
      }
      const evictionErrors: unknown[] = [];
      if (allowActiveFill && this.#activeWorlds > 0) {
        if (this.#entries.size >= this.#maxEntries
            || this.#sourceBytes + entry.sourceBytes > this.#maxSourceBytes
            || this.#residentBytes + entry.residentBytes > this.#maxResidentBytes) {
          const budgetError = new RangeError(`active-world glTF '${assetId}' cannot fit without evicting live cache resources`);
          const disposalErrors = disposeGltfTemplate(template, this.#disposedResources);
          if (disposalErrors.length > 0) throw new AggregateError([budgetError, ...disposalErrors], budgetError.message);
          throw budgetError;
        }
      } else {
        while (this.#entries.size >= this.#maxEntries
            || this.#sourceBytes + entry.sourceBytes > this.#maxSourceBytes
            || this.#residentBytes + entry.residentBytes > this.#maxResidentBytes) {
          const oldest = this.#entries.entries().next().value as [string, GltfCacheEntry] | undefined;
          if (oldest === undefined) break;
          this.#entries.delete(oldest[0]);
          this.#sourceBytes -= oldest[1].sourceBytes;
          this.#residentBytes -= oldest[1].residentBytes;
          for (const [alias, aliasKey] of this.#aliases) if (aliasKey === oldest[0]) this.#aliases.delete(alias);
          evictionErrors.push(...disposeGltfTemplate(oldest[1].template, this.#disposedResources));
          this.#evictions += 1;
        }
      }
      this.#entries.set(key, entry);
      this.#sourceBytes += entry.sourceBytes;
      this.#residentBytes += entry.residentBytes;
      if (this.#aliasRequests.get(assetId) === request) this.#aliases.set(assetId, key);
      if (evictionErrors.length > 0) {
        console.warn(new AggregateError(evictionErrors, `glTF cache eviction failed for ${evictionErrors.length} resource(s)`));
      }
      return entry;
    })();
    this.#inFlight.set(key, loading);
    try { return (await loading).template; }
    finally { if (this.#inFlight.get(key) === loading) this.#inFlight.delete(key); }
  }
}

/** Standalone/headless compatibility cache. Browser worlds always use their render host's cache. */
export const defaultGltfSceneCache = new GltfSceneCache();

/** Ensure `assetId` is parsed + cached WITHOUT mounting it — call this before renderer.init() so a
 *  later parseGltfScene is a synchronous clone (no macrotask) and the mesh renders on the WebGL2
 *  backend. Idempotent; parse and resource-limit failures are reported to the caller. */
export async function prewarmGltfScene(assetId: string, bytes: Uint8Array, cache: GltfSceneCache = defaultGltfSceneCache): Promise<void> {
  await cache.prewarm(assetId, bytes);
}

/** Whether `assetId`'s root is already parsed + cached (a later parseGltfScene will be a clone). Lets
 *  a caller skip re-fetching bytes it doesn't need — the cache persists across viewport reboots. */
export function hasGltfScene(assetId: string, bytes?: Uint8Array, cache: GltfSceneCache = defaultGltfSceneCache): boolean {
  return cache.has(assetId, bytes);
}

/** Parse `bytes` as the glTF named `assetId` and return its scene root with textures
 *  re-homed for the WebGPU backend (see rehomeTextureToData). THE ONE place the
 *  GLTFLoader + the texture-rehome live: loadGltfIntoScene spawns an ENTITY from it,
 *  while asset.scatter INSTANCES its meshes — neither duplicates the loader setup.
 *  A cache HIT returns a synchronous clone (see gltfRootCache) — no GLTFLoader.parse. */
export async function parseGltfScene(assetId: string, bytes: Uint8Array, cache: GltfSceneCache = defaultGltfSceneCache): Promise<SceneObject> {
  return cache.parse(assetId, bytes);
}

/** THE shared asset->entity pipeline. Parses `bytes` as the glTF named `assetId`
 *  (parseGltfScene), adds it to the scene, spawns a renderable at `placement`, and
 *  records the content `hash` on its LoadedResourceMetadata. Both three.loadGLTF and
 *  asset.place call this — no duplicated loader/rehome code. */
export async function loadGltfIntoScene(
  ctx: {
    world: { simWorker?: boolean; gltfCache?: GltfSceneCache; scene: SceneLike; ecs: World; entities: { create(e: { eid: number; mesh?: SceneObject; resource?: LoadedResourceMetadata; origin?: EntityOrigin }): string } };
    /** ExecutionContext.undo (H1 chain compensation). Optional so non-skill
     *  callers with a bare {world} still compile; every registry-driven caller
     *  passes the real ctx, enrolling the created entity automatically. */
    undo?: (label: string, fn: () => void) => void;
  },
  assetId: string,
  bytes: Uint8Array,
  hash: string,
  placement: GltfPlacement,
): Promise<{ entity: string; resource: LoadedResourceMetadata }> {
  const [x, y, z] = placement.position;
  // SIM WORKER only: DO NOT parse the mesh. The render thread parses + mounts it; the worker just
  // needs the ENTITY (eid + transform) for physics/transform authority. Parsing a textured glTF in a
  // Worker HANGS — GLTFLoader's texture decode has no DOM — which stalls the worker's `ready`
  // handshake and freezes the viewport at "spawning sim worker". (The server recorder + gates are
  // also headless but DO parse — they have createImageBitmap and need the resource metadata/hash.)
  const skipMesh = ctx.world.simWorker === true;
  let root: SceneObject | undefined;
  if (!skipMesh) {
    try {
      root = await parseGltfScene(assetId, bytes, ctx.world.gltfCache);
      // Placed assets cast + receive shadows. GLTF meshes default castShadow=false, so a
      // placed building/prop would otherwise throw NO shadow (unlike vegetation.scatter,
      // which sets it) — leaving buildings looking ungrounded next to shadow-casting trees.
      (root as unknown as { traverse: (fn: (o: unknown) => void) => void }).traverse((o) => {
        const m = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
        if (m.isMesh === true) { m.castShadow = true; m.receiveShadow = true; }
      });
      ctx.world.scene.add(root);
    } catch (error) {
      if (!(error instanceof GltfSceneParseError)) throw error;
      // A missing/corrupt asset (e.g. empty bytes because the /assets route isn't served) must NOT
      // fail the whole apply loop and take down the viewport. Spawn the entity WITHOUT a mesh — it's
      // invisible until the asset is available, but the scene still loads.
      root = undefined;
    }
  }
  const transform = (root ?? INERT_GLTF_TRANSFORM) as unknown as Parameters<typeof spawnRenderable>[1];
  const eid = spawnRenderable(ctx.world.ecs, transform, x, y, z);
  if (placement.rotationEuler !== undefined) {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(placement.rotationEuler[0], placement.rotationEuler[1], placement.rotationEuler[2]),
    );
    Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w;
  }
  if (placement.scale !== undefined) {
    Scale.x[eid] = placement.scale[0]; Scale.y[eid] = placement.scale[1]; Scale.z[eid] = placement.scale[2];
  }
  const resource: LoadedResourceMetadata = root !== undefined
    ? collectGltfMetadata(assetId, hash, bytes, root)
    : { kind: "gltf", assetId, source: `assets/${assetId}`, hash, bytes: bytes.byteLength, objectCount: 0, meshCount: 0, materialCount: 0, textureCount: 0 };
  const entity = root !== undefined
    ? ctx.world.entities.create({ eid, mesh: root, resource })
    : ctx.world.entities.create({ eid, origin: { tool: "asset.load", input: { assetId, position: placement.position } } });
  // H1 compensation: a failure anywhere in this skill chain tears the entity back
  // down. teardownEntity is the canonical four-part teardown and runs the entry's
  // runtimeDispose first, so later-armed owned resources (asset.place's collider)
  // ride along; it no-ops on an already-destroyed id, so overlapping undos are safe.
  // ctx.world here is the structural narrow view of the one real WorldContext every
  // registry caller passes — the cast re-widens it for the teardown.
  ctx.undo?.(`gltf entity ${assetId}`, () => {
    teardownEntity(ctx.world as unknown as WorldContext, entity);
  });
  return { entity, resource };
}

/** Inert Transformable for the sim-worker entity spawn (position comes from spawnRenderable's args). */
const INERT_GLTF_TRANSFORM = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

/** Compose a screen-distance THREE.LOD from ordered levels (level 0 = highest detail) and mount it as
 *  ONE entity — the mesh-side sibling of loadGltfIntoScene, sharing the same sim-worker skipMesh rule
 *  (the worker never parses a mesh — texture decode hangs it — so it spawns the entity WITHOUT the LOD;
 *  the collider, authored from level-0 bytes by asset.placeLod, is what the worker's physics needs).
 *  Returns the LOD object so the caller can register it for the per-frame `lod.update(camera)` pass. */
export async function loadLodIntoScene(
  ctx: {
    world: { simWorker?: boolean; gltfCache?: GltfSceneCache; scene: SceneLike; ecs: World; entities: { create(e: { eid: number; mesh?: SceneObject; resource?: LoadedResourceMetadata; origin?: EntityOrigin }): string } };
    /** ExecutionContext.undo (H1) — same enrollment contract as loadGltfIntoScene. */
    undo?: (label: string, fn: () => void) => void;
  },
  levels: ReadonlyArray<{ assetId: string; bytes: Uint8Array; hash: string; distance: number }>,
  placement: GltfPlacement,
): Promise<{ entity: string; resource: LoadedResourceMetadata; lod?: SceneObject }> {
  const [x, y, z] = placement.position;
  const base = levels[0];
  const skipMesh = ctx.world.simWorker === true;
  let lod: SceneObject | undefined;
  if (!skipMesh) {
    // deno-lint-ignore no-explicit-any
    const L = new (THREE as any).LOD();
    for (const lvl of levels) {
      try {
        const mesh = await parseGltfScene(lvl.assetId, lvl.bytes, ctx.world.gltfCache);
        (mesh as unknown as { traverse: (fn: (o: unknown) => void) => void }).traverse((o) => {
          const m = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
          if (m.isMesh === true) { m.castShadow = true; m.receiveShadow = true; }
        });
        L.addLevel(mesh, lvl.distance);
      } catch (error) {
        if (!(error instanceof GltfSceneParseError)) throw error;
        // A missing/corrupt level is dropped — the LOD still works from its remaining levels (and if
        // ALL levels fail, the entity spawns mesh-less, like loadGltfIntoScene's catch).
      }
    }
    if (L.levels.length > 0) { lod = L as SceneObject; ctx.world.scene.add(lod); }
  }
  const transform = (lod ?? INERT_GLTF_TRANSFORM) as unknown as Parameters<typeof spawnRenderable>[1];
  const eid = spawnRenderable(ctx.world.ecs, transform, x, y, z);
  if (placement.rotationEuler !== undefined) {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(placement.rotationEuler[0], placement.rotationEuler[1], placement.rotationEuler[2]),
    );
    Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w;
  }
  if (placement.scale !== undefined) {
    Scale.x[eid] = placement.scale[0]; Scale.y[eid] = placement.scale[1]; Scale.z[eid] = placement.scale[2];
  }
  const resource: LoadedResourceMetadata = lod !== undefined
    ? collectGltfMetadata(base.assetId, base.hash, base.bytes, lod)
    : { kind: "gltf", assetId: base.assetId, source: `assets/${base.assetId}`, hash: base.hash, bytes: base.bytes.byteLength, objectCount: 0, meshCount: 0, materialCount: 0, textureCount: 0 };
  const entity = lod !== undefined
    ? ctx.world.entities.create({ eid, mesh: lod, resource })
    : ctx.world.entities.create({ eid, origin: { tool: "asset.loadLod", input: { assetId: base.assetId, position: placement.position } } });
  // H1 compensation — same contract as loadGltfIntoScene above.
  ctx.undo?.(`gltf lod entity ${base.assetId}`, () => {
    teardownEntity(ctx.world as unknown as WorldContext, entity);
  });
  return { entity, resource, lod };
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
  registry.register(addLight);
  registry.register(removeLight);
  registry.register(makeLoadGltf(assets));
}
