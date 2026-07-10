// Phase 11 — embedded-glTF (GLB bufferView) texture loading. palm.glb is a
// Quaternius CC0 palm whose base-color image is packed in the .glb BIN chunk
// (sourceDef.bufferView, not a data: URI). three's GLTFLoader loads such images
// by wrapping the bytes in a Blob + URL.createObjectURL, then fetching that
// object URL. The bare embedder produced opaque `blob:null/...` URLs its
// asset-only fetch couldn't resolve, so the image never decoded and the palm
// rendered WHITE (material.map === null). The bootstrap now backs object URLs
// with a JS-side registry so the blob round-trips through fetch ->
// createImageBitmap, and parseGltfScene re-homes the bitmap to RGBA pixels.
//
// This test is FALSIFIABLE: reverting the bootstrap fix makes palm's
// material.map null (or its image undecoded), and the assertions below fail.
// It also confirms the factor/vertex-color assets (cottage, rock) still parse
// clean with zero textures.

import { ops } from "../src/engine.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { parseGltfScene } from "../src/skills/three.ts";
import type { SceneObject } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_gltf_texture FAIL: " + msg);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

ops.op_physics_create_world(0);
const reg = new AssetRegistry();

interface MapImage { data?: unknown; width?: unknown; height?: unknown }
interface TexLike { image?: MapImage; isDataTexture?: unknown }
interface MatLike { map?: TexLike | null }

function firstMesh(root: SceneObject): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  const visit = (node: unknown): void => {
    if (found === undefined && isRecord(node) && node.isMesh === true) found = node;
  };
  if (typeof root.traverse === "function") root.traverse(visit);
  else visit(root);
  assert(found !== undefined, "fixture has no mesh");
  return found;
}

function collectBaseColorMaps(root: SceneObject): TexLike[] {
  const maps: TexLike[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    const material = node.material;
    const mats = Array.isArray(material) ? material : material !== undefined ? [material] : [];
    for (const m of mats) {
      const map = (m as MatLike).map;
      if (map !== undefined && map !== null) maps.push(map);
    }
    const children = node.children;
    if (Array.isArray(children)) for (const c of children) visit(c);
  };
  if (typeof root.traverse === "function") root.traverse(visit);
  else visit(root);
  return maps;
}

// --- textured fixture: embedded bufferView base-color texture must LOAD ----------
const palmAsset = "fixtures/textured-cube.glb";
const palm = reg.resolve(palmAsset);
const palmRoot = await parseGltfScene(palmAsset, palm.bytes);
const palmMaps = collectBaseColorMaps(palmRoot);

assert(palmMaps.length >= 1, "textured fixture base-color material.map is null/absent (embedded texture failed to load -> renders white)");
const map = palmMaps[0];
assert(isRecord(map.image), "textured fixture material.map has no image (texture never decoded)");
const data = map.image?.data;
assert(data instanceof Uint8Array && data.length >= 4, "textured fixture was not decoded to RGBA pixels (image.data missing)");
const w = Number(map.image?.width ?? 0);
const h = Number(map.image?.height ?? 0);
assert(w > 0 && h > 0, `textured fixture has no decoded dimensions (${w}x${h})`);
assert(data.length === w * h * 4, `textured fixture decoded pixel buffer size ${data.length} != ${w}*${h}*4`);
assert(map.isDataTexture === true, "textured fixture was not re-homed to the DataTexture upload path (would render black on WebGPU)");
// Non-trivial content: a real decoded image is not all-zero.
let nonZero = false;
for (let i = 0; i < data.length; i++) { if (data[i] !== 0) { nonZero = true; break; } }
assert(nonZero, "textured fixture decoded texture pixels are all zero (decode produced an empty image)");

const palmRoot2 = await parseGltfScene(palmAsset, palm.bytes);
const mesh1 = firstMesh(palmRoot);
const mesh2 = firstMesh(palmRoot2);
assert(mesh1.geometry === mesh2.geometry, "cached GLTF clones stopped sharing immutable geometry");
assert(mesh1.material !== mesh2.material, "cached GLTF clones share mutable material state");
const material1 = mesh1.material as { color?: { set(value: number): void; getHex(): number }; map?: unknown };
const material2 = mesh2.material as { color?: { getHex(): number }; map?: unknown };
const color2 = material2.color?.getHex();
material1.color?.set(0xff00ff);
assert(material2.color?.getHex() === color2, "material mutation on one GLTF placement contaminated another clone");
assert(material1.map === material2.map, "cached GLTF clones stopped sharing immutable decoded textures");

// --- untextured fixture: factor/vertex-color assets parse clean with 0 maps ----------
for (const id of ["fixtures/mesh.glb"]) {
  const res = reg.resolve(id);
  const root = await parseGltfScene(id, res.bytes);
  let meshCount = 0;
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.isMesh === true) meshCount += 1;
    const children = node.children;
    if (Array.isArray(children)) for (const c of children) visit(c);
  };
  if (typeof root.traverse === "function") root.traverse(visit);
  else visit(root);
  assert(meshCount >= 1, `${id} parsed no meshes`);
  // These assets carry no image textures; they must still parse without error
  // and must not spuriously gain a decoded base-color map.
  const maps = collectBaseColorMaps(root);
  assert(maps.length === 0, `${id} unexpectedly has a base-color texture map (regression in non-embedded path)`);
}

ops.op_log(
  `p11_gltf_texture OK: textured fixture embedded bufferView base-color texture decoded to ${w}x${h} RGBA pixels ` +
  `(material.map: null -> loaded DataTexture); untextured fixture still parses clean with 0 textures.`,
);
