import crypto from "node:crypto";
import fs from "node:fs";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../src/skills/functional-building-lod.ts";

const root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-d0ca1e327841";
const fail = (message: string): never => { throw new Error(`p_fb4_program_synthesis_candidate FAIL: ${message}`); };
const assert = (value: unknown, message: string): asserts value => { if (!value) fail(message); };
const hash = (bytes: Uint8Array) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const read = (path: string) => fs.readFileSync(path);
const glbJson = (bytes: Buffer) => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));

const manifestBytes = read(`${root}/candidate-manifest.json`);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
// Byte pins: manifest + synthesis evidence are FROZEN records; the status/binding
// assertions below would otherwise be self-consistency (regenerating the JSON forges
// the verdict). Re-pin ONLY with an explicit owner re-decision, in the same commit.
assert(hash(manifestBytes) === "sha256:1eeccda410009e68be17dbada80a5c5568caf8f44f7bee3fbe095676a50322ad",
  "candidate manifest bytes drifted from the pinned record");
assert(hash(read(`${root}/synthesis-evidence.json`)) === "sha256:0b4f60bad5b2362136a3580a71e9f1b1085a02ca08914eb7b7200828c32fbd4e",
  "synthesis evidence bytes drifted from the pinned record");
assert(manifest.status === "cpu-verified-human-pending" && manifest.visualApprovalClaimed === false && manifest.gpuCaptureRun === false,
  "candidate escaped the CPU-only human-pending boundary");
for (const record of manifest.files) {
  const bytes = read(record.path);
  assert(bytes.length === record.bytes && hash(bytes) === record.sha256, `file identity drifted for ${record.role}`);
}

const synthesis = JSON.parse(read(`${root}/synthesis-evidence.json`).toString("utf8"));
assert(synthesis.program.sha256 === manifest.programAuthority.sha256 && synthesis.selectedManifest.programHash === manifest.programAuthority.programHash,
  "program authority is not hash-bound to synthesis evidence");
assert(synthesis.selectedRank === 1 && synthesis.selectedManifest.rulebookHash === manifest.synthesis.rulebookHash
  && synthesis.selectedManifest.decisionHash === manifest.synthesis.decisionHash, "selected decision binding drifted");

const spec = JSON.parse(read(`${root}/architecture-spec.json`).toString("utf8")) as ArchitectureSpec;
const compiled = compileArchitecture(spec);
assert(compiled.specHash === manifest.compiler.specHash && compiled.irHash === manifest.compiler.irHash,
  "architecture compiler closure drifted");
assert(spec.volumes?.length === 2 && spec.interiorPartitions?.length === 4,
  "candidate regressed to coincident room-volume construction");
assert(spec.roofSystems?.length === 1 && spec.roofPlanes === undefined
  && compiled.primitives.filter((primitive) => primitive.id.startsWith("gable/")).length === 2,
  "candidate lacks two compiler-owned gable closures");
assert(compiled.windows.length === 8
  && ["space/ground-hall", "space/kitchen", "space/bedroom-a", "space/bedroom-b"].every((spaceId, index) =>
    compiled.windows.filter((window) => window.openingId.startsWith(`window/${spaceId}/`)).length === [3, 1, 2, 2][index]),
  "candidate silently dropped a BuildingProgram daylight requirement");
assert(spec.perceptualTimberFrames?.length === 4 && compiled.perceptualTimberFrames?.length === 4
  && compiled.perceptualTimberFrames.every((frame) => frame.verification === "perceptual-only" && frame.parts.length > 0),
  "candidate lacks compiler-derived perceptual timber-frame expression");
assert(spec.functional && "schema" in spec.functional && spec.functional.site.entranceSupport?.sourcePrimitiveId === "entrance/entrance/main/step-0",
  "candidate lost compiler-owned exterior-grade entrance support");

const production = read(`${root}/functional-hall-house-fb4-multi-room.glb`),
  contract = parseFunctionalBuildingContract(production), visual = parseFunctionalBuildingVisualContract(production);
assert(contract.schema === "limina.functional-building/v2" && contract.rooms.length === 5 && contract.portals.length === 4
  && contract.verticalLinks.length === 1 && contract.doors.length === 3, "embedded functional topology drifted");
assert(contract.schema === "limina.functional-building/v2" && contract.verticalLinks[0].rise / contract.verticalLinks[0].riserCount <= .175,
  "stair escaped the engine-capsule riser rulebook");
assert(visual.openings.filter((opening) => opening.kind === "door" && opening.exterior === true).length === 1
  && visual.openings.filter((opening) => opening.kind === "door" && opening.exterior === false).length === 2,
  "visual contract lost exterior/interior door classification");
assert(visual.interior.furnishingNodeIds.length === 0, "architecture stage silently absorbed interior furnishing authority");
assert(visual.materialRoles.some(({ role, materialName }) => role === "timber-frame-exterior" && materialName === "V4 exterior frame oak"),
  "exterior frame material role collapsed back into generic structure trim");
const productionJson = glbJson(production), frameNodes = productionJson.nodes.filter((node: any) => node.extras?.limina?.id?.startsWith("perceptual-timber-frame/"));
assert(frameNodes.length === compiled.perceptualTimberFrames?.flatMap((frame) => frame.parts).length,
  "Blender round-trip lost compiler-owned frame members");
assert(frameNodes.some((node: any) => node.extras.limina.id.length > 63 && node.name !== node.extras.limina.id)
  && new Set(frameNodes.map((node: any) => node.extras.limina.id)).size === frameNodes.length,
  "long frame identities are not preserved authoritatively through extras.limina.id");
assert(frameNodes.every((node: any) => node.extras["limina.derivedFrom"]?.includes("perceptual-only")
  && !node.extras["limina.colliderCenter"]), "frame provenance/collision boundary drifted in GLB extras");

const lodBytes = read(`${root}/functional-hall-house-fb4-multi-room-lod.glb`), lod = parseFunctionalBuildingStaticBatch(lodBytes);
assert(lod?.lodRoots.length === 3 && lod.doorRoots?.length === 3 && lod.doorRoot === lod.doorRoots[0],
  "LOD package did not preserve all articulated door roots outside static batches");
const measurements = glbJson(lodBytes).asset.extras.liminaStaticBatch.measurements;
assert(measurements[0].triangles <= visual.lod.triangleBudget && measurements[1].triangles <= visual.lod.lod1TriangleBudget
  && measurements[2].triangles <= visual.lod.lod2TriangleBudget && measurements.every((item: any) => item.draws <= visual.lod.drawBudget),
  "frame-aware LOD package escaped locked budgets");
parseFunctionalBuildingContract(lodBytes);

const authorityPaths = new Set(manifest.buildAuthority.files.map((record: any) => record.path));
for (const required of ["js/src/architecture/building-program-synthesizer.ts", "js/src/architecture/compiler.ts", "js/src/architecture/schema.ts",
  "js/src/architecture/staged-partition.ts", "tools/blender/validate-architecture-blend.py", "tools/asset/batch-architecture-building.mjs"])
  assert(authorityPaths.has(required), `candidate identity omitted production authority ${required}`);
assert([...authorityPaths].filter((path) => path.startsWith("assets/materials/")).length >= 30,
  "candidate identity omitted consumed material manifests or source maps");

const productionBuilder = read("tools/architecture/build-fb4-multi-room-candidate.ts").toString("utf8");
assert(!productionBuilder.includes("js/test") && !productionBuilder.includes("test/fixtures")
  && productionBuilder.includes("synthesizeTimberHallHouse"), "production builder retained the legacy test-fixture authority");

console.log(`p_fb4_program_synthesis_candidate OK: ${production.length} bytes, closed gables, 8 windows, 150 compiler-derived frame members, long-ID GLB/LOD closure, 5 rooms, 4 portals, 3 articulated doors, CPU-only human-pending`);
