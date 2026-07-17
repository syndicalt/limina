import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  compileArchitecture,
  serializeBlenderArchitectureInput,
  type ArchitectureSpec,
} from "../src/architecture/index.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { makeMultiRoomArchitectureSpec } from "./fixtures/architecture-multi-room.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_architecture_blender_multi_room FAIL: ${message}`);
}
function gltfJson(bytes: Uint8Array): Record<string, any> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(view.getUint32(0, true) === 0x46546c67, "Blender output is not a GLB");
  let offset = 12;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true);
    if (kind === 0x4e4f534a) return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)).trim());
    offset += 8 + length;
  }
  throw new Error("p_architecture_blender_multi_room FAIL: GLB has no JSON chunk");
}
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const base = JSON.parse(fs.readFileSync("assets/buildings/functional-hall-house-architecture-v5.json", "utf8")) as ArchitectureSpec;
const legacyBefore = compileArchitecture(structuredClone(base));
const spec = makeMultiRoomArchitectureSpec(base), compiled = compileArchitecture(spec);
const payload = JSON.parse(serializeBlenderArchitectureInput(compiled));
assert(payload.functionalContract.schema === "limina.functional-building/v2", "serialized IR lost strict v2 authority");
assert(payload.multiRoom?.schema === "limina.blender-multi-room-realization/v1", "serialized IR lacks explicit Blender v2 realization authority");
assert(payload.multiRoom.verticalLinkIds.join() === "stairs/main-upper", "serialized vertical-link inventory drifted");
assert(payload.multiRoom.partitionedFloors.length === 1 && payload.multiRoom.partitionedFloors[0].fragmentIds.length === 4, "serialized partitioned-floor inventory drifted");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "limina-fb4-blender-"));
const specPath = path.join(temp, "multi-room.json"), glbPath = path.join(temp, "multi-room.glb");
const blendPath = path.join(temp, "multi-room.source.blend"), evidencePath = path.join(temp, "multi-room.evidence.json"), handoffPath = path.join(temp, "multi-room.handoff.json");
fs.writeFileSync(specPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
const run = Bun.spawnSync([process.execPath, "tools/architecture/build-building.ts", "--spec", specPath, "--out", glbPath, "--evidence", evidencePath, "--blend-out", blendPath, "--handoff", handoffPath], { stdout: "pipe", stderr: "pipe" });
assert(run.exitCode === 0, `real Blender build failed (${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`);

const glb = fs.readFileSync(glbPath), contract = parseFunctionalBuildingContract(glb);
assert(contract.schema === "limina.functional-building/v2", "strict parser did not recover v2 authority from Blender GLB");
assert(contract.rooms.length === 3 && contract.verticalLinks.length === 1 && contract.spawnAnchors.length === 3, "strict parsed topology drifted");
const json = gltfJson(glb), nodes: any[] = json.nodes ?? [], byName = new Map(nodes.map((node, index) => [node.name, { node, index }]));
const root = byName.get(contract.rootNodeId);
assert(json.scenes?.length === 1 && json.scene === 0 && json.scenes[0].nodes?.length === 1 && json.scenes[0].nodes[0] === root?.index, "semantic building root is not the sole canonical scene root");
const stairPrefix = "stairs/stairs/main-upper/";
assert([...byName.keys()].filter(name => name.startsWith(stairPrefix)).length === 20, "Blender GLB lacks the 18 compiler stair treads and two landings");
const floor = payload.multiRoom.partitionedFloors[0];
assert(floor.fragmentIds.every((id: string) => byName.has(id)), "Blender GLB lacks a compiler-owned upper-floor fragment");
assert(!byName.has(floor.prohibitedFullFloorId), "Blender GLB retained the full upper floor across the stair void");
assert(!contract.colliders.some(collider => collider.id === `collider/${floor.prohibitedFullFloorId}`), "strict contract retained a full upper-floor collider");
for (const [id, role] of [["stairs/main-upper", "vertical-link"], ["spawn/upper", "spawn-anchor"], ["cell/upper", "visibility-cell"]] as const)
  assert(byName.get(id)?.node.extras?.limina?.role === role, `${id} lacks explicit editable v2 semantic metadata`);

const blend = fs.readFileSync(blendPath), handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8")), evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const blendMagic = new TextDecoder().decode(blend.subarray(0, 7)), zstdBlend = blend[0] === 0x28 && blend[1] === 0xb5 && blend[2] === 0x2f && blend[3] === 0xfd;
assert(blendMagic === "BLENDER" || zstdBlend, "editable Blender handoff is absent or invalid");
assert(handoff.schema === "limina.blender-authoring-handoff/v1" && handoff.genericGltfExportAllowed === false, "authoring handoff policy drifted");
assert(handoff.recipe.irHash === compiled.irHash && handoff.derived.sourceGlb.sha256 === sha(glb), "handoff is not bound to exact IR and GLB bytes");
assert(evidence.functional.rooms === 3 && evidence.functional.portals === 2 && evidence.functional.buildingId === contract.buildingId, "build evidence lost multi-room inventory");

const legacyAfter = compileArchitecture(structuredClone(base));
assert(legacyAfter.irHash === legacyBefore.irHash && JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore), "FB-4 Blender round-trip perturbed canonical R1 compiler output");
console.log(`p_architecture_blender_multi_room OK: ${contract.rooms.length} rooms, ${contract.verticalLinks.length} stair, 4 floor fragments, strict v2 GLB, editable Blend/handoff (${temp})`);
