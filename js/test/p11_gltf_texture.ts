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

// --- palm.glb: embedded bufferView base-color texture must now LOAD ----------
const palmAsset = "palm.glb";
const palm = reg.resolve(palmAsset);
const palmRoot = await parseGltfScene(palmAsset, palm.bytes);
const palmMaps = collectBaseColorMaps(palmRoot);

assert(palmMaps.length >= 1, "palm.glb base-color material.map is null/absent (embedded texture failed to load -> renders white)");
const map = palmMaps[0];
assert(isRecord(map.image), "palm.glb material.map has no image (texture never decoded)");
const data = map.image?.data;
assert(data instanceof Uint8Array && data.length >= 4, "palm.glb texture was not decoded to RGBA pixels (image.data missing)");
const w = Number(map.image?.width ?? 0);
const h = Number(map.image?.height ?? 0);
assert(w > 0 && h > 0, `palm.glb texture has no decoded dimensions (${w}x${h})`);
assert(data.length === w * h * 4, `palm.glb decoded pixel buffer size ${data.length} != ${w}*${h}*4`);
assert(map.isDataTexture === true, "palm.glb texture was not re-homed to the DataTexture upload path (would render black on WebGPU)");
// Non-trivial content: a real decoded atlas is not all-zero.
let nonZero = false;
for (let i = 0; i < data.length; i++) { if (data[i] !== 0) { nonZero = true; break; } }
assert(nonZero, "palm.glb decoded texture pixels are all zero (decode produced an empty image)");

// --- cottage.glb + rock.glb: factor/vertex-color assets parse clean ----------
for (const id of ["cottage.glb", "rock.glb"]) {
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
  `p11_gltf_texture OK: palm.glb embedded bufferView base-color texture decoded to ${w}x${h} RGBA pixels ` +
  `(material.map: null -> loaded DataTexture); cottage.glb + rock.glb still parse clean with 0 textures.`,
);
