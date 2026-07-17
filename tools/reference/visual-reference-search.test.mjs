import assert from "node:assert/strict";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CANDIDATE_SCHEMA,createAcquisitionManifest,createEuropeanaProvider,createManualIngestionProvider,createMetProvider,createPolyHavenProvider,
  createSketchfabProvider,createSmithsonianProvider,createWikimediaCommonsProvider,searchVisualReferences,
} from "./visual-reference-search-core.mjs";

const fixtures=new Map([
  ["commons",{query:{pages:{"8":{pageid:8,index:1,title:"File:Wall stair.jpg",canonicalurl:"https://commons.wikimedia.org/wiki/File:Wall_stair.jpg",imageinfo:[{url:"https://upload.wikimedia.org/original.jpg",thumburl:"https://upload.wikimedia.org/thumb.jpg",width:2400,height:1600,mime:"image/jpeg",extmetadata:{Artist:{value:"<b>Ada Maker</b>"},UsageTerms:{value:"Creative Commons Attribution-ShareAlike"},LicenseShortName:{value:"CC BY-SA 4.0"},LicenseUrl:{value:"https://creativecommons.org/licenses/by-sa/4.0/"}}}]}}}}],
  ["met-search",{objectIDs:[42]}],
  ["met-object",{objectID:42,title:"Oak staircase",objectURL:"https://www.metmuseum.org/art/collection/search/42",primaryImage:"https://images.metmuseum.org/original.jpg",primaryImageSmall:"https://images.metmuseum.org/small.jpg",isPublicDomain:true,artistDisplayName:"Historic Joiner",tags:[{term:"Stairs"}]}],
  ["sketchfab",{results:[{uid:"stairs-1",name:"Wall stair study",viewerUrl:"https://sketchfab.com/3d-models/wall-stair-stairs-1",user:{displayName:"Modeler"},license:{label:"CC Attribution",url:"https://creativecommons.org/licenses/by/4.0/"},thumbnails:{images:[{url:"https://media.sketchfab.com/320.jpg",width:320},{url:"https://media.sketchfab.com/960.jpg",width:960}]},tags:[{name:"stairs"}]}]}],
  ["poly-model",{"wall-stair":{name:"Wall Stair",authors:{Maker:{}},categories:["architecture"],tags:["stairs"]}}],
  ["poly-texture",{"oak-planks":{name:"Oak Planks",authors:{Maker:{}},categories:["wood"],tags:["oak"]}}],
  ["europeana",{items:[{id:"/x/1",title:["Historic stair"],guid:"https://www.europeana.eu/item/x/1",edmPreview:["https://api.europeana.eu/preview.jpg"],edmIsShownBy:["https://archive.example/original.jpg"],dcCreator:["Archive Maker"],rights:["https://creativecommons.org/publicdomain/mark/1.0/"]}]}],
  ["smithsonian",{response:{rows:[{id:"object-1",title:"Domestic stair",content:{descriptiveNonRepeating:{record_link:"https://www.si.edu/object/object-1",online_media:{media:[{thumbnail:"https://ids.si.edu/thumb.jpg",content:"https://ids.si.edu/original.jpg",rights:"CC0",type:"image/jpeg"}]},metadata_usage:{access:"CC0"}},indexedStructured:{name:["Smithsonian photographer"]}}}]}}],
]);
const fetchJson=async(resource)=>{const value=String(resource);if(value.includes("commons.wikimedia"))return fixtures.get("commons");if(value.includes("/search?hasImages"))return fixtures.get("met-search");if(value.includes("/objects/42"))return fixtures.get("met-object");if(value.includes("sketchfab"))return fixtures.get("sketchfab");if(value.includes("polyhaven")&&value.includes("t=models"))return fixtures.get("poly-model");if(value.includes("polyhaven")&&value.includes("t=textures"))return fixtures.get("poly-texture");if(value.includes("europeana"))return fixtures.get("europeana");if(value.includes("si.edu"))return fixtures.get("smithsonian");throw new Error(`unexpected offline URL ${value}`);};

const manual=createManualIngestionProvider([
  {providerId:"web-1",query:"medieval wall staircase",title:"Unverified blog image",canonicalPageUrl:"https://example.org/stair",previewUrl:"https://example.org/stair.jpg",mediaKind:"image"},
  {providerId:"duplicate",query:"medieval wall staircase",title:"Duplicate licensed record",canonicalPageUrl:"https://commons.wikimedia.org/wiki/File:Wall_stair.jpg?ref=search",previewUrl:"https://example.org/duplicate.jpg",creator:"Other",rights:"CC0",license:"CC0"},
]);
const providers=[createWikimediaCommonsProvider(),createMetProvider(),createSketchfabProvider({token:"offline-token"}),createPolyHavenProvider(),createEuropeanaProvider({apiKey:"offline-key"}),createSmithsonianProvider({apiKey:"offline-key"}),manual];
const manifest=await searchVisualReferences({query:"medieval wall staircase",mediaKinds:["image","3d-model","material"],limit:20},{providers,fetchJson,clock:()=>new Date("2026-07-16T12:00:00.000Z")});
assert.equal(manifest.schema,CANDIDATE_SCHEMA);assert.equal(manifest.policy.productionAssetImportAllowed,false);assert.equal(manifest.generatedAt,"2026-07-16T12:00:00.000Z");assert.deepEqual(manifest.failures,[]);
assert.equal(manifest.results.filter(({canonicalPageUrl})=>canonicalPageUrl.includes("commons.wikimedia.org/wiki/File:Wall_stair.jpg")).length,1,"canonical URLs must deduplicate across providers");
assert.ok(manifest.results.some(({provider,eligibleForCuration,license,originalUrl})=>provider==="wikimedia-commons"&&eligibleForCuration&&license==="CC BY-SA 4.0"&&originalUrl));
assert.ok(manifest.results.some(({provider,mediaKind,warnings})=>provider==="sketchfab"&&mediaKind==="3d-model"&&warnings.some((warning)=>warning.includes("thumbnail only"))));
assert.ok(manifest.results.some(({provider,mediaKind})=>provider==="poly-haven"&&mediaKind==="material"));
const unknown=manifest.results.find(({provider})=>provider==="manual-web");assert.equal(unknown.eligibleForCuration,false);assert.equal(unknown.originalUrl,undefined);assert.ok(unknown.warnings.some((warning)=>warning.startsWith("ineligible:")));
for(let index=0;index<manifest.results.length;index++){const result=manifest.results[index];assert.equal(result.rank,index+1);assert.match(result.canonicalPageUrl,/^https:\/\//);assert.ok(["image","3d-model","material"].includes(result.mediaKind));}
const commons=manifest.results.find(({provider})=>provider==="wikimedia-commons"),acquisition=createAcquisitionManifest(manifest,{id:"architecture/domestic-stair/v1",subjectKind:"architecture",sources:[{candidateId:commons.id,roles:["circulation","wall-adjacency"]}]});assert.equal(acquisition.schema,"limina.visual-reference-acquisition/v1");assert.equal(acquisition.sources[0].imageUrl,"https://upload.wikimedia.org/original.jpg");assert.throws(()=>createAcquisitionManifest(manifest,{id:"bad",subjectKind:"architecture",sources:[{candidateId:unknown.id,roles:["shape"]}]}),/not eligible/);assert.throws(()=>createAcquisitionManifest(manifest,{id:"bad",subjectKind:"architecture",sources:[{candidateId:manifest.results.find(({provider})=>provider==="sketchfab").id,roles:["shape"]}]}),/not eligible/);

const failed=await searchVisualReferences({query:"stairs",mediaKinds:["image"],limit:3},{providers:[{id:"offline-failure",async search(){throw new Error("network disabled");}},createManualIngestionProvider([{providerId:"safe",title:"Safe",canonicalPageUrl:"https://example.org/safe",creator:"Archivist",rights:"CC0",license:"CC0"}])],fetchJson,clock:()=>new Date(0)});
assert.deepEqual(failed.failures,[{provider:"offline-failure",error:"network disabled"}]);assert.equal(failed.results.length,1,"one provider failure must not erase bounded results from another provider");

const directory=await mkdtemp(join(tmpdir(),"limina-reference-search-"));try{const ingest=join(directory,"manual.json"),out=join(directory,"candidates.json");await writeFile(ingest,JSON.stringify([{providerId:"cli-1",title:"Archive window",canonicalPageUrl:"https://archive.example/window",previewUrl:"https://archive.example/window.jpg",creator:"Archive",rights:"Public Domain",license:"Public Domain",mediaKind:"image"}]));const run=spawnSync(process.execPath,[new URL("search-visual-references.mjs",import.meta.url).pathname,"--query","upper floor windows","--media","image","--providers","manual-web","--ingest",ingest,"--out",out],{encoding:"utf8",env:{...process.env,SKETCHFAB_TOKEN:"",EUROPEANA_API_KEY:"",SMITHSONIAN_API_KEY:""}});assert.equal(run.status,0,run.stderr);const written=JSON.parse(await readFile(out,"utf8"));assert.equal(written.results[0].provider,"manual-web");assert.equal(written.policy.productionAssetImportAllowed,false);}finally{await rm(directory,{recursive:true,force:true});}
console.log(`visual reference search OK: ${manifest.results.length} normalized, ranked, rights-gated candidates`);
