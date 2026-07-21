import { spawnSync } from "node:child_process";

export const REQUIRED_BLENDER_VERSION = "4.0.2";

export function candidates(env=process.env) {
  return [env.BLENDER_BIN, new URL(`../.tools/blender-${REQUIRED_BLENDER_VERSION}/blender`, import.meta.url).pathname, "blender"].filter(Boolean);
}

export function checkBlender(binary) {
  const result=spawnSync(binary,["--background","--factory-startup","--version"],{encoding:"utf8"});
  if(result.error)throw new Error(`architecture blender dependency unavailable: ${binary}: ${result.error.message}`);
  if(result.status!==0)throw new Error(`architecture blender dependency failed (${result.status}): ${binary}`);
  const match=/Blender\s+(\d+\.\d+\.\d+)/.exec(`${result.stdout}\n${result.stderr}`);
  if(!match)throw new Error(`architecture blender dependency returned an unrecognized version: ${binary}`);
  if(match[1]!==REQUIRED_BLENDER_VERSION)throw new Error(`architecture requires Blender ${REQUIRED_BLENDER_VERSION}; found ${match[1]} at ${binary}`);
  return Object.freeze({binary,version:match[1],platform:process.platform,arch:process.arch});
}

export function resolveBlender(env=process.env) {
  if(env.BLENDER_BIN)return checkBlender(env.BLENDER_BIN);
  for(const binary of candidates(env)){if(binary==="blender"){try{return checkBlender(binary);}catch{continue;}}try{spawnSync("test",["-x",binary],{stdio:"ignore"});return checkBlender(binary);}catch{}}
  throw new Error(`architecture requires Blender ${REQUIRED_BLENDER_VERSION}; install it through the Limina authoring environment or set BLENDER_BIN`);
}

if(import.meta.url===`file://${process.argv[1]}`){try{console.log(JSON.stringify({schema:"limina.architecture-blender-dependency/v1",...resolveBlender()},null,2));}catch(error){console.error(String(error));process.exitCode=1;}}
