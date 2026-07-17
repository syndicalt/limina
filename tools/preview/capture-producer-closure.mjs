import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const raw=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable=(root,path)=>relative(root,path).split(sep).join("/");
const IMPORT=/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
const exists=async(path)=>{try{await access(path);return true;}catch{return false;}};
async function resolveModule(from,specifier){
  if(!specifier.startsWith("."))return undefined;
  const base=resolve(dirname(from),specifier),candidates=extname(base)?[base]:[base,`${base}.ts`,`${base}.mts`,`${base}.mjs`,`${base}.js`,resolve(base,"index.ts"),resolve(base,"index.mjs"),resolve(base,"index.js")];
  for(const candidate of candidates)if(await exists(candidate))return candidate;
  throw new Error(`capture producer import cannot be resolved: ${portable(process.cwd(),from)} -> ${specifier}`);
}

export async function collectCaptureModuleClosure(repoRoot,entryPaths){
  const pending=entryPaths.map(path=>resolve(repoRoot,path)),seen=new Set(),files=[];
  while(pending.length){const path=pending.pop();if(seen.has(path))continue;if(isAbsolute(path)&&!path.startsWith(`${repoRoot}${sep}`))throw new Error(`capture producer source escaped workspace: ${path}`);seen.add(path);const bytes=await readFile(path),logical=portable(repoRoot,path);files.push(Object.freeze({path:logical,sha256:raw(bytes),contentHash:portableAssetContentHash(bytes),bytes:bytes.byteLength}));const text=bytes.toString("utf8");for(const match of text.matchAll(IMPORT)){const dependency=await resolveModule(path,match[1]);if(dependency&&!seen.has(dependency))pending.push(dependency);}}
  return Object.freeze(files.sort((a,b)=>a.path.localeCompare(b.path)));
}

export async function buildCaptureProducerClosure({repoRoot,entryPaths,runtimeBinary,argv,environmentKeys=Object.keys(process.env)}){
  const sources=await collectCaptureModuleClosure(repoRoot,entryPaths),binaryPath=resolve(repoRoot,runtimeBinary),binaryBytes=await readFile(binaryPath),orchestratorBytes=await readFile(process.execPath);
  const execution=Object.freeze({
    binary:Object.freeze({path:runtimeBinary,sha256:raw(binaryBytes),contentHash:portableAssetContentHash(binaryBytes),bytes:binaryBytes.byteLength}),
    orchestrator:Object.freeze({kind:"bun",version:Bun.version,sha256:raw(orchestratorBytes),bytes:orchestratorBytes.byteLength}),
    entrySources:Object.freeze([...entryPaths]),sources,argv:Object.freeze([...argv]),
    platform:Object.freeze({arch:process.arch,os:process.platform}),timestampEnvironmentKeys:Object.freeze(environmentKeys.filter(key=>/TIMESTAMP/i.test(key)).sort()),
  });
  if(execution.timestampEnvironmentKeys.length)throw new Error(`capture producer inherited timestamp-risk environment keys: ${execution.timestampEnvironmentKeys.join(",")}`);
  return execution;
}
