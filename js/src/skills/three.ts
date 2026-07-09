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

// Lights authored one-at-a-time via three.addLight, keyed by an opaque id so
// three.removeLight can target exactly one without disturbing the rest (or the
// single ambient+directional pair setLighting owns above). Per-scene, mirroring
// sceneLights: a scene torn down/rebuilt starts with a fresh light set.
const addedLights = new Map<SceneLike, Map<string, unknown>>();
let lightSeq = 0;

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
    let light: { castShadow: boolean; shadow: { mapSize: { width: number; height: number }; bias: number; camera: { near: number; far: number; left: number; right: number; top: number; bottom: number; updateProjectionMatrix(): void } }; position: { set(x: number, y: number, z: number): void }; target?: { position: { set(x: number, y: number, z: number): void } } };
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
      if (input.kind === "directional") {
        cam.left = -input.shadowCameraExtent;
        cam.right = input.shadowCameraExtent;
        cam.top = input.shadowCameraExtent;
        cam.bottom = -input.shadowCameraExtent;
      }
      cam.updateProjectionMatrix();
    }
    scene.add(light);
    const id = `light_${lightSeq++}`;
    let perScene = addedLights.get(scene);
    if (perScene === undefined) {
      perScene = new Map();
      addedLights.set(scene, perScene);
    }
    perScene.set(id, light);
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
    const perScene = addedLights.get(scene);
    const light = perScene?.get(input.id) as { target?: unknown } | undefined;
    if (light === undefined) return { ok: false };
    scene.remove(light);
    if (light.target !== undefined) scene.remove(light.target);
    perScene!.delete(input.id);
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

// A cache of PARSED glTF roots keyed by assetId. parseGltfScene stores the parsed root here as a
// pristine TEMPLATE (never mounted) and returns a CLONE, so a repeat parse is a synchronous clone
// instead of an async GLTFLoader.parse. This is load-bearing for the live viewport, NOT just a perf
// win: GLTFLoader.parse runs createImageBitmap (a macrotask), and on the WebGPURenderer WebGL2 backend
// a macrotask firing around a render permanently corrupts the render (invisible mesh). Pre-warming
// this cache before renderer.init() (prewarmGltfScene) means every mid-session mount is a clone —
// no macrotask — so the mesh renders. Same assetId => same content-addressed bytes => equivalent
// clone, so determinism/replay are unaffected (a fresh process starts with an empty cache).
const gltfRootCache = new Map<string, SceneObject>();

function cloneGltfRoot(root: SceneObject): SceneObject {
  const r = root as unknown as { clone?: (recursive?: boolean) => SceneObject; animations?: unknown[] };
  if (typeof r.clone !== "function") return root;
  const copy = r.clone(true);
  // clone(true) copies the hierarchy + transforms and SHARES geometry/material (cheap); carry the
  // retained animation clips across too.
  (copy as unknown as { animations?: unknown[] }).animations = r.animations ?? [];
  return copy;
}

/** Ensure `assetId` is parsed + cached WITHOUT mounting it — call this before renderer.init() so a
 *  later parseGltfScene is a synchronous clone (no macrotask) and the mesh renders on the WebGL2
 *  backend. Idempotent; a parse failure is swallowed (the later mount surfaces it). */
export async function prewarmGltfScene(assetId: string, bytes: Uint8Array): Promise<void> {
  if (gltfRootCache.has(assetId)) return;
  try { await parseGltfScene(assetId, bytes); } catch { /* the real mount will report the failure */ }
}

/** Whether `assetId`'s root is already parsed + cached (a later parseGltfScene will be a clone). Lets
 *  a caller skip re-fetching bytes it doesn't need — the cache persists across viewport reboots. */
export function hasGltfScene(assetId: string): boolean {
  return gltfRootCache.has(assetId);
}

/** Parse `bytes` as the glTF named `assetId` and return its scene root with textures
 *  re-homed for the WebGPU backend (see rehomeTextureToData). THE ONE place the
 *  GLTFLoader + the texture-rehome live: loadGltfIntoScene spawns an ENTITY from it,
 *  while asset.scatter INSTANCES its meshes — neither duplicates the loader setup.
 *  A cache HIT returns a synchronous clone (see gltfRootCache) — no GLTFLoader.parse. */
export async function parseGltfScene(assetId: string, bytes: Uint8Array): Promise<SceneObject> {
  const cached = gltfRootCache.get(assetId);
  if (cached !== undefined) return cloneGltfRoot(cached);
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
  // Cache the pristine template + hand back a clone (the template is never mounted/mutated).
  gltfRootCache.set(assetId, root);
  return cloneGltfRoot(root);
}

/** THE shared asset->entity pipeline. Parses `bytes` as the glTF named `assetId`
 *  (parseGltfScene), adds it to the scene, spawns a renderable at `placement`, and
 *  records the content `hash` on its LoadedResourceMetadata. Both three.loadGLTF and
 *  asset.place call this — no duplicated loader/rehome code. */
export async function loadGltfIntoScene(
  ctx: { world: { simWorker?: boolean; scene: SceneLike; ecs: unknown; entities: { create(e: { eid: number; mesh?: SceneObject; resource?: LoadedResourceMetadata; origin?: unknown }): string } } },
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
      root = await parseGltfScene(assetId, bytes);
      // Placed assets cast + receive shadows. GLTF meshes default castShadow=false, so a
      // placed building/prop would otherwise throw NO shadow (unlike vegetation.scatter,
      // which sets it) — leaving buildings looking ungrounded next to shadow-casting trees.
      (root as unknown as { traverse: (fn: (o: unknown) => void) => void }).traverse((o) => {
        const m = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
        if (m.isMesh === true) { m.castShadow = true; m.receiveShadow = true; }
      });
      ctx.world.scene.add(root);
    } catch {
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
  ctx: { world: { simWorker?: boolean; scene: SceneLike; ecs: unknown; entities: { create(e: { eid: number; mesh?: SceneObject; resource?: LoadedResourceMetadata; origin?: unknown }): string } } },
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
        const mesh = await parseGltfScene(lvl.assetId, lvl.bytes);
        (mesh as unknown as { traverse: (fn: (o: unknown) => void) => void }).traverse((o) => {
          const m = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
          if (m.isMesh === true) { m.castShadow = true; m.receiveShadow = true; }
        });
        L.addLevel(mesh, lvl.distance);
      } catch {
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
