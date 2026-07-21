import {createHash} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {dirname,relative,resolve,sep} from "node:path";
import {resolveBlender} from "./blender-toolchain.mjs";

const ROOT=resolve(import.meta.dirname,"../..");
const sha=bytes=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical=value=>sha(Buffer.from(JSON.stringify(sortValue(value))));
const sortValue=value=>Array.isArray(value)?value.map(sortValue):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortValue(value[key])])):value;
const portable=path=>{const value=relative(ROOT,path).split(sep).join("/");if(!value||value===".."||value.startsWith("../"))throw new Error(`hearth fuel path escapes repository: ${path}`);return value;};
const args=process.argv.slice(2);
const at=flag=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: bun tools/architecture/build-hearth-fuel-source.mjs --recipe <json> --out <glb> --blend-out <blend> --evidence <json>");return resolve(args[index+1]);};
const recipePath=at("--recipe"),out=at("--out"),blendOut=at("--blend-out"),evidencePath=at("--evidence");
const adapterPath=new URL("../blender/hearth-fuel-adapter.py",import.meta.url).pathname;

for(const path of [out,blendOut,evidencePath]){
  try{await readFile(path);throw new Error(`append-only hearth fuel build output already exists: ${path}`);}catch(error){if(error?.code!=="ENOENT")throw error;}
}
const recipeBytes=await readFile(recipePath),recipe=JSON.parse(recipeBytes);
if(recipe.schema!=="limina.hearth-fuel-recipe/v1"||recipe.id!=="fire/functional-hall-house-v4/hearth-fuel/r1"||recipe.revision!==1||recipe.status!=="authoring-recipe")throw new Error("unsupported hearth fuel recipe identity");
if(!Array.isArray(recipe.parts)||recipe.parts.length<12||new Set(recipe.parts.map(part=>part.id)).size!==recipe.parts.length)throw new Error("hearth fuel recipe must contain unique irregular fuel and coal semantics");
if(recipe.parts.filter(part=>part.kind==="log").length!==3||recipe.parts.filter(part=>part.kind==="ember-bed").length!==1||recipe.parts.filter(part=>part.kind==="coal-pocket").length<8)throw new Error("hearth fuel recipe inventory drifted");
if("composition" in (recipe.authority??{}))throw new Error("C1 composition is capture context and must not be a hearth fuel build dependency");
if(!recipe.authority?.shell||!recipe.authority?.interiorPlan||!recipe.authority?.materialsRuntime||!recipe.authority?.materialsLock)throw new Error("hearth fuel must bind exact shell-r4, M1-r2, and I1-r4 authority");
const expectedOut=resolve(ROOT,"assets",recipe.export?.assetId??""),expectedBlend=resolve(ROOT,"assets",recipe.export?.blendId??"");
if(out!==expectedOut||blendOut!==expectedBlend)throw new Error("hearth fuel outputs must match the recipe's append-only fire-r1 paths");
const expectedEvidence=resolve(dirname(expectedOut),"build-evidence.json");
if(evidencePath!==expectedEvidence)throw new Error("hearth fuel evidence must use the recipe's append-only fire-r1 directory");
for(const [label,resource] of Object.entries(recipe.authority??{})){
  if(!resource||typeof resource.path!=="string"||typeof resource.sha256!=="string")throw new Error(`recipe authority ${label} is incomplete`);
  const bytes=await readFile(resolve(ROOT,resource.path));
  if(sha(bytes)!==resource.sha256)throw new Error(`recipe authority ${label} exact bytes drifted`);
}
const recipeHash=canonical(recipe),recipeRawSha256=sha(recipeBytes),toolchain=resolveBlender();
await Promise.all([mkdir(dirname(out),{recursive:true}),mkdir(dirname(blendOut),{recursive:true}),mkdir(dirname(evidencePath),{recursive:true})]);
const build=Bun.spawnSync([toolchain.binary,"--background","--factory-startup","--python",adapterPath,"--","--recipe",recipePath,"--out",out,"--blend-out",blendOut],{stdout:"pipe",stderr:"pipe"});
if(build.exitCode!==0)throw new Error(`hearth fuel Blender adapter failed (${build.exitCode})\n${build.stdout}\n${build.stderr}`);
const outputLine=build.stdout.toString().split("\n").find(line=>line.startsWith("LIMINA_HEARTH_FUEL_OUTPUT="));
if(!outputLine)throw new Error(`hearth fuel Blender adapter produced no attestation\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
const adapterOutput=JSON.parse(outputLine.slice(outputLine.indexOf("=")+1));
if(adapterOutput.schema!=="limina.blender-hearth-fuel-output/v1"||adapterOutput.id!==recipe.id||adapterOutput.recipeHash!==recipeHash||adapterOutput.recipeRawSha256!==recipeRawSha256||adapterOutput.rendered!==false||adapterOutput.gpuUsed!==false)throw new Error("hearth fuel Blender adapter attestation drifted");
if(JSON.stringify(adapterOutput.parts)!==JSON.stringify(recipe.parts.map(part=>part.id)))throw new Error("hearth fuel Blender adapter semantic inventory drifted");

const [glb,blend,adapter]=await Promise.all([readFile(out),readFile(blendOut),readFile(adapterPath)]);
if(glb.length<20||glb.toString("ascii",0,4)!=="glTF"||glb.readUInt32LE(4)!==2||glb.readUInt32LE(8)!==glb.length)throw new Error("hearth fuel output is not a valid GLB v2 envelope");
let offset=12,document;
while(offset<glb.length){const length=glb.readUInt32LE(offset),kind=glb.readUInt32LE(offset+4);offset+=8;if(offset+length>glb.length)throw new Error("hearth fuel GLB chunk escapes envelope");if(kind===0x4e4f534a)document=JSON.parse(glb.subarray(offset,offset+length).toString("utf8").trim());offset+=length;}
if(!document?.asset||!Array.isArray(document.nodes)||!Array.isArray(document.meshes)||!Array.isArray(document.materials))throw new Error("hearth fuel GLB document is incomplete");
if(document.cameras?.length||document.extensions?.KHR_lights_punctual||document.extensionsUsed?.includes("KHR_lights_punctual"))throw new Error("hearth fuel source must not contain cameras or lights");
const bySemantic=new Map(document.nodes.map(node=>[node.extras?.["limina.id"],node]).filter(([id])=>typeof id==="string"));
const root=bySemantic.get(recipe.export.rootSemanticId);
if(!root||root.extras?.["limina.role"]!=="hearth-fuel-root"||root.extras?.["limina.recipeHash"]!==recipeHash||root.extras?.["limina.recipeRawSha256"]!==recipeRawSha256)throw new Error("hearth fuel GLB root provenance drifted");
for(const part of recipe.parts){const node=bySemantic.get(part.id);if(!node||node.extras?.["limina.role"]!=="hearth-fuel-part"||node.extras?.["limina.kind"]!==part.kind||node.mesh===undefined)throw new Error(`hearth fuel GLB semantic part drifted: ${part.id}`);}
const expectedIds=new Set([recipe.export.rootSemanticId,...recipe.parts.map(part=>part.id)]);
const unexpected=[...bySemantic].filter(([id,node])=>(node.extras?.["limina.role"]==="hearth-fuel-root"||node.extras?.["limina.role"]==="hearth-fuel-part")&&!expectedIds.has(id));
if(unexpected.length)throw new Error("hearth fuel GLB contains unexpected authored semantics");

const evidence={
  schema:"limina.hearth-fuel-build-evidence/v1",
  id:recipe.id,
  recipe:{path:portable(recipePath),sha256:recipeRawSha256,canonicalHash:recipeHash},
  authority:Object.fromEntries(Object.entries(recipe.authority).map(([key,value])=>[key,{...value}])),
  toolchain,
  adapter:{path:portable(adapterPath),sha256:sha(adapter)},
  sourceBlend:{path:portable(blendOut),sha256:sha(blend),bytes:blend.length},
  asset:{path:portable(out),sha256:sha(glb),bytes:glb.length},
  inventory:{parts:recipe.parts.length,logs:recipe.parts.filter(part=>part.kind==="log").length,coalPockets:recipe.parts.filter(part=>part.kind==="coal-pocket").length,emberBeds:recipe.parts.filter(part=>part.kind==="ember-bed").length,materials:document.materials.length,nodes:document.nodes.length,meshes:document.meshes.length},
  aggregateBounds:recipe.aggregateBounds,
  adapterOutput,
  glbValidation:{version:document.asset.version,generator:document.asset.generator??null,semanticPartIds:recipe.parts.map(part=>part.id),rootSemanticId:recipe.export.rootSemanticId,cameras:0,lights:0},
  runtimeOwnership:{included:["fuel-logs","ember-bed"],excluded:["flames","light","smoke","soot-heat-treatment"]},
  rendered:false,
  gpuUsed:false,
  status:"cpu-authored-unreviewed"
};
await writeFile(evidencePath,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600,flag:"wx"});
console.log(JSON.stringify({schema:evidence.schema,id:evidence.id,parts:evidence.inventory.parts,asset:evidence.asset,sourceBlend:evidence.sourceBlend,rendered:false,gpuUsed:false},null,2));
