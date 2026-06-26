// Phase 9.1 / workstream B (headless) — proves prop GEOMETRY and the per-instance
// RENDER TRANSFORMS as PURE/CPU data. No GPU: the in-tab WebGPU draw of trees/rocks/
// grass is UAT, but the geometry MATH (finite, expected counts, unit normals,
// deterministic) and — crucially — that the InstancedMesh matrices REPRODUCE the
// scatter (each instance translate==(x,y,z), uniform scale==scale, Y-rotation==yaw)
// are fully provable here. THREE runs headlessly; the matrices are CPU data.

import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { PropKind, scatterProps, type PropInstance } from "../src/terrain/scatter.ts";
import { propGeometry } from "../src/terrain/props.ts";
import { buildPropInstancedMesh, buildTilePropMeshes } from "../src/terrain/props-render.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_props FAIL: " + msg);
}
const close = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;
/** 0xRRGGBB -> normalized [r,g,b] (mirrors props.ts hexRGB, for the color check). */
const hexRGB = (hex: number): [number, number, number] => [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];

// Per-part colors the geometry must carry (from props.ts).
const TRUNK = 0x5b4636, FOLIAGE = 0x2f6d39, ROCKCOL = 0x6f6f6a, GRASSCOL = 0x4f8a3f;

// ---------------------------------------------------------------------------
// 1. GEOMETRY: each kind is finite, has the expected vertex/triangle counts,
//    unit-length normals, OUTWARD normals, per-part vertex colors, and is
//    deterministic (byte-identical on re-call).
const EXPECT: Record<number, {
  verts: number; tris: number; label: string;
  /** Expected per-part color (hex) for vertex v. */
  color: (v: number) => number;
}> = {
  // tree: trunk = 4 open-tube side quads (8 tris, verts 0..23, brown); then 3 open
  // hex-cone tiers (6 tris each = 18 tris, verts 24..77, green).
  [PropKind.Tree]: { verts: 78, tris: 26, label: "tree (open trunk tube 8 + 3 hex cone tiers 18)", color: (v) => (v < 24 ? TRUNK : FOLIAGE) },
  [PropKind.Rock]: { verts: 24, tris: 8, label: "rock (flattened octahedron)", color: () => ROCKCOL },
  [PropKind.Grass]: { verts: 24, tris: 8, label: "grass (4 tapered blades)", color: () => GRASSCOL },
};

for (const kind of [PropKind.Tree, PropKind.Rock, PropKind.Grass]) {
  const e = EXPECT[kind];
  const g = propGeometry(kind);

  // Counts: positions/normals/colors = verts*3; indices = tris*3 (flat, sequential).
  assert(g.positions.length === e.verts * 3, `${e.label}: positions ${g.positions.length} != ${e.verts * 3}`);
  assert(g.normals.length === e.verts * 3, `${e.label}: normals ${g.normals.length} != ${e.verts * 3}`);
  assert(g.colors.length === e.verts * 3, `${e.label}: colors ${g.colors.length} != ${e.verts * 3}`);
  assert(g.indices.length === e.tris * 3, `${e.label}: indices ${g.indices.length} != ${e.tris * 3}`);

  // Indices are the trivial 0..verts-1 sequence and in range.
  for (let i = 0; i < g.indices.length; i++) {
    assert(g.indices[i] === i, `${e.label}: index[${i}]=${g.indices[i]} expected ${i}`);
  }

  // All positions finite.
  for (let i = 0; i < g.positions.length; i++) {
    assert(Number.isFinite(g.positions[i]), `${e.label}: non-finite position at ${i}`);
  }

  // Every normal is unit-length (flat face normals) and finite.
  for (let v = 0; v < e.verts; v++) {
    const nx = g.normals[v * 3], ny = g.normals[v * 3 + 1], nz = g.normals[v * 3 + 2];
    assert(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `${e.label}: non-finite normal v=${v}`);
    assert(close(Math.hypot(nx, ny, nz), 1, 1e-5), `${e.label}: normal v=${v} not unit (|n|=${Math.hypot(nx, ny, nz)})`);
  }

  // OUTWARD NORMALS (no inward-winding -> no black faces under single-sided FrontSide):
  // these props are axis-symmetric about +Y with no horizontal cap faces, so for every
  // FACE the normal must point AWAY from the central vertical axis:
  //   n · (faceCentroid − (0, faceCentroidY, 0)) = n.x*cx + n.z*cz > 0.
  const tris = e.tris;
  for (let f = 0; f < tris; f++) {
    const a = f * 9; // 3 verts * 3 comps
    const cx = (g.positions[a] + g.positions[a + 3] + g.positions[a + 6]) / 3;
    const cz = (g.positions[a + 2] + g.positions[a + 5] + g.positions[a + 8]) / 3;
    const nx = g.normals[a], nz = g.normals[a + 2]; // flat: all 3 verts share the face normal
    const radial = nx * cx + nz * cz;
    assert(radial > 1e-4, `${e.label}: face ${f} normal not outward (n·radial=${radial.toFixed(5)}; centroidXZ=(${cx.toFixed(3)},${cz.toFixed(3)}) n.xz=(${nx.toFixed(3)},${nz.toFixed(3)}))`);
  }

  // PER-PART VERTEX COLORS: every vertex carries its part's expected color.
  for (let v = 0; v < e.verts; v++) {
    const [er, eg, eb] = hexRGB(e.color(v));
    assert(close(g.colors[v * 3], er) && close(g.colors[v * 3 + 1], eg) && close(g.colors[v * 3 + 2], eb),
      `${e.label}: color v=${v} (${g.colors[v * 3]},${g.colors[v * 3 + 1]},${g.colors[v * 3 + 2]}) != expected #${e.color(v).toString(16)}`);
  }

  // Determinism: a second call is byte-identical.
  const g2 = propGeometry(kind);
  for (let i = 0; i < g.positions.length; i++) assert(Object.is(g.positions[i], g2.positions[i]), `${e.label}: positions non-deterministic at ${i}`);
  for (let i = 0; i < g.normals.length; i++) assert(Object.is(g.normals[i], g2.normals[i]), `${e.label}: normals non-deterministic at ${i}`);
  for (let i = 0; i < g.colors.length; i++) assert(Object.is(g.colors[i], g2.colors[i]), `${e.label}: colors non-deterministic at ${i}`);
  for (let i = 0; i < g.indices.length; i++) assert(Object.is(g.indices[i], g2.indices[i]), `${e.label}: indices non-deterministic at ${i}`);
}

// Tree really is multi-colored (brown trunk + green canopy), not monochrome.
{
  const tg = propGeometry(PropKind.Tree);
  const [tr] = hexRGB(TRUNK), [fr] = hexRGB(FOLIAGE);
  assert(close(tg.colors[0], tr) && close(tg.colors[24 * 3], fr), "tree should be brown trunk + green canopy, not one flat color");
}

// ---------------------------------------------------------------------------
// 2. RENDER MATCHES SCATTER: build the InstancedMesh for a REAL scatter result and
//    decompose each instance matrix -> translation == (x,y,z), uniform scale ==
//    prop.scale, and the rotation is PURELY about +Y by prop.yaw.
const src = new ProceduralTerrainSource();
const SEED = 7;
const tile = src.generateTile({ seed: SEED, tx: 2, tz: -1, lod: 0 });
// A steep synthetic tile so the scatter also emits ROCKS — exercise all three kinds.
const N = 33;
const steepH = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let col = 0; col < N; col++) steepH[r * N + col] = col * 0.2;
const steepTile = { nrows: N, ncols: N, origin: [120, 0, 60] as [number, number, number], scale: [48, 12, 48] as [number, number, number], heights: steepH };
const props = [...scatterProps(tile, SEED), ...scatterProps(steepTile, SEED)];
assert(props.length > 0, "expected a non-empty scatter to verify");
assert(props.some((p) => p.kind === PropKind.Rock), "expected the steep tile to contribute rocks");

// Group by kind so each InstancedMesh's instance i corresponds to list[i].
const byKind = new Map<number, PropInstance[]>();
for (const p of props) {
  let list = byKind.get(p.kind);
  if (list === undefined) { list = []; byKind.set(p.kind, list); }
  list.push(p);
}

const m = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const vx = new THREE.Vector3();
const vy = new THREE.Vector3();
let verified = 0;
const kindsSeen: number[] = [];

for (const [kind, list] of byKind) {
  const mesh = buildPropInstancedMesh(kind, list);
  assert(mesh !== null, `buildPropInstancedMesh returned null for kind ${kind} with ${list.length} instances`);
  assert(mesh.count === list.length, `InstancedMesh.count ${mesh.count} != ${list.length}`);
  kindsSeen.push(kind);

  // Material drives per-part color from the vertex-color attribute (not a flat color),
  // and the geometry actually carries that attribute. Grass is double-sided (thin
  // blades) — that, not winding, is what keeps grass from going black from one side.
  const mat = mesh.material as { vertexColors?: boolean; side?: number };
  assert(mat.vertexColors === true, `kind ${kind} material must use vertexColors`);
  assert((mesh.geometry as THREE.BufferGeometry).getAttribute("color") !== undefined, `kind ${kind} geometry missing color attribute`);
  if (kind === PropKind.Grass) assert(mat.side === THREE.DoubleSide, "grass material must be DoubleSide");

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    mesh.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);

    // Translation == (x, y, z).
    assert(close(pos.x, p.x) && close(pos.y, p.y) && close(pos.z, p.z),
      `kind ${kind} instance ${i} translation (${pos.x},${pos.y},${pos.z}) != (${p.x},${p.y},${p.z})`);

    // Uniform scale == prop.scale (all three axes equal and equal to scale).
    assert(close(scl.x, p.scale) && close(scl.y, p.scale) && close(scl.z, p.scale),
      `kind ${kind} instance ${i} scale (${scl.x},${scl.y},${scl.z}) != uniform ${p.scale}`);

    // Rotation is PURELY about +Y by prop.yaw: rotating +X by the matrix's quaternion
    // gives (cos yaw, 0, -sin yaw); rotating +Y leaves it unchanged (no X/Z tilt).
    vx.set(1, 0, 0).applyQuaternion(quat);
    assert(close(vx.x, Math.cos(p.yaw)) && close(vx.y, 0, 1e-5) && close(vx.z, -Math.sin(p.yaw)),
      `kind ${kind} instance ${i} yaw mismatch: +X->(${vx.x},${vx.y},${vx.z}) expected (${Math.cos(p.yaw)},0,${-Math.sin(p.yaw)}) for yaw=${p.yaw}`);
    vy.set(0, 1, 0).applyQuaternion(quat);
    assert(close(vy.x, 0, 1e-5) && close(vy.y, 1, 1e-5) && close(vy.z, 0, 1e-5),
      `kind ${kind} instance ${i} rotation not pure-Y: +Y->(${vy.x},${vy.y},${vy.z})`);

    verified++;
  }
}

// 3. buildTilePropMeshes groups the SAME tile into one InstancedMesh per present kind,
//    covering every instance exactly once.
const tileMeshes = buildTilePropMeshes(props);
assert(tileMeshes.length === byKind.size, `buildTilePropMeshes produced ${tileMeshes.length} meshes, expected ${byKind.size} kinds`);
let totalInstances = 0;
for (const tm of tileMeshes) totalInstances += tm.count;
assert(totalInstances === props.length, `tile prop meshes cover ${totalInstances} instances, expected ${props.length}`);

ops.op_log(
  `p9_props OK: geometry tree=78v/26t rock=24v/8t grass=24v/8t (finite, unit + OUTWARD normals, ` +
  `per-part vertex colors brown-trunk/green-canopy/grey-rock/green-grass, deterministic); ` +
  `materials vertexColors + grass DoubleSide; render matches scatter — ${verified} instances across ` +
  `kinds [${kindsSeen.sort().join(",")}] decompose to translate==(x,y,z), uniform scale==prop.scale, ` +
  `pure +Y rotation==prop.yaw; buildTilePropMeshes -> ${tileMeshes.length} meshes / ${totalInstances} instances.`,
);
