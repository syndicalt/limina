import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {PRODUCTION_REVIEW_SITE_V5,PRODUCTION_REVIEW_VIEWS_V5} from "./production-review-site-v5.mjs";

const ROOT=resolve(import.meta.dirname,"../.."),BASE="assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653";
const PATHS=Object.freeze({manifest:`${BASE}/package-manifest-mount-verified.json`,evidence:`${BASE}/cpu-evidence-mount-verified.json`,candidate:`${BASE}/package-artifact-candidate-mount-verified.json`,mount:"traces/building-production-mount-cpu-9ba6f653aa2e8954-76eb0e9cbd511880-residual-v1.json",release:"plans/visual-fidelity-release-contract.md",environmentAuthority:"art-direction/temperate-fidelity-scene.json",environmentBundle:"assets/derived/temperate-fidelity/runtime/bundle.json",siteFit:`${BASE}/production-review-site-fit-v3.json`});
const sha=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const read=async(path)=>{const bytes=await readFile(resolve(ROOT,path));return{path,bytes,sha256:sha(bytes)}};
const ref=({path,sha256})=>({path,sha256});

export async function buildProductionReviewAuthority({outputPath=`${BASE}/production-review-authority-v5.json`,write=true}={}){
  const [manifestFile,evidenceFile,candidateFile,mountFile,releaseFile,environmentAuthorityFile,environmentBundleFile,siteFitFile]=await Promise.all(Object.values(PATHS).map(read));
  const manifest=JSON.parse(manifestFile.bytes),candidate=JSON.parse(candidateFile.bytes),evidence=JSON.parse(evidenceFile.bytes),production=manifest.runtime.productionGlb;
  const productionFile=await read(production.path);
  if(manifest.packageId!=="production/functional-hall-house-v4/r1"||manifest.status!=="draft"||manifest.humanDecision!=="pending"||manifest.visualApprovalClaimed!==false||candidate.status!=="candidate"||candidate.contractHash!==evidence.contractHash||candidate.contentHash!==production.sha256||candidate.metadata?.productionMountEvidence?.sha256!==mountFile.sha256||productionFile.sha256!==production.sha256||productionFile.bytes.length!==production.bytes)throw new Error("frozen v3 production package closure drifted");
  const siteFit=JSON.parse(siteFitFile.bytes);if(siteFit.verdict!=="pass"||JSON.stringify(siteFit.placement)!==JSON.stringify(PRODUCTION_REVIEW_SITE_V5)||siteFit.inputs?.productionGlb?.sha256!==production.sha256||siteFit.inputs?.environmentAuthority?.sha256!==environmentAuthorityFile.sha256||siteFit.inputs?.runtimeBundle?.sha256!==environmentBundleFile.sha256)throw new Error("production review site-fit evidence drifted");
  const authority={schema:"limina.building-production-review-authority/v4",gate:"R1-release",approvalPolicy:{renderer:"limina-production-native-engine",humanDecisionRequired:true,humanDecision:"pending",visualApprovalClaimed:false,timestampQueriesEnabled:false,nonEngineApprovalProhibited:true},
    package:{manifest:ref(manifestFile),cpuEvidence:ref(evidenceFile),candidate:ref(candidateFile),mountEvidence:ref(mountFile),productionGlb:{...ref(productionFile),bytes:production.bytes,engineHash:production.engineHash}},
    upstreamApprovals:manifest.approvals.decisions,visualFloor:{referenceSetId:"project-gorgon-floor-20260711",releaseContract:ref(releaseFile),automatedApprovalProhibited:true,belowFloorPresentationProhibited:true},
    environment:{authority:ref(environmentAuthorityFile),runtimeBundle:ref(environmentBundleFile),shot:"river-leading-line",context:"approved-temperate-production",siteFit:"authored-footprint-terrain-sampled",populationExclusion:"rotated-authored-footprint-before-population-mount"},
    siteFitEvidence:ref(siteFitFile),placement:PRODUCTION_REVIEW_SITE_V5,fire:{start:true,advanceTicks:120,expectedPhase:"burning",expectedEnvelope:1},
    presentation:{minimumResolution:[1920,1080],fixedTimeSeconds:12,warmupFrames:4,cameraVerticalBasis:"terrain-root-relative",captureTrace:"traces/building-production-r1-native-capture.json",captureSchema:"limina.building-production-native-review-set/v1"},
    evidenceViews:PRODUCTION_REVIEW_VIEWS_V5};
  if(write){const path=resolve(ROOT,outputPath);await mkdir(dirname(path),{recursive:true});await writeFile(path,`${JSON.stringify(authority,null,2)}\n`,{flag:"wx",mode:0o600});}
  return Object.freeze({authority,outputPath,sha256:sha(Buffer.from(`${JSON.stringify(authority,null,2)}\n`))});
}

if(import.meta.url===`file://${process.argv[1]}`){const outputIndex=process.argv.indexOf("--output");const result=await buildProductionReviewAuthority({outputPath:outputIndex<0?undefined:process.argv[outputIndex+1]});console.log(JSON.stringify({outputPath:result.outputPath,sha256:result.sha256,views:result.authority.evidenceViews.map(({id})=>id)},null,2));}
