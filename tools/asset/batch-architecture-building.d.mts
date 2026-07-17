export interface ArchitectureLodMeasurement { level:0|1|2; triangles:number; draws:number; sourcePrimitiveCount:number }
export interface ArchitectureLodEvidence { sha256:string; bytes:number; sourceSha256:string; measurements:ArchitectureLodMeasurement[] }
export function batchArchitectureBuilding(input:string,output:string,expectedSha256?:string):Promise<ArchitectureLodEvidence>;
