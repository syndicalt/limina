import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED = "ad27fdba15b46d8382a34cafec80c5dec75804abec24e064943668096fc07c7f";
const MAGIC = 0x46546c67,
  JSON_CHUNK = 0x4e4f534a,
  BIN_CHUNK = 0x004e4942;
const roleByMaterialName = new Map([
  ["V4 fieldstone", "fieldstone"],
  ["V4 lime mortar", "lime-mortar"],
  ["V4 worn oak", "worn-oak"],
  ["V4 warm lime plaster", "warm-lime-plaster"],
  ["V4 structural oak", "structural-oak"],
  ["V4 black iron", "black-iron"],
  ["V4 door oak", "door-oak"],
  ["V4 blue slate", "blue-slate"],
  ["V4 chimney brick", "chimney-brick"],
  ["V4 interior lime", "interior-lime"],
  ["V4 leadlight glass", "leadlight-glass"],
  ["V4 hearth soot", "hearth-soot"],
  ["V4 hearth embers", "hearth-embers"],
  ["V4 flame outer", "flame-outer"],
  ["V4 flame inner", "flame-inner"],
]);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const pad4 = (n) => (n + 3) & ~3;

// LOD reduction is semantic and whole-primitive only. Never delete individual
// triangles: doing so opens planar walls and roof shells into triangle soup.
export function includeHallHouseNodeInLod(level, name) {
  if (level === 0) return true;
  if (level === 1)
    return (
      !/^interior\//.test(name) &&
      !/^roof\/(?:course|rafter-tail)-/.test(name) &&
      !/\/came-/.test(name) &&
      !/^door\//.test(name)
    );
  if (level === 2)
    return /^(?:shell\/|crossbay\/(?:floor|side-|front-|gable)|roof\/(?:main-|cross-)|dormer\/(?:front-|gable|cheek-|roof-)|chimney\/|frame\/(?:sill-|eave-|post-)|stoop\/(?:post-|beam|roof)|entry\/(?:threshold|jamb-|head)|window\/.*\/(?:glass|jamb-|rail-|mullion|sill))/.test(
      name,
    );
  throw new Error(`unsupported hall-house LOD ${level}`);
}

function parse(bytes) {
  if (bytes.readUInt32LE(0) !== MAGIC || bytes.readUInt32LE(4) !== 2) throw new Error("input is not GLB 2.0");
  const jl = bytes.readUInt32LE(12),
    bo = 20 + jl;
  return {
    json: JSON.parse(bytes.subarray(20, bo).toString().trimEnd()),
    bin: bytes.subarray(bo + 8, bo + 8 + bytes.readUInt32LE(bo)),
  };
}
function mul(a, b) {
  const o = Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = n.scale ?? [1, 1, 1],
    [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * w * z) * sx,
    (2 * x * z - 2 * w * y) * sx,
    0,
    (2 * x * y - 2 * w * z) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * w * x) * sy,
    0,
    (2 * x * z + 2 * w * y) * sz,
    (2 * y * z - 2 * w * x) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
function point(m, p, w = 1) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
  ];
}
function normalize(p) {
  const l = Math.hypot(...p) || 1;
  return p.map((v) => v / l);
}

export async function batchHallHouse(input, output) {
  const source = await readFile(resolve(input));
  if (hash(source) !== EXPECTED) throw new Error("source authority hash mismatch");
  const { json: g, bin } = parse(source),
    parents = Array(g.nodes.length).fill(-1);
  const roles = g.materials.map((material) => roleByMaterialName.get(material.name));
  if (roles.some((role) => role === undefined) || new Set(roles).size !== g.materials.length)
    throw new Error(
      `unmapped or duplicate hall-house material roles: ${g.materials.map((material) => material.name).join(", ")}`,
    );
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parents[c] = i)));
  const world = g.nodes.map((_, i) => {
    const chain = [];
    for (let p = i; p >= 0; p = parents[p]) chain.push(p);
    return chain
      .reverse()
      .reduce((m, j) => mul(m, local(g.nodes[j])), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
  const doorRoot = g.nodes.findIndex((n) => n.extras?.limina?.id === "door/front"),
    door = new Set();
  (function add(i) {
    door.add(i);
    for (const c of g.nodes[i].children ?? []) add(c);
  })(doorRoot);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function data(ai) {
    const a = g.accessors[ai],
      v = g.bufferViews[a.bufferView],
      off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0),
      n = comps[a.type],
      out = [];
    const size = a.componentType === 5126 ? 4 : a.componentType === 5125 ? 4 : 2;
    for (let i = 0; i < a.count; i++) {
      let q = [];
      for (let j = 0; j < n; j++) {
        const o = off + (i * n + j) * size;
        q.push(
          a.componentType === 5126
            ? bin.readFloatLE(o)
            : a.componentType === 5125
              ? bin.readUInt32LE(o)
              : bin.readUInt16LE(o),
        );
      }
      out.push(n === 1 ? q[0] : q);
    }
    return out;
  }
  const groups = Array.from({ length: g.materials.length }, () => []);
  for (let ni = 0; ni < g.nodes.length; ni++) {
    const n = g.nodes[ni];
    if (n.mesh === undefined || door.has(ni)) continue;
    for (const p of g.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) throw new Error("non-triangle primitive");
      const pos = data(p.attributes.POSITION).map((v) => point(world[ni], v));
      const nor = data(p.attributes.NORMAL).map((v) => normalize(point(world[ni], v, 0)));
      const uv = p.attributes.TEXCOORD_0 === undefined ? pos.map(() => [0, 0]) : data(p.attributes.TEXCOORD_0);
      groups[p.material].push({ ni, name: n.name ?? `node-${ni}`, pos, nor, uv, idx: data(p.indices) });
    }
    delete n.mesh;
  }
  const chunks = [Buffer.from(bin)],
    views = (g.bufferViews ??= []),
    acc = g.accessors ?? [],
    meshes = g.meshes ?? [],
    nodes = g.nodes;
  let byteLength = bin.length;
  function append(buf, target) {
    const start = pad4(byteLength),
      padding = Buffer.alloc(start - byteLength);
    chunks.push(padding, buf);
    byteLength = start + buf.length;
    views.push({ buffer: 0, byteOffset: start, byteLength: buf.length, ...(target ? { target } : {}) });
    return views.length - 1;
  }
  function accessor(values, type, componentType, target, minmax = false) {
    const flat = values.flat(),
      buf = Buffer.alloc(flat.length * (componentType === 5126 || componentType === 5125 ? 4 : 2));
    flat.forEach((v, i) =>
      componentType === 5126
        ? buf.writeFloatLE(v, i * 4)
        : componentType === 5125
          ? buf.writeUInt32LE(v, i * 4)
          : buf.writeUInt16LE(v, i * 2),
    );
    const a = { bufferView: append(buf, target), componentType, count: values.length, type };
    if (minmax) {
      a.min = [0, 1, 2].map((k) => Math.min(...values.map((v) => v[k])));
      a.max = [0, 1, 2].map((k) => Math.max(...values.map((v) => v[k])));
    }
    acc.push(a);
    return acc.length - 1;
  }
  const lodRoots = [];
  function makeLod(level) {
    const root = {
      name: `hall-house/v4/LOD${level}`,
      extras: { liminaLod: { level, orphan: true, strategy: "whole-primitive-semantic-filter" } },
      children: [],
    };
    nodes.push(root);
    const ri = nodes.length - 1;
    lodRoots.push(ri);
    for (let mi = 0; mi < groups.length; mi++) {
      const selected = groups[mi].filter((s) => includeHallHouseNodeInLod(level, s.name));
      if (!selected.length) continue;
      let P = [],
        N = [],
        U = [],
        I = [],
        ranges = [];
      for (const s of selected) {
        const first = I.length,
          base = P.length;
        P.push(...s.pos);
        N.push(...s.nor);
        U.push(...s.uv);
        I.push(...s.idx.map((x) => x + base));
        if (level === 0) {
          const bmin = [0, 1, 2].map((k) => Math.min(...s.pos.map((v) => v[k]))),
            bmax = [0, 1, 2].map((k) => Math.max(...s.pos.map((v) => v[k])));
          ranges.push({ ni: s.ni, firstIndex: first, indexCount: I.length - first, bounds: { min: bmin, max: bmax } });
        }
      }
      const prim = {
        attributes: {
          POSITION: accessor(P, "VEC3", 5126, 34962, true),
          NORMAL: accessor(N, "VEC3", 5126, 34962),
          TEXCOORD_0: accessor(U, "VEC2", 5126, 34962),
        },
        indices: accessor(I, "SCALAR", P.length > 65535 ? 5125 : 5123, 34963),
        material: mi,
      };
      meshes.push({ name: `LOD${level}/${roles[mi]}`, primitives: [prim] });
      nodes.push({
        name: `LOD${level}/${roles[mi]}`,
        mesh: meshes.length - 1,
        extras: {
          liminaBatch: {
            lod: level,
            materialRole: roles[mi],
            indexCount: I.length,
            sourcePrimitiveCount: selected.length,
            strategy: "whole-primitive-semantic-filter",
          },
        },
      });
      root.children.push(nodes.length - 1);
      if (level === 0)
        for (const r of ranges) {
          nodes[r.ni].extras ??= {};
          nodes[r.ni].extras.visualBatchRange = {
            schema: "limina.visual-batch-range/1",
            lod: 0,
            batchNode: nodes.length - 1,
            firstIndex: r.firstIndex,
            indexCount: r.indexCount,
            bounds: r.bounds,
            materialRole: roles[mi],
            authoritative: true,
          };
        }
    }
    return ri;
  }
  const l0 = makeLod(0),
    l1 = makeLod(1),
    l2 = makeLod(2);
  g.scenes[g.scene ?? 0].nodes.push(l0); // LOD1/2 intentionally remain orphan roots for runtime selection.
  g.asset.extras ??= {};
  g.asset.extras.liminaStaticBatch = {
    schema: "limina.static-batch/1",
    sourceSha256: EXPECTED,
    lodRoots: [l0, l1, l2],
    doorRoot,
    materialRoles: roles,
    lodStrategy: "whole-primitive-semantic-filter",
  };
  g.buffers[0].byteLength = pad4(byteLength);
  const binary = Buffer.concat([...chunks, Buffer.alloc(pad4(byteLength) - byteLength)]),
    jb = Buffer.from(JSON.stringify(g)),
    jp = Buffer.concat([jb, Buffer.alloc(pad4(jb.length) - jb.length, 0x20)]),
    out = Buffer.alloc(12 + 8 + jp.length + 8 + binary.length);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jp.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jp.copy(out, 20);
  let o = 20 + jp.length;
  out.writeUInt32LE(binary.length, o);
  out.writeUInt32LE(BIN_CHUNK, o + 4);
  binary.copy(out, o + 8);
  await writeFile(resolve(output), out);
  return { sha256: hash(out), bytes: out.length, lodRoots };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] ?? "assets/buildings/functional-hall-house-v4.glb",
    output = process.argv[3] ?? "assets/buildings/functional-hall-house-v4-lod.glb";
  console.log(JSON.stringify(await batchHallHouse(input, output), null, 2));
}
