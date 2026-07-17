import * as THREE from "../build/three.bundle.mjs";
import {
  TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE,
  TREE_IMPOSTOR_YAW_ATTRIBUTE,
  buildTreeImpostorGeometry,
  buildTreeImpostorMaterial,
  encodeTreeImpostorDirection,
  markTreeImpostorAttributesUpdated,
  planTreeImpostorFrames,
  writeTreeImpostorInstance,
} from "../src/render/tree-impostor-material.ts";
import type { SelectedTreeInstance } from "../src/render/tree-population-plan.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_impostor_material FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown; try { operation(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${String(error)}`);
}

for (const [direction, expected] of [
  [{ x: 0, y: 1, z: 0 }, { u: 0.5, v: 0.5 }], [{ x: 1, y: 0, z: 0 }, { u: 1, v: 1 }],
  [{ x: 0, y: 0, z: 1 }, { u: 1, v: 0 }], [{ x: -1, y: 0, z: 0 }, { u: 0, v: 0 }],
  [{ x: 0, y: 0, z: -1 }, { u: 0, v: 1 }],
] as const) assert(JSON.stringify(encodeTreeImpostorDirection(direction)) === JSON.stringify(expected), `runtime hemi-octa canonical changed for ${JSON.stringify(direction)}`);
for (const direction of [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -0.2, y: 0.9, z: 0.3 }]) {
  const frames = planTreeImpostorFrames(direction, 8);
  assert(frames.length === 4 && frames.every((frame) => frame.column >= 0 && frame.column < 8 && frame.row >= 0 && frame.row < 8), "frame blend produced an out-of-bounds cell");
  assert(Math.abs(frames.reduce((sum, frame) => sum + frame.weight, 0) - 1) < 1e-12, "frame blend weights do not sum to one");
}

const base = new THREE.PlaneGeometry(4, 10);
const geometry = buildTreeImpostorGeometry(base, 3);
assert(geometry !== base && geometry.getAttribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE).count === 3 && geometry.getAttribute(TREE_IMPOSTOR_YAW_ATTRIBUTE).count === 3,
  "impostor geometry did not allocate isolated bounded instanced attributes");
const tree: SelectedTreeInstance = { speciesId: "oak", ordinal: 1, rung: 2, x: 1_000_044, y: 3, z: -999_984, yaw: 0.7, scale: 1.4, localX: 12, localZ: 16 };
writeTreeImpostorInstance(geometry, 0, tree, 1_000_032, -1_000_000); markTreeImpostorAttributesUpdated(geometry);
const centerScale = geometry.getAttribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE), yaw = geometry.getAttribute(TREE_IMPOSTOR_YAW_ATTRIBUTE);
assert(centerScale.getX(0) === 12 && centerScale.getY(0) === 3 && centerScale.getZ(0) === 16 && Math.abs(centerScale.getW(0) - 1.4) < 1e-6,
  "impostor center/scale was not feature-local or was applied twice");
assert(Math.abs(yaw.getX(0) - 0.7) < 1e-6 && centerScale.version > 0 && yaw.version > 0, "impostor yaw/update flags were not published");

const pixels = new Uint8Array([128, 128, 100, 255, 128, 128, 100, 255, 128, 128, 100, 255, 128, 128, 100, 255]);
const albedo = new THREE.DataTexture(pixels.slice(), 2, 2), normalDepth = new THREE.DataTexture(pixels.slice(), 2, 2);
const material = buildTreeImpostorMaterial({ albedo, normalDepth, grid: 8, cellSize: 128, alphaCutoff: 0.45 });
assert(material.isMeshStandardNodeMaterial && material.positionNode !== null && material.colorNode !== null && material.opacityNode !== null && material.normalNode !== null,
  "pure-TSL impostor graph is incomplete");
assert(material.transparent === false && material.alphaTest === 0.45 && material.side === THREE.DoubleSide && material.depthWrite,
  "impostor did not enforce lit alpha-cutout rendering");
assert(albedo.colorSpace === THREE.SRGBColorSpace && normalDepth.colorSpace === THREE.NoColorSpace && !albedo.generateMipmaps && !normalDepth.generateMipmaps,
  "impostor atlas colorspace/mip bleed policy is wrong");
assert(material.userData.liminaTreeImpostor.projection === "upper-hemi-octa-rotated-diamond" && material.userData.liminaTreeImpostor.blend === "four-frame-premultiplied",
  "impostor runtime evidence does not identify the v2 projection/blend contract");

rejects(() => buildTreeImpostorGeometry(new THREE.BufferGeometry(), 1), /position and uv/, "attribute-less quad was admitted");
rejects(() => writeTreeImpostorInstance(geometry, 3, tree, 0, 0), /out of range/, "out-of-range instance write was admitted");
rejects(() => buildTreeImpostorMaterial({ albedo, normalDepth, grid: 1, cellSize: 128, alphaCutoff: 0.45 }), /grid/, "invalid grid was admitted");

geometry.dispose(); material.dispose(); albedo.dispose(); normalDepth.dispose(); base.dispose();
console.log("p_tree_impostor_material OK: v2 hemi-octa frame selection is bounded, explicit center/scale/yaw attributes stay feature-local, and the pure-TSL billboard/blend/normal/parallax graph enforces alpha/color/mip contracts");
