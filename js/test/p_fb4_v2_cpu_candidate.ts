import crypto from "node:crypto";
import fs from "node:fs";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../src/skills/functional-building-lod.ts";

const root="assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01",hash=(bytes:Uint8Array)=>`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const assert=(value:unknown,message:string):asserts value=>{if(!value)throw new Error(`p_fb4_v2_cpu_candidate FAIL: ${message}`)},read=(path:string)=>fs.readFileSync(path);
const jsonChunk=(bytes:Buffer)=>JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString("utf8"));
const manifestBytes=read(`${root}/candidate-manifest.json`),manifest=JSON.parse(manifestBytes.toString("utf8"));
assert(hash(manifestBytes)==="sha256:73a685284e18d98fcbb09bafa8ec0d5c270023691c211ae4760494ef1359b9de","candidate manifest bytes drifted");
assert(manifest.status==="cpu-verified-human-pending"&&manifest.gpuCaptureAtBuild===false&&manifest.cpuProxyEvidenceAtBuild===false&&manifest.visualApprovalClaimed===false,"candidate escaped CPU-only human-pending authority");
assert(manifest.visualDesign.status==="candidate"&&manifest.cueProfile.cueIds.length===5,"V2 visual cues are missing or falsely approved");
for(const record of manifest.files){const bytes=read(record.path);assert(bytes.length===record.bytes&&hash(bytes)===record.sha256,`${record.role} bytes drifted`)}
for(const path of [`${root}/build-evidence.json`,`${root}/authoring-handoff.json`,`${root}/stages/index.json`])assert(!read(path).toString("utf8").includes(".staging-"),`${path} retained an ephemeral staging path`);

const spec=JSON.parse(read(`${root}/architecture-spec.json`).toString("utf8")) as ArchitectureSpec,compiled=compileArchitecture(spec);
assert(compiled.specHash===manifest.compiler.specHash&&compiled.irHash===manifest.compiler.irHash,"compiler closure drifted");
assert(spec.dormers?.length===1&&spec.dormers[0].windowId==="window/attic-dormer/0"&&spec.entranceCanopies?.length===1&&spec.roofPenetrations?.length===1,"V2 articulation inventory drifted");
assert(spec.fireplaces?.[0].fireboxPolicy==="rear-soot-lining","V2 hearth regressed to the historical floating soot plate");
assert((spec.fireplaces?.[0].chimneyTopY??0)>11.2&&spec.roofPenetrations?.[0].topY===spec.fireplaces?.[0].chimneyTopY,"V2 chimney lost the rulebook-owned legible ridge projection");
assert(compiled.windows.filter((window)=>window.openingId.startsWith("window/space/bedroom-")).length===4,"attic articulation consumed occupied bedroom daylight");
const canopy=compiled.entranceCanopies?.[0];assert(canopy&&compiled.functionalContract?.colliders.filter((item)=>canopy.posts.some((post)=>item.id===`collider/${post.id}`)).length===2,"canopy posts lack functional collision");
const roles=new Map(compiled.primitives.map((item)=>[item.id,item.materialRole]));assert(roles.get(canopy.roof.id)==="roof"&&roles.get(canopy.flashing.id)==="roof-flashing"&&canopy.footings.every((item)=>roles.get(item.id)==="foundation"),"canopy material authority drifted");

const production=read(`${root}/functional-hall-house-fb4-multi-room.glb`),contract=parseFunctionalBuildingContract(production),visual=parseFunctionalBuildingVisualContract(production),gltf=jsonChunk(production);
assert(contract.schema==="limina.functional-building/v2"&&contract.rooms.length===5&&contract.portals.length===4&&contract.verticalLinks.length===1&&contract.doors.length===3,"functional topology drifted");
const semanticIds=new Set(gltf.nodes.flatMap((node:any)=>node.extras?.limina?.id?[node.extras.limina.id]:[]));
for(const id of [canopy.roof.id,...canopy.posts.map((item)=>item.id),...canopy.footings.map((item)=>item.id),`collider/${canopy.posts[0].id}`,`collider/${canopy.posts[1].id}`])assert(semanticIds.has(id),`Blender/GLB lost ${id}`);
assert(visual.openings.filter((item)=>item.kind==="window").length===9,"visual contract did not preserve eight occupied windows plus one attic window");

const lodBytes=read(`${root}/functional-hall-house-fb4-multi-room-lod.glb`),lod=parseFunctionalBuildingStaticBatch(lodBytes),measurements=jsonChunk(lodBytes).asset.extras.liminaStaticBatch.measurements;
assert(lod?.lodRoots.length===3&&measurements.map((item:any)=>item.triangles).join(",")==="22160,20632,7948","V2 LOD measurements drifted");
assert(measurements[2].triangles<=8000&&compiled.primitives.filter((item)=>item.id===canopy.roof.id||canopy.posts.some((post)=>post.id===item.id)).every((item)=>item.lodLevels?.includes(2)),"LOD2 exceeded budget or dropped the covered-entry silhouette");
parseFunctionalBuildingContract(lodBytes);

console.log("p_fb4_v2_cpu_candidate OK: exact V2 program/cue/compiler/Blender/GLB/LOD closure, real upper daylight, supported canopy, centerline chimney, 7948-triangle LOD2, CPU-only human-pending");
