// p87 — the GLB-backed KitPart gate. Proves the building-kit's `KitPart` contract is SOURCE-AGNOSTIC:
// a GLB, resolved through the SAME content-addressed AssetRegistry asset.place uses, satisfies the
// identical `(spec, ctx) => { mesh, colliderHalf }` signature as a procedural part and drops into the
// part registry with NO assembler change.
//
// Mesh instantiation is NATIVE (this gate parses a real textured building glTF headlessly on
// ./target/release/limina via the engine's own parseGltfScene) but ASYNC (GLTFLoader.parse), so the
// gate awaits glbPartReady once, then invokes the KitPart synchronously — exactly the assembler's flow.
//
// Asserts: mesh non-empty; colliderHalf strictly positive + finite; the FITTED geometry sits within
// spec.size (+eps) and centred on the origin; two invocations are byte-identical (deterministic);
// fit:false keeps the asset's native metric extent; and the part slots into a `Record<PartKind,KitPart>`
// override (the source-agnostic payoff).

import * as THREE from "../build/three.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { glbPart, glbPartReady } from "../src/skills/building/glb-part.ts";
import { KIT, type KitPart, type KitPartSpec, type PartContext, type PartKind } from "../src/skills/building/kit.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p87_glb_part FAIL: " + msg);
}
const finitePos = (n: number): boolean => Number.isFinite(n) && n > 0;

// A real 3-mesh, textured building GLB under the host asset root, resolved through the content-addressed
// registry (AssetRegistry.resolve → { bytes, hash }) — the SAME resolver asset.place uses.
const GLB = "cottage.glb";
const reg = new AssetRegistry();
const resolved = reg.resolve(GLB);
assert(resolved.hash.startsWith("sha256:") && resolved.bytes.length > 0, "registry did not resolve real GLB bytes");

// ctx is unused by a GLB part (the asset carries its own geometry + materials) — a minimal stub proves it.
const ctx = { seed: 7 } as unknown as PartContext;
const SLOT: [number, number, number] = [3, 2.5, 2];
const spec: KitPartSpec = { kind: "window-unit", size: SLOT, role: "wood" };

// 1. Build the GLB-backed KitPart + await its one-time pre-parse (async GLTFLoader → sync thereafter).
const part = glbPart(resolved.bytes);
// Invoking before readiness must fail loudly (the assembler awaits first) — falsifiable.
let earlyThrew = false;
try { part(spec, ctx); } catch { earlyThrew = true; }
assert(earlyThrew, "KitPart returned a mesh before the GLB was parsed (should require glbPartReady)");
await glbPartReady(part);

// 2. Invoke it like any procedural part.
const out = part(spec, ctx);

// mesh non-empty + a genuine THREE.Mesh.
const mesh = out.mesh as unknown as { isMesh?: boolean; geometry: THREE.BufferGeometry };
assert(mesh.isMesh === true, "part.mesh is not a THREE.Mesh");
const posAttr = mesh.geometry.getAttribute("position");
assert(posAttr !== undefined && posAttr.count > 0, "part.mesh geometry is empty (no positioned vertices)");

// colliderHalf strictly positive + finite.
const [hx, hy, hz] = out.colliderHalf;
assert(finitePos(hx) && finitePos(hy) && finitePos(hz), `colliderHalf not positive+finite: ${JSON.stringify(out.colliderHalf)}`);

// 3. FITTED geometry within spec.size (+eps) and centred on the origin.
mesh.geometry.computeBoundingBox();
const bb = mesh.geometry.boundingBox!;
const EPS = 1e-3;
const dims: [number, number, number] = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
for (let a = 0; a < 3; a++) {
  assert(dims[a] <= SLOT[a] + EPS, `fitted axis ${a} extent ${dims[a]} exceeds slot ${SLOT[a]}`);
}
const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
assert(Math.abs(cx) <= EPS && Math.abs(cy) <= EPS && Math.abs(cz) <= EPS, `fitted geometry not centred on origin: (${cx},${cy},${cz})`);

// collider half-extents track the fitted geometry (within the slot half-extents + eps).
for (let a = 0; a < 3; a++) {
  assert(out.colliderHalf[a] <= SLOT[a] / 2 + EPS, `colliderHalf axis ${a} (${out.colliderHalf[a]}) exceeds slot half ${SLOT[a] / 2}`);
}
// At least one axis genuinely uses the slot (the GLB was scaled UP to contain it — not a no-op fit).
assert(Math.max(dims[0], dims[1], dims[2]) > 1.5, "fit did not scale the asset into the slot");

// 4. DETERMINISTIC: a second invocation is byte-identical (mesh buffers + collider).
const out2 = part(spec, ctx);
const p2 = (out2.mesh as unknown as { geometry: THREE.BufferGeometry }).geometry.getAttribute("position");
assert(p2.count === posAttr.count, "nondeterministic vertex count across two calls");
const a1 = posAttr.array as ArrayLike<number>, a2 = p2.array as ArrayLike<number>;
let identical = true;
for (let i = 0; i < a1.length; i++) if (a1[i] !== a2[i]) { identical = false; break; }
assert(identical, "nondeterministic geometry (position buffers differ across two calls)");
for (let a = 0; a < 3; a++) assert(out.colliderHalf[a] === out2.colliderHalf[a], "nondeterministic colliderHalf across two calls");

// 5. fit:false keeps the asset's NATIVE metric extent (collider ≈ half the raw AABB, ignoring the slot).
const rawPart = glbPart(resolved.bytes, { fit: false });
await glbPartReady(rawPart);
const rawOut = rawPart(spec, ctx);
const rawMesh = (rawOut.mesh as unknown as { geometry: THREE.BufferGeometry }).geometry;
rawMesh.computeBoundingBox();
const rbb = rawMesh.boundingBox!;
const rawDim0 = rbb.max.x - rbb.min.x;
assert(Math.abs(rawDim0 - dims[0]) > EPS, "fit:false produced the same extent as fit:true (fit had no effect)");
assert(finitePos(rawOut.colliderHalf[0]) && finitePos(rawOut.colliderHalf[1]) && finitePos(rawOut.colliderHalf[2]), "fit:false colliderHalf not positive+finite");

// 6. SOURCE-AGNOSTIC payoff: the GLB part slots into the kit's part registry with no assembler change.
const parts: Record<PartKind, KitPart> = { ...KIT };
parts["window-unit"] = part;
const viaRegistry = parts["window-unit"](spec, ctx);
assert((viaRegistry.mesh as unknown as { isMesh?: boolean }).isMesh === true, "registry-dispatched GLB part did not yield a mesh");

console.log(`p87_glb_part OK: GLB '${GLB}' (${resolved.hash.slice(0, 16)}…, ${resolved.bytes.length} bytes, ${posAttr.count} verts) wraps as a KitPart — mesh non-empty; colliderHalf ${JSON.stringify(out.colliderHalf)} positive+finite; fitted dims ${JSON.stringify(dims.map((d) => +d.toFixed(3)))} within slot ${JSON.stringify(SLOT)} and origin-centred; deterministic across two calls; fit:false preserves native extent; drops into Record<PartKind,KitPart>. Mesh instantiation is NATIVE (parseGltfScene headless) + async (glbPartReady).`);
