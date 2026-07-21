import { createHash } from "node:crypto";
import fs from "node:fs";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

const [assetPath,evidencePath]=process.argv.slice(2);if(!assetPath||!evidencePath)throw new Error("usage: bun run js/test/p_architecture_shell_artifact.ts <shell.glb> <evidence.json>");
const bytes=fs.readFileSync(assetPath),evidence=JSON.parse(fs.readFileSync(evidencePath,"utf8"));
if(evidence.schema!=="limina.building-shell-build-evidence/v1"||evidence.exclusions?.furniture!==true||evidence.exclusions?.domesticProps!==true||evidence.exclusions?.fireVisuals!==true||evidence.exclusions?.practicalLights!==true)throw new Error("shell evidence does not fail closed on visible-content exclusions");
const digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;if(evidence.asset.sha256!==digest||evidence.asset.bytes!==bytes.length)throw new Error("shell evidence does not bind exact GLB bytes");
const jsonLength=bytes.readUInt32LE(12),document=JSON.parse(bytes.subarray(20,20+jsonLength).toString().trimEnd()),names=(document.nodes??[]).map((node:any)=>node.name??"");
const forbidden=names.filter((name:string)=>name.startsWith("furnishing/")||name.startsWith("domestic-prop/")||/fireplace\/.+\/(flame-|embers|log-)/.test(name));if(forbidden.length)throw new Error(`shell GLB contains separately-owned visible content: ${forbidden.slice(0,5).join(",")}`);
if(document.extensions?.KHR_lights_punctual?.lights?.length||document.extensionsUsed?.includes("KHR_lights_punctual"))throw new Error("shell GLB contains practical lights");
const contract=parseFunctionalBuildingContract(bytes);if(contract.buildingId!==evidence.functional.buildingId||contract.doors.length!==1||contract.roomIds.length!==1||contract.portalIds.length!==1)throw new Error("shell GLB lost functional building semantics");
console.log(`p_architecture_shell_artifact OK: ${evidence.primitiveCount} shell primitives, functional semantics retained, visible content excluded`);
