import crypto from "node:crypto";
import fs from "node:fs";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../src/skills/functional-building-lod.ts";

const root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1";
const hash = (bytes: Uint8Array) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(`p_fb4_v3_cpu_candidate FAIL: ${message}`); };
const read = (path: string) => fs.readFileSync(path);
const jsonChunk = (bytes: Buffer) => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));

const manifestBytes = read(`${root}/candidate-manifest.json`), manifest = JSON.parse(manifestBytes.toString("utf8"));
assert(hash(manifestBytes) === "sha256:1539931ba24f0a70b80375d0865dfa478c5b54130efb6e30125cc2489e825425", "candidate manifest bytes drifted");
assert(manifest.schema === "limina.fb4-multi-room-production-candidate/v3" && manifest.status === "cpu-verified-human-pending"
  && manifest.gpuCaptureAtBuild === false && manifest.cpuProxyEvidenceAtBuild === false && manifest.visualApprovalClaimed === false,
  "candidate escaped CPU-only human-pending authority");
assert(manifest.visualDesign.status === "candidate" && manifest.cueProfile.cueIds.length === 7, "V3 visual/cue authority is incomplete or falsely approved");
for (const record of manifest.files) { const bytes = read(record.path); assert(bytes.length === record.bytes && hash(bytes) === record.sha256, `${record.role} bytes drifted`); }
for (const path of [`${root}/build-evidence.json`, `${root}/authoring-handoff.json`, `${root}/stages/index.json`])
  assert(!read(path).toString("utf8").includes(".staging-"), `${path} retained an ephemeral staging path`);

const spec = JSON.parse(read(`${root}/architecture-spec.json`).toString("utf8")) as ArchitectureSpec, compiled = compileArchitecture(spec),
  bay = compiled.attachedBays?.[0], canopy = compiled.entranceCanopies?.[0];
assert(compiled.specHash === manifest.compiler.specHash && compiled.irHash === manifest.compiler.irHash, "compiler closure drifted");
assert(bay?.functionalRoomId === "room/space/service-pantry" && bay.portalId === "portal/connection/hall-service-pantry", "attached service mass lost room/passage identity");
assert(bay.roofAbutmentIds.length === 2 && bay.roofAbutmentIds.every((id) => compiled.primitives.some((item) => item.id === `roof-wall-flashing/${id}`)), "service roof lost complete two-slope flashing");
assert(!compiled.primitives.some((item) => item.id === `gable/${bay.roofSystemId}/rear`), "buried service gable survived");
assert(canopy?.kneeBraces?.length === 2, "entry canopy lost knee-braced joinery");
assert(compiled.windows.filter((window) => window.openingId.startsWith("window/space/bedroom-a/")).every((window) => window.facade === "west"), "upper gable daylight drifted");
assert(compiled.windows.some((window) => window.openingId === bay.frontWindowId && window.facade === "south"), "service room front daylight drifted");
assert(compiled.fireplaces[0]?.flueTransition?.length === 4, "fireplace lost its enclosed compiler-owned masonry transition to the chimney shaft");
assert(spec.roofSystems?.every((roof) => roof.roofWallConnection === "weather-bearing-v1")
  && spec.attachedBays?.every((attached) => attached.headwallTermination === "exterior-weather-face-v1"),
  "roof systems lost weather-bearing clearance or exterior-face termination authority");
assert(compiled.primitives.filter((primitive) => primitive.id.startsWith("roof-wall-flashing/attached-bay/service-cross-gable/"))
  .every((primitive) => primitive.kind === "linear-member" && primitive.from[2] === -3.6 && primitive.to[2] === -3.6),
  "service roof/headwall connection moved behind the exterior weather face");

const production = read(`${root}/functional-hall-house-fb4-multi-room.glb`), contract = parseFunctionalBuildingContract(production),
  visual = parseFunctionalBuildingVisualContract(production), gltf = jsonChunk(production);
assert(contract.schema === "limina.functional-building/v2" && contract.rooms.length === 6 && contract.portals.length === 5
  && contract.verticalLinks.length === 1 && contract.doors.length === 3 && contract.spawnAnchors.length === 6 && contract.visibilityCells.length === 6,
  "V3 functional topology inventory drifted");
assert(contract.verticalLinks[0]?.flights?.length === 2 && contract.verticalLinks[0].intermediateLandings?.[0].halfExtents[1] === .95
  && contract.verticalLinks[0].approaches?.bottom.center[2] === -2.4 && contract.verticalLinks[0].approaches?.top.center[2] === -1.5
  && contract.colliders.filter((collider) => collider.id.match(/collider\/stairs\/stairs\/primary\/flight-[01]\/tread-\d+$/)).length === 20,
  "production GLB lost its traversable stair collision authority");
const semanticIds = new Set(gltf.nodes.flatMap((node: any) => node.extras?.limina?.id ? [node.extras.limina.id] : []));
for (const id of [bay.passageThreshold.id, `${bay.frontWindowId}/glass`, ...bay.roofAbutmentIds.map((value) => `roof-wall-flashing/${value}`),
  ...canopy.kneeBraces.map((brace) => brace.id), canopy.roof.id, ...canopy.posts.map((post) => post.id)])
  assert(semanticIds.has(id), `Blender/GLB lost ${id}`);
assert(visual.openings.filter((item) => item.kind === "window").length === 10, "visual contract lost occupied/dormer windows");

const lodBytes = read(`${root}/functional-hall-house-fb4-multi-room-lod.glb`), lod = parseFunctionalBuildingStaticBatch(lodBytes),
  measurements = jsonChunk(lodBytes).asset.extras.liminaStaticBatch.measurements;
assert(lod?.lodRoots.length === 3 && measurements.map((item: any) => item.triangles).join(",") === "27100,25392,10488", "V3 LOD measurements drifted");
assert(measurements[2].triangles <= 11000 && measurements[2].draws <= 640, "V3 LOD2 exceeded its explicit program budget");
parseFunctionalBuildingContract(lodBytes);

console.log("p_fb4_v3_cpu_candidate OK: exact V3 program/cue/compiler/Blender/GLB/LOD closure with six rooms, dogleg stair approaches, enclosed chimney transition, weather-bearing roof clearance, exterior-face service headwall, upper daylight, and braced entry; CPU-only human-pending");
