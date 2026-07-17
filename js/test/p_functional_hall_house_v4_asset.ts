import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(`p_functional_hall_house_v4_asset FAIL: ${m}`); }
const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = fs.readFileSync(`${root}assets/buildings/functional-hall-house-v4.glb`);
const hash = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
assert(bytes.byteLength === 16597292 && hash(bytes) === "ad27fdba15b46d8382a34cafec80c5dec75804abec24e064943668096fc07c7f", "exact GLB drifted");
assert(hash(fs.readFileSync(`${root}tools/blender/functional-hall-house-v4.py`)) === "0d21dcb977283d2ee875fc121b0b3d46f9dabbdd9bcb25f4f9ea9eef0e457ce1", "generator drifted");
const contract = parseFunctionalBuildingContract(bytes);
assert(contract.buildingId === "hall-house/temperate/v4" && contract.colliders.length === 10, "functional authority drifted");
assert(contract.doors.length === 1 && Math.abs(contract.doors[0]!.openYaw + 1.6580627893946132) < 1e-9, "95-degree inward door swing drifted");
const n = bytes.readUInt32LE(12); const gltf = JSON.parse(bytes.subarray(20, 20+n).toString().trim());
const visual = gltf.asset.extras.liminaFunctionalBuildingVisual;
assert(visual.schema === "limina.functional-building-visual/v1" && visual.openings.length === 7, "visual authority drifted");
assert(visual.openings.filter((o: any) => o.kind === "window").length === 6, "six primary windows required");
const nodes = new Map(gltf.nodes.map((node: any) => [node.extras?.limina?.id, node]));
for (const opening of visual.openings) {
  for (const id of opening.revealNodeIds) assert(nodes.has(id), `missing reveal ${id}`);
  assert(nodes.has(opening.glazingNodeId ?? opening.leafNodeId), `missing opening part ${opening.id}`);
}
assert(gltf.materials.length === 15 && gltf.images.length === 18, "cycle-7 pinned PBR/effect material set drifted");
assert(gltf.asset.extras.liminaMaterialSources?.packs?.length === 6, "six pinned cottage material packs are not embedded as provenance");
assert(gltf.materials.find((material:any)=>material.name==="V4 leadlight glass")?.alphaMode === "BLEND", "leadlight is not transparent");
assert(gltf.meshes.length === 584 && visual.lod.triangleBudget === 90000 && visual.lod.drawBudget === 640, "topology/budget authority drifted");
assert(gltf.animations.some((a: any) => a.name === "door/front/open"), "canonical door clip missing");
console.log(`p_functional_hall_house_v4_asset OK: ${bytes.byteLength} bytes, ${contract.colliders.length} colliders, ${visual.openings.length} openings`);
