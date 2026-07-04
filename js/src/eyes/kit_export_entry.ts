// GLB EXPORT harness for a WHOLE kit-composed building (Slice 4). Assembles the SAME cottage as
// kit_building_entry.ts through assembleBuilding (kit parts under a building-root), walks the scene to
// collect every part mesh, converts each part's TSL **node material** into a plain
// THREE.MeshStandardMaterial the GLTFExporter can serialize (carrying base colour → SRGB-tagged albedo
// TEXTURE, plus roughness + metalness), and exports one binary GLB. The whole albedo lives in the
// baked SRGB texture (material.color left white) so the exported asset keeps its tactile mottle AND
// round-trips WITHOUT the classic "re-imports dark" bug — the albedo texture is tagged
// THREE.SRGBColorSpace (normal/roughness would stay NoColorSpace; we bake only albedo here).
//
// Two THREE instances ON PURPOSE: the ENGINE bundle (three.bundle.mjs) drives assembleBuilding exactly
// as the live engine does; the export Group / materials / textures are built with node_modules `three`
// so the node_modules GLTFExporter operates on objects of its OWN THREE — zero cross-instance risk on
// the serialize path. We only READ numbers (geometry buffers, world matrices, colour/roughness) out of
// the engine meshes, which is instance-agnostic.

import * as ENG from "../../build/three.bundle.mjs";
import * as STD from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { EntityTable } from "../engine.ts";
import { createEcsWorld, renderSyncSystem } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { assembleBuilding, type BuildingRecipe } from "../skills/building-recipe.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../game/design-direction.ts";
import type { WorldContext } from "../skills/registry.ts";

declare const window: {
  __glb?: string;
  __bounds?: { min: number[]; max: number[]; size: number[] };
  __done?: boolean;
  __err?: string;
  __log?: string[];
};
window.__log = [];
const log = (s: string): void => { (window.__log as string[]).push(s); };

// The EXACT cottage recipe kit_building_entry.ts renders, so the exported GLB is the same building the
// GPU-eyes source shot shows.
const COTTAGE: BuildingRecipe = {
  width: 8, depth: 6, height: 3.2, wallThickness: 0.25,
  openings: [
    { wall: "south", kind: "door", width: 1.4, height: 2.2, sill: 0 },
    { wall: "south", kind: "window", offset: 2.6, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "south", kind: "window", offset: -2.6, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "east", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "west", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "north", kind: "window", width: 1.6, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.6, overhang: 0.5 },
  plinth: true,
};

// ── Deterministic value-noise mottle (pure — no Math.random/Date) so the baked grain is replay-stable.
function hash01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b1) ^ (seed | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t: number): number { return t * t * (3 - 2 * t); }
function valueNoise(fx: number, fy: number, seed: number): number {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smooth(fx - x0), ty = smooth(fy - y0);
  const a = hash01(x0, y0, seed), b = hash01(x0 + 1, y0, seed);
  const c = hash01(x0, y0 + 1, seed), d = hash01(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}
function fbm(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 3; o++) { sum += amp * valueNoise(x * freq, y * freq, seed + o * 131); amp *= 0.5; freq *= 2; }
  return sum; // ~[0,1)
}

const TEX_N = 64;          // small albedo tile
const MOTTLE = 0.18;       // albedo modulation depth (subtle, ≈ procedural-pbr default grain)
const NOISE_TILES = 3;     // fbm cycles across the tile

/** Bake a small SRGB albedo DataTexture: base sRGB colour × deterministic mottle. material.color is
 *  left WHITE, so the FULL albedo lives in this texture — round-trip carries the exact surface, and the
 *  colourspace tag (SRGBColorSpace) is what keeps the re-import from darkening. */
function bakeAlbedo(hex: number, seed: number): STD.DataTexture {
  const r0 = (hex >> 16) & 0xff, g0 = (hex >> 8) & 0xff, b0 = hex & 0xff;
  const data = new Uint8Array(TEX_N * TEX_N * 4);
  for (let j = 0; j < TEX_N; j++) {
    for (let i = 0; i < TEX_N; i++) {
      const n = fbm((i / TEX_N) * NOISE_TILES, (j / TEX_N) * NOISE_TILES, seed);
      const mod = 1 + (n - 0.5) * MOTTLE; // ≈ [1-M/2, 1+M/2], matches applyProceduralPbr's albedo mod
      const o = (j * TEX_N + i) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(r0 * mod)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(g0 * mod)));
      data[o + 2] = Math.max(0, Math.min(255, Math.round(b0 * mod)));
      data[o + 3] = 255;
    }
  }
  const tex = new STD.DataTexture(data, TEX_N, TEX_N, STD.RGBAFormat, STD.UnsignedByteType);
  tex.wrapS = STD.RepeatWrapping;
  tex.wrapT = STD.RepeatWrapping;
  tex.colorSpace = STD.SRGBColorSpace; // ← THE gotcha: albedo baked to a texture MUST be sRGB-tagged.
  tex.needsUpdate = true;
  return tex;
}

// Cache converted materials by (colour,roughness,metalness) so identical parts share one texture.
const matCache = new Map<string, STD.MeshStandardMaterial>();
let matSeq = 0;
function convertMaterial(m: ENG.MeshStandardNodeMaterial): STD.MeshStandardMaterial {
  const col = m.color as unknown as { getHex(cs?: unknown): number };
  const hex = col.getHex(STD.SRGBColorSpace); // read base colour back in sRGB
  const rough = typeof m.roughness === "number" ? m.roughness : 0.8;
  const metal = typeof m.metalness === "number" ? m.metalness : 0;
  const key = `${hex}_${rough}_${metal}`;
  const cached = matCache.get(key);
  if (cached !== undefined) return cached;
  const std = new STD.MeshStandardMaterial({
    color: 0xffffff,              // white → full albedo comes from the SRGB texture (no double-tint)
    roughness: rough,
    metalness: metal,
    map: bakeAlbedo(hex, 0x1000 + matSeq++),
  });
  matCache.set(key, std);
  return std;
}

/** Copy an engine BufferGeometry into a node_modules-THREE geometry (position+normal+index), and
 *  synthesize planar UVs from LOCAL position so the tiling albedo has coordinates on EVERY part
 *  (the merged wall-panel geometry ships no UVs of its own). */
const UV_FREQ = 0.9; // cycles per metre for the grain
function convertGeometry(geo: ENG.BufferGeometry): STD.BufferGeometry {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const g = new STD.BufferGeometry();
  const posArr = new Float32Array(pos.array as ArrayLike<number>);
  g.setAttribute("position", new STD.BufferAttribute(posArr, 3));
  if (nrm !== undefined) g.setAttribute("normal", new STD.BufferAttribute(new Float32Array(nrm.array as ArrayLike<number>), 3));
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = posArr[i * 3] * UV_FREQ; uv[i * 2 + 1] = posArr[i * 3 + 1] * UV_FREQ; }
  g.setAttribute("uv", new STD.BufferAttribute(uv, 2));
  const idx = geo.getIndex();
  if (idx !== null && idx !== undefined) g.setIndex(new STD.BufferAttribute(new Uint32Array(idx.array as ArrayLike<number>), 1));
  for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex ?? 0);
  return g;
}

async function main(): Promise<void> {
  // A lightweight WorldContext (mirrors kit_building_entry) with stub physics — we only compose geometry.
  const scene = new ENG.Scene();
  let bid = 0;
  const ops = {
    op_physics_create_world: () => {},
    op_physics_add_static_box: () => bid++,
    op_physics_remove_body: () => {},
  } as unknown as WorldContext["ops"];
  const ecs = createEcsWorld();
  const world = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as unknown as WorldContext["scene"],
    camera: {} as WorldContext["camera"], ops, mode: "headless",
  } as WorldContext;

  assembleBuilding(COTTAGE, [0, 0, 0], world, { dd: DEFAULT_DESIGN_DIRECTION, seed: 3 });
  renderSyncSystem(ecs);

  // Walk the scene, collect part meshes, and rebuild each as a node_modules-THREE mesh in a single Group.
  const group = new STD.Group();
  const srcBounds = new ENG.Box3();
  const tmp = new ENG.Box3();
  let meshCount = 0, texturedMats = 0;
  scene.updateMatrixWorld(true);
  scene.traverse((o: ENG.Object3D) => {
    const mesh = o as ENG.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    tmp.setFromObject(mesh, true);
    srcBounds.union(tmp);

    const g = convertGeometry(mesh.geometry as ENG.BufferGeometry);
    const srcMat = mesh.material;
    let outMat: STD.MeshStandardMaterial | STD.MeshStandardMaterial[];
    if (Array.isArray(srcMat)) { outMat = srcMat.map((mm) => convertMaterial(mm as ENG.MeshStandardNodeMaterial)); texturedMats += outMat.length; }
    else { outMat = convertMaterial(srcMat as ENG.MeshStandardNodeMaterial); texturedMats += 1; }

    const stdMesh = new STD.Mesh(g, outMat);
    // Bake the engine mesh's WORLD transform into the exported node's TRS.
    const mw = new STD.Matrix4().fromArray((mesh.matrixWorld as unknown as { elements: number[] }).elements);
    mw.decompose(stdMesh.position, stdMesh.quaternion, stdMesh.scale);
    group.add(stdMesh);
  });

  if (meshCount === 0) throw new Error("no part meshes collected from the assembled building");

  const size = new ENG.Vector3(); srcBounds.getSize(size);
  window.__bounds = {
    min: [srcBounds.min.x, srcBounds.min.y, srcBounds.min.z].map((v) => +v.toFixed(4)),
    max: [srcBounds.max.x, srcBounds.max.y, srcBounds.max.z].map((v) => +v.toFixed(4)),
    size: [size.x, size.y, size.z].map((v) => +v.toFixed(4)),
  };

  const exporter = new GLTFExporter();
  const buf = await new Promise<ArrayBuffer>((res, rej) =>
    exporter.parse(group, (r: ArrayBuffer) => res(r), (e: unknown) => rej(e), { binary: true, onlyVisible: true }));
  const bytes = new Uint8Array(buf);
  let bin = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  window.__glb = btoa(bin);
  log(`exported cottage GLB: ${bytes.length} bytes, ${meshCount} part meshes, ${matCache.size} unique SRGB-albedo materials (${texturedMats} slots), bounds size=${JSON.stringify(window.__bounds.size)}`);
  window.__done = true;
}

main().catch((e) => { window.__err = "THROW: " + String((e && (e.stack || e.message)) || e); window.__done = true; });
