import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedShellReviewAuthority } from "../../js/src/render/staged-shell-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_ENVIRONMENT_AUTHORITY = "art-direction/temperate-fidelity-scene.json";
const DEFAULT_ENVIRONMENT_BUNDLE = "assets/derived/temperate-fidelity/runtime/bundle.json";
const DEFAULT_BUILD_TOOL = "tools/architecture/build-shell.ts";
const DEFAULT_ADAPTER = "tools/blender/architecture-adapter.py";
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const REVIEW_SCENE = Object.freeze({
  placement: Object.freeze({ position: Object.freeze([30, 0, 113]), yaw: 2.2531128816696446 }),
  evidenceViews: Object.freeze([
    { id:"exterior-closed",state:"closed",role:"exterior-envelope-and-articulation-before",renderLevel:"source-lod0",distanceM:18.071,camera:{position:[25.066878616098997,4,130.31081492627366],target:[30,2.4,113],fovDeg:50,near:.1,far:180} },
    { id:"exterior-open",state:"open",role:"exterior-envelope-and-articulation-after",renderLevel:"source-lod0",distanceM:18.071,camera:{position:[25.066878616098997,4,130.31081492627366],target:[30,2.4,113],fovDeg:50,near:.1,far:180} },
    { id:"roof-chimney-bumpout-junction",state:"closed",role:"roof-chimney-service-bay-junction",renderLevel:"source-lod0",distanceM:10.143,camera:{position:[21.5,8.5,118.5],target:[27.55,4.7,111.3],fovDeg:46,near:.1,far:180} },
    { id:"dormer-eave",state:"closed",role:"dormer-eave-overhang-and-roof-seat",renderLevel:"source-lod0",distanceM:6.937,camera:{position:[23.8,5.7,120],target:[28.22,5,114.7],fovDeg:42,near:.05,far:180} },
    { id:"threshold-stair-grade",state:"open",role:"threshold-stair-grade-and-door-sweep",renderLevel:"source-lod0",distanceM:5.088,camera:{position:[23.329300169000692,1.62,119.3476423784509],target:[27.209870169582025,.68,116.19467925297857],fovDeg:50,near:.03,far:180} },
    { id:"empty-interior-traversal",state:"open",role:"empty-shell-interior-traversal",renderLevel:"source-lod0",distanceM:5.251,camera:{position:[28.591353089788978,1.65,115.07222438031043],target:[30.24,1.28,110.1],fovDeg:66,near:.03,far:180} },
    { id:"hearth-structure",state:"open",role:"empty-firebox-hearth-and-flue-structure",renderLevel:"source-lod0",distanceM:2.308,camera:{position:[29.35,1.45,111.25],target:[30.24,1.1,109.15],fovDeg:48,near:.03,far:180} },
    { id:"lod-25m",state:"closed",role:"source-lod0-distance-silhouette-proof",renderLevel:"source-lod0",distanceM:25.135,camera:{position:[23.148442522359728,5.2,137.04279850871341],target:[30,2.6,113],fovDeg:48,near:.1,far:180} },
  ]),
  presentation: Object.freeze({ minimumResolution: Object.freeze([1920,1080]), fixedTimeSeconds:12, warmupFrames:8 }),
});

function relocateReviewScene(placement) {
  if (placement === undefined) return REVIEW_SCENE;
  const position=placement.position,yaw=placement.yaw;
  if(!Array.isArray(position)||position.length!==3||!position.every(Number.isFinite)||!Number.isFinite(yaw)||position[1]!==0)
    throw new Error("shell review placement must be a finite [x,0,z] and yaw");
  const source=REVIEW_SCENE.placement,c0=Math.cos(source.yaw),s0=Math.sin(source.yaw),c1=Math.cos(yaw),s1=Math.sin(yaw);
  const point=(value)=>{
    const dx=value[0]-source.position[0],dz=value[2]-source.position[2],localX=dx*c0-dz*s0,localZ=dx*s0+dz*c0;
    return Object.freeze([position[0]+localX*c1+localZ*s1,value[1],position[2]-localX*s1+localZ*c1]);
  };
  return Object.freeze({
    placement:Object.freeze({position:Object.freeze([...position]),yaw}),
    evidenceViews:Object.freeze(REVIEW_SCENE.evidenceViews.map((view)=>Object.freeze({...view,camera:Object.freeze({...view.camera,position:point(view.camera.position),target:point(view.camera.target)})}))),
    presentation:REVIEW_SCENE.presentation,
  });
}

export async function buildShellReviewAuthority({ artifactPath, buildEvidencePath, outputPath, repoRoot = DEFAULT_ROOT, buildToolPath = DEFAULT_BUILD_TOOL, adapterPath = DEFAULT_ADAPTER, environmentAuthorityPath = DEFAULT_ENVIRONMENT_AUTHORITY, environmentBundlePath = DEFAULT_ENVIRONMENT_BUNDLE, reviewPlacement, viewOverrides } = {}) {
  const root = resolve(repoRoot), absolute = (path) => resolve(root, path), portable = (path) => relative(root, path).split(sep).join("/");
  if (!artifactPath || !buildEvidencePath || !outputPath) throw new Error("shell review authority requires artifactPath, buildEvidencePath, and outputPath");
  const paths = { artifact:absolute(artifactPath), evidence:absolute(buildEvidencePath), out:absolute(outputPath), buildTool:absolute(buildToolPath), adapter:absolute(adapterPath), environmentAuthority:absolute(environmentAuthorityPath), environmentBundle:absolute(environmentBundlePath) };
  const [artifactBytes,evidenceBytes,buildToolBytes,adapterBytes,environmentAuthorityBytes,environmentBundleBytes] = await Promise.all([paths.artifact,paths.evidence,paths.buildTool,paths.adapter,paths.environmentAuthority,paths.environmentBundle].map((path)=>readFile(path)));
  const artifact = validateBuildingStageArtifact(JSON.parse(artifactBytes)), evidence = JSON.parse(evidenceBytes);
  if (artifact.kind!=="shell"||artifact.status!=="draft"||artifact.evidence.length!==0||artifact.metadata?.buildEvidencePath!==portable(paths.evidence)) throw new Error("shell review authority requires an exact unreviewed shell draft");
  if (evidence.schema!=="limina.building-shell-build-evidence/v1"||artifact.contractHash!==evidence.shellPayloadHash||artifact.contentHash!==evidence.asset?.sha256) throw new Error("shell draft and build evidence closure drifted");
  for (const key of ["furniture","domesticProps","fireVisuals","practicalLights"]) if (artifact.metadata?.exclusions?.[key]!==true||evidence.exclusions?.[key]!==true) throw new Error(`shell review authority must exclude ${key}`);
  const assetPath=resolve(root,evidence.asset.path),blendPath=resolve(root,evidence.sourceBlend.path),[assetBytes,blendBytes]=await Promise.all([readFile(assetPath),readFile(blendPath)]);
  if(hash(assetBytes)!==evidence.asset.sha256||hash(blendBytes)!==evidence.sourceBlend.sha256||artifact.metadata.runtimeGlb?.path!==portable(assetPath)||artifact.metadata.sourceBlend?.path!==portable(blendPath))throw new Error("shell review source bytes drifted");
  if(hash(adapterBytes)!==`sha256:${evidence.adapterSha256}`||evidence.toolchain?.version!=="4.0.2")throw new Error("shell review Blender toolchain drifted");
  const f=evidence.functional;
  const relocated=relocateReviewScene(reviewPlacement),reviewScene=viewOverrides===undefined?relocated:Object.freeze({...relocated,evidenceViews:Object.freeze(relocated.evidenceViews.map((view)=>{const camera=viewOverrides[view.id]??view.camera,dx=camera.position[0]-camera.target[0],dy=camera.position[1]-camera.target[1],dz=camera.position[2]-camera.target[2];return Object.freeze({...view,distanceM:Math.hypot(dx,dy,dz),camera:Object.freeze(camera)});})),}),authority=validateStagedShellReviewAuthority({schema:"limina.staged-shell-review-scene/v1",
    artifact:{path:portable(paths.artifact),sha256:hash(artifactBytes),contentHash:portableAssetContentHash(artifactBytes),artifactId:artifact.artifactId,contractHash:artifact.contractHash,assetContentHash:artifact.contentHash},
    asset:{assetId:relative(resolve(root,"assets"),assetPath).split(sep).join("/"),sha256:hash(assetBytes),assetHash:portableAssetContentHash(assetBytes)},
    buildEvidence:{path:portable(paths.evidence),sha256:hash(evidenceBytes)},
    source:{blendPath:portable(blendPath),blendSha256:hash(blendBytes),buildToolPath:portable(paths.buildTool),buildToolSha256:hash(buildToolBytes),adapterPath:portable(paths.adapter),adapterSha256:hash(adapterBytes),blenderVersion:evidence.toolchain.version},
    environment:{authorityPath:portable(paths.environmentAuthority),authoritySha256:hash(environmentAuthorityBytes),bundlePath:portable(paths.environmentBundle),bundleSha256:hash(environmentBundleBytes)},
    functional:{buildingId:f?.buildingId,doors:f?.doors,colliders:f?.colliders,rooms:f?.rooms,portals:f?.portals},exclusions:artifact.metadata.exclusions,...reviewScene});
  await mkdir(dirname(paths.out),{recursive:true});await writeFile(paths.out,`${JSON.stringify(authority,null,2)}\n`,{mode:0o600,flag:artifact.revision===1?"w":"wx"});return authority;
}

if(import.meta.url===`file://${process.argv[1]}`){const args=process.argv.slice(2),value=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:args[index+1];};const artifactPath=value("--artifact"),buildEvidencePath=value("--evidence"),outputPath=value("--out"),placementValue=value("--placement",undefined),yawValue=value("--yaw",undefined),viewOverridesPath=value("--view-overrides",undefined);if(!artifactPath||!buildEvidencePath||!outputPath)throw new Error("usage: bun tools/architecture/build-shell-review-authority.mjs --artifact <json> --evidence <json> --out <json> [--placement <x,0,z> --yaw <radians> --view-overrides <json> --build-tool <path> --adapter <path> --environment-authority <json> --environment-bundle <json>]");if((placementValue===undefined)!==(yawValue===undefined))throw new Error("shell review relocation requires both --placement and --yaw");const reviewPlacement=placementValue===undefined?undefined:{position:placementValue.split(",").map(Number),yaw:Number(yawValue)},viewOverrides=viewOverridesPath===undefined?undefined:JSON.parse(await readFile(resolve(viewOverridesPath),"utf8"));const authority=await buildShellReviewAuthority({artifactPath,buildEvidencePath,outputPath,buildToolPath:value("--build-tool",undefined),adapterPath:value("--adapter",undefined),environmentAuthorityPath:value("--environment-authority",undefined),environmentBundlePath:value("--environment-bundle",undefined),reviewPlacement,viewOverrides});console.log(JSON.stringify({artifactId:authority.artifact.artifactId,authority:outputPath,asset:authority.asset.assetId,placement:authority.placement},null,2));}
