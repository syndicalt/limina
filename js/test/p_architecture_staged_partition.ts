import fs from "node:fs";
import { compileArchitecture, partitionCompiledArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";

const spec=JSON.parse(fs.readFileSync("../assets/buildings/functional-hall-house-architecture-v1.json","utf8")) as ArchitectureSpec;
const compiled=compileArchitecture(spec),partition=partitionCompiledArchitecture(spec,compiled);
if(partition.schema!=="limina.staged-architecture-partition/v1")throw new Error("wrong staged partition schema");
if(partition.shell.payload.primitives.some(item=>item.id.startsWith("furnishing/")||item.id.startsWith("domestic-prop/")||/fireplace\/.+\/(flame-|embers|log-)/.test(item.id)))throw new Error("shell retained visible furnishing/prop/fire content");
if(partition.furniturePacks.length!==(spec.furnishings?.length??0)||partition.propPacks.length!==(spec.domesticProps?.length??0))throw new Error("catalog pack partition count drifted");
if(partition.fireRuntime.payload.primitives.length<5||partition.fireRuntime.payload.sockets.length!==compiled.fireplaces.length)throw new Error("fire runtime compatibility artifact is incomplete");
if(!partition.interiorPlan.payload.migrationRequired||partition.interiorPlan.payload.sourceAuthority!=="architecture-spec-compatibility")throw new Error("legacy interior plan was misrepresented as final authority");
const all=[...partition.shell.payload.primitives,...partition.fireRuntime.payload.primitives,...partition.furniturePacks.flatMap(item=>item.payload.primitives),...partition.propPacks.flatMap(item=>item.payload.primitives)];
if(all.length!==compiled.primitives.length||new Set(all.map(item=>item.id)).size!==all.length)throw new Error("staged partition is not exhaustive and exclusive");
for(const stage of [partition.shell,partition.interiorPlan,partition.fireRuntime,...partition.furniturePacks,...partition.propPacks])if(!/^sha256:[0-9a-f]{64}$/.test(stage.payloadHash))throw new Error("stage payload lacks canonical hash");
console.log(`p_architecture_staged_partition OK: shell ${partition.shell.payload.primitives.length}, furniture ${partition.furniturePacks.length}, props ${partition.propPacks.length}, fire ${partition.fireRuntime.payload.primitives.length}; exhaustive ownership`);
