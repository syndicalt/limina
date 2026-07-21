import fs from "node:fs";
import { parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_hall_house_v4_uv FAIL: ${message}`);
}
type J = Record<string, any>;
type M4 = number[];
type V3 = [number, number, number];
const assetSource =
    process.env.LIMINA_FUNCTIONAL_HALL_HOUSE_SOURCE ??
    new URL("../../assets/buildings/functional-hall-house-v4.glb", import.meta.url),
  bytes = fs.readFileSync(assetSource),
  jsonLength = bytes.readUInt32LE(12),
  gltf = JSON.parse(
    bytes
      .subarray(20, 20 + jsonLength)
      .toString()
      .trim(),
  ) as J,
  binOffset = 20 + jsonLength + 8,
  bin = bytes.subarray(binOffset, binOffset + bytes.readUInt32LE(20 + jsonLength));
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const read = (accessorIndex: number, index: number): number[] => {
  const accessor = gltf.accessors[accessorIndex],
    view = gltf.bufferViews[accessor.bufferView],
    count = components[accessor.type],
    stride = view.byteStride ?? count * 4,
    offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride;
  assert(accessor.componentType === 5126, "UV verifier expects float geometry accessors");
  return Array.from({ length: count }, (_, axis) => bin.readFloatLE(offset + axis * 4));
};
const readIndex = (accessorIndex: number, index: number): number => {
  const accessor = gltf.accessors[accessorIndex],
    view = gltf.bufferViews[accessor.bufferView],
    size =
      accessor.componentType === 5121
        ? 1
        : accessor.componentType === 5123
          ? 2
          : accessor.componentType === 5125
            ? 4
            : 0;
  assert(size > 0, "UV verifier expects unsigned triangle indices");
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? size);
  return size === 1 ? bin.readUInt8(offset) : size === 2 ? bin.readUInt16LE(offset) : bin.readUInt32LE(offset);
};
const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul = (a: M4, b: M4): M4 =>
    Array.from({ length: 16 }, (_, i) => {
      const row = i % 4,
        col = Math.floor(i / 4);
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      return sum;
    });
const local = (node: J): M4 => {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
};
const parents = new Map<number, number>();
for (let i = 0; i < gltf.nodes.length; i++) for (const child of gltf.nodes[i].children ?? []) parents.set(child, i);
const memo = new Map<number, M4>();
const world = (index: number): M4 => {
  const cached = memo.get(index);
  if (cached) return cached;
  const parent = parents.get(index),
    result = parent === undefined ? local(gltf.nodes[index]) : mul(world(parent), local(gltf.nodes[index]));
  memo.set(index, result);
  return result;
};
const point = (m: M4, p: number[], w: number): V3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
];
const normalise = (v: V3): V3 => {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const visual = parseFunctionalBuildingVisualContract(bytes),
  roofMaterialName = visual.materialRoles.find((role) => role.role === "roof")?.materialName;
const mappedPrimitiveCount = (predicate: (material: J) => boolean): number =>
  gltf.nodes.reduce(
    (total: number, node: J) =>
      total +
      (gltf.meshes?.[node.mesh]?.primitives ?? []).filter((primitive: J) =>
        predicate(gltf.materials[primitive.material]),
      ).length,
    0,
  );
const expectedWorldPrimitives = mappedPrimitiveCount(
    (material) => material.extras?.limina_surface_mapping === "building-space-dominant-axis",
  ),
  expectedRoofPrimitives = mappedPrimitiveCount((material) => material.name === roofMaterialName);

function verifyWorldUv(shiftNode?: string) {
  let vertices = 0,
    primitives = 0;
  for (let nodeIndex = 0; nodeIndex < gltf.nodes.length; nodeIndex++) {
    const node = gltf.nodes[nodeIndex],
      mesh = gltf.meshes?.[node.mesh];
    if (!mesh) continue;
    for (const primitive of mesh.primitives) {
      const material = gltf.materials[primitive.material],
        mapping = material.extras?.limina_surface_mapping;
      if (mapping !== "building-space-dominant-axis") continue;
      const scale = material.extras?.limina_metres_per_repeat;
      assert(Number.isFinite(scale) && scale > 0, `${material.name} has invalid repeat scale`);
      const position = gltf.accessors[primitive.attributes.POSITION],
        normal = gltf.accessors[primitive.attributes.NORMAL],
        uv = gltf.accessors[primitive.attributes.TEXCOORD_0];
      assert(
        position && normal && uv && position.count === normal.count && position.count === uv.count,
        `${node.name} lacks complete UV0 evidence`,
      );
      primitives++;
      for (let i = 0; i < position.count; i++) {
        const p = point(world(nodeIndex), read(primitive.attributes.POSITION, i), 1),
          actual = read(primitive.attributes.TEXCOORD_0, i);
        if (node.name === shiftNode) actual[0] += 0.25;
        const projections: [[number, number], [number, number], [number, number]] = [
            [p[2], p[1]],
            [p[0], p[2]],
            [p[0], p[1]],
          ],
          matches = projections.some(
            (projected) =>
              Math.abs(actual[0] - projected[0] / scale) < 1e-4 &&
              Math.abs(actual[1] - (1 - projected[1] / scale)) < 1e-4,
          );
        assert(matches, `${node.name} vertex ${i} restarts/shifts ${material.name} UV phase`);
        vertices++;
      }
    }
  }
  assert(
    primitives === expectedWorldPrimitives && primitives > 0 && vertices > 0,
    "world UV verifier did not cover every mapped cottage primitive",
  );
  return { primitives, vertices };
}

function verifyRoofUv(shiftNode?: string) {
  let vertices = 0,
    primitives = 0;
  assert(
    !gltf.nodes.some((node: J) => /^roof\/course-/.test(node.name ?? "")),
    "duplicate geometric roof courses returned",
  );
  for (let nodeIndex = 0; nodeIndex < gltf.nodes.length; nodeIndex++) {
    const node = gltf.nodes[nodeIndex],
      mesh = gltf.meshes?.[node.mesh];
    if (!mesh) continue;
    for (const primitive of mesh.primitives) {
      const material = gltf.materials[primitive.material];
      if (material.name !== roofMaterialName) continue;
      const anchor = node.extras?.limina_roof_anchor_engine,
        ridge = node.extras?.limina_roof_ridge_world,
        slope = node.extras?.limina_roof_slope_world,
        scale = node.extras?.limina_roof_metres_per_repeat;
      assert(
        Array.isArray(anchor) &&
          anchor.length === 3 &&
          Array.isArray(ridge) &&
          ridge.length === 3 &&
          Array.isArray(slope) &&
          slope.length === 3 &&
          Number.isFinite(scale) &&
          scale > 0,
        `${node.name} lacks roof-plane UV authority`,
      );
      assert(
        Math.abs(Math.hypot(...ridge) - 1) < 1e-5 &&
          Math.abs(Math.hypot(...slope) - 1) < 1e-5 &&
          Math.abs(dot(ridge, slope)) < 1e-5,
        `${node.name} roof axes are not orthonormal`,
      );
      const position = gltf.accessors[primitive.attributes.POSITION],
        uv = gltf.accessors[primitive.attributes.TEXCOORD_0];
      assert(position && uv && position.count === uv.count, `${node.name} lacks complete roof UV0 evidence`);
      primitives++;
      for (let i = 0; i < position.count; i++) {
        const p = point(world(nodeIndex), read(primitive.attributes.POSITION, i), 1),
          relative = [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]],
          actual = read(primitive.attributes.TEXCOORD_0, i);
        if (node.name === shiftNode) actual[0] += 0.25;
        const expectedU = dot(relative, ridge) / scale,
          expectedV = 1 - dot(relative, slope) / scale;
        assert(
          Math.abs(actual[0] - expectedU) < 1e-4 && Math.abs(actual[1] - expectedV) < 1e-4,
          `${node.name} vertex ${i} rotated/restarted roof UV phase`,
        );
        vertices++;
      }
    }
  }
  assert(
    primitives === expectedRoofPrimitives && primitives > 0 && vertices > 0,
    "roof UV verifier did not cover every roof-role primitive",
  );
  return { primitives, vertices };
}

function verifyTimberUv() {
  let primitives = 0,
    triangles = 0;
  for (const node of gltf.nodes) {
    const mesh = gltf.meshes?.[node.mesh];
    if (!mesh) continue;
    for (const primitive of mesh.primitives) {
      const material = gltf.materials[primitive.material];
      if (material.extras?.limina_surface_mapping !== "member-local-face-aware") continue;
      const position = primitive.attributes.POSITION,
        uv = primitive.attributes.TEXCOORD_0,
        indices = primitive.indices;
      assert(
        position !== undefined && uv !== undefined && indices !== undefined,
        `${node.name} lacks indexed face-aware timber UV0`,
      );
      const count = gltf.accessors[indices].count;
      assert(count % 3 === 0, `${node.name} has non-triangle timber indices`);
      primitives++;
      for (let offset = 0; offset < count; offset += 3) {
        const ids = [readIndex(indices, offset), readIndex(indices, offset + 1), readIndex(indices, offset + 2)],
          p = ids.map((index) => read(position, index)),
          t = ids.map((index) => read(uv, index)),
          pArea = Math.hypot(
            (p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]),
            (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]),
            (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]),
          ),
          uvArea = Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]));
        if (pArea > 1e-8) assert(uvArea > 1e-10, `${node.name} triangle ${offset / 3} collapses to a texture streak`);
        triangles++;
      }
    }
  }
  assert(primitives > 0 && triangles > 0, "face-aware timber UV verifier covered no geometry");
  return { primitives, triangles };
}

const coverage = verifyWorldUv();
const roofCoverage = verifyRoofUv();
const timberCoverage = verifyTimberUv();
const worldMutationTarget = gltf.nodes.find((node: J) =>
  gltf.meshes?.[node.mesh]?.primitives?.some(
    (primitive: J) =>
      gltf.materials[primitive.material].extras?.limina_surface_mapping === "building-space-dominant-axis",
  ),
)?.name;
assert(typeof worldMutationTarget === "string", "world UV mutation target missing");
let mutationFailed = false;
try {
  verifyWorldUv(worldMutationTarget);
} catch {
  mutationFailed = true;
}
assert(mutationFailed, "adversarial quarter-tile facade UV shift escaped the gate");
const roofMutationTarget = gltf.nodes.find((node: J) =>
  gltf.meshes?.[node.mesh]?.primitives?.some(
    (primitive: J) => gltf.materials[primitive.material].name === roofMaterialName,
  ),
)?.name;
assert(typeof roofMutationTarget === "string", "roof UV mutation target missing");
let roofMutationFailed = false;
try {
  verifyRoofUv(roofMutationTarget);
} catch {
  roofMutationFailed = true;
}
assert(roofMutationFailed, "adversarial quarter-tile roof UV shift escaped the gate");
const opaque = Buffer.from(bytes),
  source = '"alphaMode":"BLEND"',
  replacement = '"alphaMode":"OPAQU"',
  at = opaque.lastIndexOf(source);
assert(at >= 0, "transparent material token missing");
opaque.write(replacement, at, "utf8");
let opaqueFailed = false;
try {
  parseFunctionalBuildingVisualContract(opaque);
} catch {
  opaqueFailed = true;
}
assert(opaqueFailed, "adversarial opaque glazing escaped the visual contract");
console.log(
  `p_functional_hall_house_v4_uv OK: ${coverage.vertices} facade vertices/${coverage.primitives} primitives, ${roofCoverage.vertices} roof vertices/${roofCoverage.primitives} primitives, and ${timberCoverage.triangles} timber triangles/${timberCoverage.primitives} primitives preserve non-degenerate authored UV; shifted facade/roof UV and opaque-glass mutations rejected`,
);
