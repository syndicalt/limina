import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const bytes = readFileSync("/input/candidate.glb");
if (bytes.byteLength < 1_024 || bytes.byteLength > 128 * 1024 * 1024) throw new Error("candidate GLB size is outside the isolated QC bounds");
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
  throw new Error("candidate is not a canonical complete GLB v2 file");
}
const jsonLength = view.getUint32(12, true);
if (jsonLength <= 0 || 20 + jsonLength > bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) {
  throw new Error("candidate GLB has an invalid JSON chunk");
}
const gltf = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)).trim());
const accessors = gltf.accessors ?? [];
const positions = [];
for (const mesh of gltf.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
  const accessor = accessors[primitive?.attributes?.POSITION];
  if (accessor?.type === "VEC3" && Array.isArray(accessor.min) && Array.isArray(accessor.max)) positions.push(accessor);
}
if (positions.length === 0) throw new Error("candidate GLB has no bounded POSITION accessor");
const rawMin = [0, 1, 2].map((axis) => Math.min(...positions.map((entry) => Number(entry.min[axis]))));
const rawMax = [0, 1, 2].map((axis) => Math.max(...positions.map((entry) => Number(entry.max[axis]))));
if (![...rawMin, ...rawMax].every(Number.isFinite)) throw new Error("candidate GLB bounds are non-finite");
const rawDimensions = rawMax.map((value, axis) => value - rawMin[axis]);
if (Math.max(...rawDimensions) < 0.02 || rawDimensions.some((value) => value > 60)) {
  throw new Error(`candidate GLB raw bounds are degenerate or oversized: ${rawDimensions.join(",")}`);
}
const report = {
  schema: "limina.architect-isolated-qc/v1",
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  bytes: bytes.byteLength,
  rawBounds: { min: rawMin, max: rawMax, dimensions: rawDimensions },
  meshes: Array.isArray(gltf.meshes) ? gltf.meshes.length : 0,
  materials: Array.isArray(gltf.materials) ? gltf.materials.length : 0,
  images: Array.isArray(gltf.images) ? gltf.images.length : 0,
};
writeFileSync("/evidence/qc.json", JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
