function matrixIdentity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function matrixMultiply(a, b) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let inner = 0; inner < 4; inner++) result[column * 4 + row] += a[inner * 4 + row] * b[column * 4 + inner];
  return result;
}
function localMatrix(node) {
  if (node.matrix) {
    if (
      !Array.isArray(node.matrix) ||
      node.matrix.length !== 16 ||
      node.matrix.some((value) => !Number.isFinite(value))
    )
      throw new Error("GLB node matrix is invalid");
    return node.matrix;
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0],
    xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
function transform(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}
function include(bounds, point) {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}
function complete(bounds, label) {
  if (bounds.min.some((value) => !Number.isFinite(value)) || bounds.max.some((value) => !Number.isFinite(value)))
    throw new Error(`${label} has no finite mesh bounds`);
  return bounds;
}

export function parseGlbJson(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length)
    throw new Error("invalid GLB v2 envelope");
  let offset = 12,
    document;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("truncated GLB chunk header");
    const length = bytes.readUInt32LE(offset),
      kind = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > bytes.length) throw new Error("truncated GLB chunk");
    if (kind === 0x4e4f534a) {
      if (document) throw new Error("duplicate GLB JSON chunk");
      document = JSON.parse(
        bytes
          .subarray(offset, offset + length)
          .toString("utf8")
          .trim(),
      );
    }
    offset += length;
  }
  if (!document) throw new Error("GLB JSON chunk missing");
  return document;
}

export function inspectFurnitureGlb(bytes, contract) {
  const document = parseGlbJson(bytes),
    nodes = document.nodes ?? [],
    parents = new Map();
  for (let index = 0; index < nodes.length; index++)
    for (const child of nodes[index].children ?? []) {
      if (parents.has(child)) throw new Error("GLB node has multiple parents");
      parents.set(child, index);
    }
  const memo = new Map(),
    world = (index) => {
      if (memo.has(index)) return memo.get(index);
      const matrix = parents.has(index)
        ? matrixMultiply(world(parents.get(index)), localMatrix(nodes[index]))
        : localMatrix(nodes[index]);
      memo.set(index, matrix);
      return matrix;
    },
    overall = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    partIds = new Set(contract.parts.map((part) => part.id)),
    partBounds = [];
  let rootIndex = -1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index],
      semanticId = node.extras?.["limina.id"];
    if (semanticId === contract.id) rootIndex = index;
    if (!partIds.has(semanticId)) continue;
    if (node.mesh === undefined) throw new Error(`semantic furniture part ${semanticId} has no mesh`);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let vertexCount = 0;
    for (const primitive of document.meshes?.[node.mesh]?.primitives ?? []) {
      const accessor = document.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max || accessor.min.length !== 3 || accessor.max.length !== 3)
        throw new Error(`part ${semanticId} POSITION accessor lacks bounds`);
      vertexCount += accessor.count ?? 0;
      for (const x of [accessor.min[0], accessor.max[0]])
        for (const y of [accessor.min[1], accessor.max[1]])
          for (const z of [accessor.min[2], accessor.max[2]]) {
            const point = transform(world(index), [x, y, z]);
            if (point.some((value) => !Number.isFinite(value)))
              throw new Error(`part ${semanticId} has non-finite transformed bounds`);
            include(bounds, point);
            include(overall, point);
          }
    }
    partBounds.push({ id: semanticId, bounds: complete(bounds, `part ${semanticId}`), vertexCount });
  }
  if (rootIndex < 0) throw new Error("GLB furniture root semantic id missing");
  if (partBounds.length !== partIds.size || new Set(partBounds.map((part) => part.id)).size !== partIds.size)
    throw new Error("GLB semantic part inventory is incomplete or duplicated");
  const root = world(rootIndex),
    pivot = transform(root, [0, 0, 0]);
  return { bounds: complete(overall, "GLB"), pivot, partBounds: partBounds.sort((a, b) => a.id.localeCompare(b.id)) };
}
