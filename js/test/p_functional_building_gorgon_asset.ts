import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_building_gorgon_asset FAIL: ${message}`);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = fs.readFileSync(`${root}assets/buildings/functional-cottage-gorgon-v2.glb`);
const digest = (value: Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
assert(bytes.byteLength === 874800 && digest(bytes) === "7f57c3164617fb36a659cb980995a3d4fb4695516ae348acdc2aac6a240248b5", "exact GLB closure drifted");
assert(digest(fs.readFileSync(`${root}tools/blender/functional-cottage-gorgon.py`)) === "bfeddd4460701f91c88490d50b92df9f273e1363e4eafc344b9b132671f0dd39", "Blender generator drifted without asset regeneration");
const contract = parseFunctionalBuildingContract(bytes);
assert(contract.schema === "limina.functional-building/v1", "contract schema drifted");
assert(contract.buildingId === "cottage/gorgon-one-room/v2", "building identity drifted");
assert(contract.colliders.length === 8, "expected decomposed shell plus ceiling");
assert(contract.doors.length === 1 && contract.doors[0]?.id === "door/front", "operable front door missing");
assert(contract.entryAnchor[2] < -3, "entry anchor is not exterior to the south portal");
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trim()) as {
  materials?: Array<{ normalTexture?: unknown; pbrMetallicRoughness?: { baseColorTexture?: unknown; metallicRoughnessTexture?: unknown } }>;
  images?: unknown[]; textures?: unknown[]; animations?: Array<{ name?: string }>;
};
assert(gltf.materials?.length === 11 && gltf.images?.length === 33 && gltf.textures?.length === 33, "embedded PBR texture set drifted");
assert(gltf.materials.every((material) => material.normalTexture !== undefined
  && material.pbrMetallicRoughness?.baseColorTexture !== undefined
  && material.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined), "every authored material must carry albedo, roughness, and normal maps");
assert(gltf.animations?.some((animation) => animation.name === "door/front/open"), "canonical authored door clip missing");
const runtime = fs.readFileSync(`${root}js/src/skills/functional-building.ts`, "utf8");
assert(!runtime.includes("new THREE.BoxGeometry") && runtime.includes("authoredDoorNodes"), "runtime replaced the authored door with a placeholder primitive");
console.log(`p_functional_building_gorgon_asset OK: ${bytes.byteLength} bytes, ${contract.colliders.length} colliders`);
