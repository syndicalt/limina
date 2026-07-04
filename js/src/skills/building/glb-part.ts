// GLB-BACKED KIT PART — the proof that the building-kit's `KitPart` contract is SOURCE-AGNOSTIC.
//
// kit.ts's `KitPart = (spec, ctx) => { mesh, colliderHalf }` is deliberately just "a function to a
// mesh + collider": a PROCEDURAL generator satisfies it (wallPanel/boxPart), and — proven here — an
// authored GLB satisfies the SAME signature. `glbPart(bytes)` wraps GLB bytes as a KitPart that drops
// into a structural slot exactly like a procedural part, so the assembler (building-recipe.ts) never
// learns where a part's geometry came from. This is limina's asset-priority rule expressed as a type
// (tailored skill > PROJECT ASSET > build-from-geometry): the GLB tier plugs in without the assembler
// changing.
//
// WHERE THE BYTES COME FROM: the caller (the assembler) supplies `bytes`; it obtains them through the
// content-addressed asset layer — `AssetRegistry.resolve(assetId)` (js/src/asset-registry.ts:130),
// which returns `{ bytes, hash }` from the host asset root (or a package bundle on replay). That is the
// SAME resolver `asset.place` uses (js/src/skills/asset.ts), so a GLB part rides the identical
// record/replay + content-pinning spine. glbPart itself performs NO resolve/fetch and owns no world
// state — it is pure given its bytes.
//
// MESH INSTANTIATION IS NATIVE-BUT-ASYNC. The mesh is built with the engine's OWN glTF path
// (`parseGltfScene`, js/src/skills/three.ts) — the same GLTFLoader + WebGPU texture-rehome asset.place
// uses. That path runs headlessly in the native deno host (verified: p11 + p87 parse a textured glTF
// on `./target/release/limina`), but GLTFLoader.parse resolves on a later microtask, so it cannot be
// produced inside the SYNCHRONOUS KitPart call on a cold cache. glbPart therefore PRE-PARSES eagerly
// (mirroring three.ts's `prewarmGltfScene`, which exists for exactly this "parse before you need it
// synchronously" reason) and exposes readiness via `glbPartReady(part)`. The assembler awaits that
// once — right after it resolves the bytes — then makePart stays synchronous and replay-safe.
//
// DETERMINISM: pure function of the bytes. The fitted geometry (a deterministic merge of the parsed
// meshes, scaled to contain the slot and centred on the origin) and the collider (gltfLocalAabb scaled
// by the same factor) are byte-identical for identical bytes across calls — no Math.random, no Date.

import * as THREE from "../../../build/three.bundle.mjs";
import type { KitPart, KitPartSpec, PartContext, PartOutput } from "./kit.ts";
import type { V3 } from "../architecture.ts";
import type { SceneObject } from "../../engine.ts";
import { gltfLocalAabb } from "../../assets/gltf-bounds.ts";
import { parseGltfScene } from "../three.ts";
import { assetContentHash } from "../../asset-registry.ts";

/** A collider half-extent smaller than this is treated as this — a physical part needs a non-degenerate
 *  box even when its source geometry is flat on an axis (e.g. a billboard/plane), so `colliderHalf`
 *  stays strictly positive + finite (mirrors asset.place's own hx/hy/hz > 1e-4 guard). */
const MIN_HALF = 1e-3;

/** Readiness of each `glbPart` — the pre-parse promise that must settle before the returned KitPart is
 *  invoked. Keyed by the part function itself so the KitPart stays exactly `KitPart` (no extra props on
 *  the public signature). See `glbPartReady`. */
const READY = new WeakMap<KitPart, Promise<void>>();

/** Await a `glbPart`'s one-time GLB parse. The assembler calls this right after it resolves the bytes
 *  (the same place it would await any async asset prep); once it settles, the KitPart is a synchronous,
 *  deterministic generator like any procedural part. Resolves immediately for a non-glbPart (no entry). */
export function glbPartReady(part: KitPart): Promise<void> {
  return READY.get(part) ?? Promise.resolve();
}

/** Merge every mesh of a parsed glTF root into ONE origin-centred `THREE.Mesh`, baking `fit` (the
 *  centre-to-origin + uniform scale transform) into the geometry — the same shape a procedural part
 *  returns (authored centred on the origin; the assembler positions/rotates it). Preserves the GLB's
 *  authored materials (a material array + per-mesh groups) and its UVs (when every mesh carries them),
 *  so a textured authored part keeps its look. Deterministic: same root + fit ⇒ identical buffers. */
function mergeFittedGlb(root: SceneObject, fit: THREE.Matrix4): THREE.Mesh {
  const r3 = root as unknown as THREE.Object3D;
  r3.updateMatrixWorld(true);

  interface Piece { geo: THREE.BufferGeometry; mat: THREE.Material }
  const pieces: Piece[] = [];
  const combined = new THREE.Matrix4();
  r3.traverse((o: unknown) => {
    const mesh = o as unknown as { isMesh?: boolean; geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[]; matrixWorld: THREE.Matrix4 };
    if (mesh.isMesh !== true || mesh.geometry === undefined) return;
    // Non-indexed so the merge is a plain concatenation (no index rebasing); bake node world matrix +
    // the fit into the geometry (applyMatrix4 transforms positions AND normals via the normal matrix).
    const src = mesh.geometry;
    const g = src.index !== null ? src.toNonIndexed() : src.clone();
    combined.multiplyMatrices(fit, mesh.matrixWorld);
    g.applyMatrix4(combined);
    if (g.getAttribute("normal") === undefined) g.computeVertexNormals();
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    pieces.push({ geo: g, mat: mat as THREE.Material });
  });
  if (pieces.length === 0) throw new Error("glbPart: parsed glTF has no meshes to fit");

  const hasUv = pieces.every((p) => p.geo.getAttribute("uv") !== undefined);
  let total = 0;
  for (const p of pieces) total += p.geo.getAttribute("position").count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = hasUv ? new Float32Array(total * 2) : null;

  const materials: THREE.Material[] = [];
  const matIndex = new Map<THREE.Material, number>();
  const raw: { start: number; count: number; mat: number }[] = [];
  let vstart = 0;
  for (const p of pieces) {
    const pos = p.geo.getAttribute("position");
    positions.set(pos.array as ArrayLike<number>, vstart * 3);
    normals.set(p.geo.getAttribute("normal").array as ArrayLike<number>, vstart * 3);
    if (uvs !== null) uvs.set(p.geo.getAttribute("uv").array as ArrayLike<number>, vstart * 2);
    let mi = matIndex.get(p.mat);
    if (mi === undefined) { mi = materials.length; materials.push(p.mat); matIndex.set(p.mat, mi); }
    raw.push({ start: vstart, count: pos.count, mat: mi });
    vstart += pos.count;
    p.geo.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (uvs !== null) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  // Coalesce consecutive same-material runs into single groups (cheap draw).
  for (const g of raw) {
    const last = geometry.groups[geometry.groups.length - 1];
    if (last !== undefined && last.materialIndex === g.mat && last.start + last.count === g.start) {
      last.count += g.count;
    } else {
      geometry.addGroup(g.start, g.count, g.mat);
    }
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
  // Placed authored geometry casts + receives shadows (matches loadGltfIntoScene / asset.place).
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Wrap GLB/glTF `bytes` as a source-agnostic `KitPart`. The returned generator:
 *   - builds its mesh from `bytes` via the engine's shared glTF path (`parseGltfScene`) — no
 *     hand-rolled parser;
 *   - (fit, default true) UNIFORMLY scales the asset to CONTAIN `spec.size` and centres it on the
 *     origin, so it drops into a structural slot like a procedural part WITHOUT distorting the authored
 *     proportions (a contain-fit; pass `{ fit: false }` to keep the asset's native metric scale);
 *   - returns `colliderHalf` derived from the byte-measured AABB (`gltfLocalAabb`) scaled by the same
 *     fit factor — strictly positive + finite, and within the slot.
 * `spec.role`/`spec.params`/`ctx` are unused: an authored GLB carries its own geometry + materials
 * (that is the whole point of the GLB tier), which is why a GLB part satisfies the identical signature.
 *
 * Usage — a GLB overrides a slot in the kit's part registry, no assembler change:
 *   const bytes = assets.resolve("window-lattice.glb").bytes; // AssetRegistry.resolve
 *   const part = glbPart(bytes);
 *   await glbPartReady(part);           // one-time pre-parse (async GLTFLoader → sync thereafter)
 *   parts["window-unit"] = part;        // now callable as a synchronous KitPart
 */
export function glbPart(bytes: Uint8Array, opts?: { fit?: boolean }): KitPart {
  const fitEnabled = opts?.fit ?? true;
  // Content-addressed cache key so repeat glbPart(sameBytes) shares parseGltfScene's parsed template
  // (gltfRootCache), and so the key is a stable function of the bytes (deterministic, no clock).
  const assetId = `glb-part:${assetContentHash(bytes)}.glb`;

  // Byte-measured LOCAL AABB (pure) — the collider + fit basis, identical to what asset.place colliders
  // off. Computed once up front so a malformed asset fails at construction, not mid-assembly.
  const local = gltfLocalAabb(bytes);
  if (local === null) throw new Error("glbPart: glTF bytes carry no positioned geometry (no collider/fit basis)");
  const ext: V3 = [local.max[0] - local.min[0], local.max[1] - local.min[1], local.max[2] - local.min[2]];
  const center: V3 = [(local.min[0] + local.max[0]) / 2, (local.min[1] + local.max[1]) / 2, (local.min[2] + local.max[2]) / 2];

  // Eager, one-time parse via the engine's shared glTF pipeline. Stored in the closure so the KitPart
  // clones/merges it synchronously; readiness is exposed via glbPartReady (see the file header).
  let template: SceneObject | undefined;
  const ready = parseGltfScene(assetId, bytes).then((root) => { template = root; });

  const part: KitPart = (spec: KitPartSpec, _ctx: PartContext): PartOutput => {
    if (template === undefined) {
      throw new Error("glbPart: bytes not parsed yet — `await glbPartReady(part)` before invoking (see js/src/skills/building/glb-part.ts)");
    }
    // Uniform CONTAIN fit: the largest scale that keeps every axis within the slot (preserves the
    // authored aspect ratio — an authored asset must not be squashed to fill a slot exactly).
    let s = 1;
    if (fitEnabled) {
      const fx = ext[0] > 1e-9 ? spec.size[0] / ext[0] : Infinity;
      const fy = ext[1] > 1e-9 ? spec.size[1] / ext[1] : Infinity;
      const fz = ext[2] > 1e-9 ? spec.size[2] / ext[2] : Infinity;
      s = Math.min(fx, fy, fz);
      if (!Number.isFinite(s) || s <= 0) s = 1;
    }
    // fit(p) = s * (p - center): centre the asset on the origin, then scale to fit.
    const fit = new THREE.Matrix4()
      .makeScale(s, s, s)
      .multiply(new THREE.Matrix4().makeTranslation(-center[0], -center[1], -center[2]));

    const mesh = mergeFittedGlb(template, fit);
    // Collider from the byte-measured AABB scaled by the SAME factor, clamped strictly positive.
    const colliderHalf: V3 = [
      Math.max((ext[0] * s) / 2, MIN_HALF),
      Math.max((ext[1] * s) / 2, MIN_HALF),
      Math.max((ext[2] * s) / 2, MIN_HALF),
    ];
    return { mesh, colliderHalf };
  };

  READY.set(part, ready);
  return part;
}
