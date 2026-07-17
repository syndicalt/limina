#!/usr/bin/env node
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { dirname,resolve } from "node:path";
import { createEuropeanaProvider,createManualIngestionProvider,createMetProvider,createPolyHavenProvider,createSketchfabProvider,createSmithsonianProvider,createWikimediaCommonsProvider,searchVisualReferences } from "./visual-reference-search-core.mjs";

const args=process.argv.slice(2), value=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:args[index+1];};
const query=value("--query"),out=value("--out"),limit=Number(value("--limit","24")),mediaKinds=value("--media","image,3d-model,material").split(",").filter(Boolean),requested=new Set(value("--providers","manual-web").split(","));
if(!query||!out)throw new Error("usage: node tools/reference/search-visual-references.mjs --query <text> --out <candidate.json> [--media image,3d-model,material] [--providers ...] [--limit 24] [--ingest manual-results.json]");
let manual=[];const ingest=value("--ingest");if(ingest)manual=JSON.parse(await readFile(resolve(ingest),"utf8"));if(!Array.isArray(manual))throw new Error("manual ingestion file must contain a JSON array");
const providers=[createWikimediaCommonsProvider(),createMetProvider(),createSketchfabProvider({token:process.env.SKETCHFAB_TOKEN}),createPolyHavenProvider(),createEuropeanaProvider({apiKey:process.env.EUROPEANA_API_KEY}),createSmithsonianProvider({apiKey:process.env.SMITHSONIAN_API_KEY}),createManualIngestionProvider(manual)].filter((provider)=>requested.has(provider.id));
const manifest=await searchVisualReferences({query,mediaKinds,limit},{providers});const target=resolve(out);await mkdir(dirname(target),{recursive:true});await writeFile(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`);
