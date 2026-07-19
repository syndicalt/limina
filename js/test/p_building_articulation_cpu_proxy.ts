import crypto from "node:crypto";
import fs from "node:fs";
import {validateBuildingArticulationCpuProxy,verifyBuildingArticulationCpuProxyEvidence} from "../src/architecture/building-articulation-cpu-proxy.ts";
import {canonicalHash} from "../src/authoring/canonical.ts";
import {portableAssetContentHash} from "../src/world/asset-content-hash.mjs";
import {sha256} from "../src/world/sha256.mjs";

const root="assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01",path=`${root}/articulation-cpu-proxy-v2.json`,raw=(bytes:Uint8Array)=>`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const assert=(value:unknown,message:string):asserts value=>{if(!value)throw new Error(`p_building_articulation_cpu_proxy FAIL: ${message}`)},bytes=fs.readFileSync(path),evidence=verifyBuildingArticulationCpuProxyEvidence(JSON.parse(bytes.toString("utf8")),path=>fs.readFileSync(path));
assert(raw(bytes)==="sha256:4f95f5626f2e3adab40f143c45166c674348c9ba125be23dc5d1a8177489cfed","append-only proxy bytes drifted");
assert(evidence.mechanicalVerdict==="mechanically-sufficient-for-v3-site-review"&&evidence.failures.length===0,"current production GLB is not mechanically sufficient");
assert(evidence.requiredViewIds.join(",")==="front-elevation,front-three-quarter,roof-junctions"&&evidence.views.length===3,"exact three-view proxy coverage drifted");
assert(evidence.claims.renderingPerformed===false&&evidence.claims.gpuUsed===false&&evidence.claims.framebufferEvidence===false&&evidence.claims.pixelEvidence===false&&evidence.claims.visualQualityClaimed===false&&evidence.claims.siteFitClaimed===false&&evidence.claims.humanDecision==="pending","CPU evidence escaped its mechanical claim boundary");
for(const entry of [evidence.authority.candidateManifest,evidence.authority.program,evidence.authority.visualDesign,evidence.authority.cueProfile,evidence.authority.synthesisEvidence,evidence.authority.architectureSpec,evidence.authority.productionGlb]){const exact=fs.readFileSync(entry.path);assert(raw(exact)===entry.sha256&&portableAssetContentHash(exact)===entry.contentHash&&exact.length===entry.bytes,`proxy closure drifted: ${entry.path}`)}
const chimney=evidence.views.flatMap((view:any)=>view.elements.filter((item:any)=>item.elementId==="chimney"&&["front-three-quarter","roof-junctions"].includes(view.id)));assert(chimney.length===2&&chimney.every((item:any)=>item.visibleAnchorCount>=8&&item.visibleHeightFraction>=.04&&item.visibleBoundsAreaFraction>=.0015),"legible chimney evidence drifted");
const forged=structuredClone(evidence);forged.views[0].elements[0].visibleFraction=1;const {proxyHash:_,...core}=forged;forged.proxyHash=canonicalHash(sha256,core);validateBuildingArticulationCpuProxy(forged);let forgedRejected=false;try{verifyBuildingArticulationCpuProxyEvidence(forged,path=>fs.readFileSync(path));}catch{forgedRejected=true;}assert(forgedRejected,"rehashed fabricated proxy pass was not recomputed against the exact production GLB");
console.log("p_building_articulation_cpu_proxy OK: exact production GLB is recomputed across three mechanical views; rehashed fabricated evidence fails closed without GPU, pixel, site, quality, or approval claims");
