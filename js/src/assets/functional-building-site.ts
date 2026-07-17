import type { FunctionalBuildingContract, FunctionalBuildingSite } from "./functional-building-contract.ts";

export interface FunctionalBuildingSitePlacement {
  readonly rootWorldY: number;
  readonly rootY: number;
  readonly terrainMinimum: number;
  readonly terrainMaximum: number;
  readonly terrainRelief: number;
  readonly sampleCount: number;
  readonly entranceSupport?: {
    readonly terrainMinimum: number;
    readonly terrainMaximum: number;
    readonly terrainVariation: number;
    readonly worldGradeY: number;
    readonly fillDepth: number;
    readonly cutDepth: number;
    readonly sampleCount: number;
  };
  readonly containsWorldXZ: (x: number, z: number) => boolean;
}

function worldFromLocal(centerX: number, centerZ: number, yaw: number, x: number, z: number): readonly [number, number] {
  const c=Math.cos(yaw),s=Math.sin(yaw);
  return [centerX+x*c+z*s,centerZ-x*s+z*c];
}

/** Resolve one rigid building against the complete authored footprint. The highest terrain sample
 * controls the finished-floor datum; excessive relief fails instead of burying or floating a house. */
export function resolveFunctionalBuildingSitePlacement(input: Readonly<{
  contract: FunctionalBuildingContract;
  position: readonly [number, number, number];
  yaw: number;
  sampleHeight: (x: number, z: number) => number | undefined;
  maximumSampleSpacing?: number;
}>): FunctionalBuildingSitePlacement {
  const site: FunctionalBuildingSite | undefined=input.contract.site;
  if(site===undefined)throw new Error("functional building site: asset lacks authored site authority");
  if(!Number.isFinite(input.yaw)||!input.position.every(Number.isFinite))throw new Error("functional building site: placement must be finite");
  const spacing=input.maximumSampleSpacing??.5;
  if(!Number.isFinite(spacing)||spacing<=0||spacing>1)throw new Error("functional building site: sample spacing must be in (0,1]");
  const [halfX,halfZ]=site.footprintHalfExtents,[offsetX,offsetZ]=site.footprintCenter;
  const stepsX=Math.max(1,Math.ceil(halfX*2/spacing)),stepsZ=Math.max(1,Math.ceil(halfZ*2/spacing));
  let minimum=Infinity,maximum=-Infinity,sampleCount=0;
  for(let iz=0;iz<=stepsZ;iz++)for(let ix=0;ix<=stepsX;ix++){
    const localX=offsetX-halfX+halfX*2*ix/stepsX,localZ=offsetZ-halfZ+halfZ*2*iz/stepsZ;
    const [x,z]=worldFromLocal(input.position[0],input.position[2],input.yaw,localX,localZ),height=input.sampleHeight(x,z);
    if(height===undefined||!Number.isFinite(height))throw new Error(`functional building site: footprint leaves resident terrain at ${x},${z}`);
    minimum=Math.min(minimum,height);maximum=Math.max(maximum,height);sampleCount++;
  }
  const relief=maximum-minimum;
  if(relief>site.maximumTerrainRelief+1e-9)throw new Error(`functional building site: terrain relief ${relief.toFixed(3)}m exceeds ${site.maximumTerrainRelief.toFixed(3)}m`);
  const rootY=maximum+site.terrainClearance-site.finishedFloorY+input.position[1];
  let entranceSupport: FunctionalBuildingSitePlacement["entranceSupport"];
  if (site.entranceSupport) {
    const support=site.entranceSupport,spacing=Math.min(.1,Math.min(...support.halfExtents)),
      stepsX=Math.max(1,Math.ceil(support.halfExtents[0]*2/spacing)),
      stepsZ=Math.max(1,Math.ceil(support.halfExtents[1]*2/spacing)),
      cLocal=Math.cos(support.yawRadians),sLocal=Math.sin(support.yawRadians);
    let supportMinimum=Infinity,supportMaximum=-Infinity,supportSamples=0;
    for(let iz=0;iz<=stepsZ;iz++)for(let ix=0;ix<=stepsX;ix++){
      const sx=-support.halfExtents[0]+support.halfExtents[0]*2*ix/stepsX,
        sz=-support.halfExtents[1]+support.halfExtents[1]*2*iz/stepsZ,
        localX=support.center[0]+sx*cLocal+sz*sLocal,
        localZ=support.center[1]-sx*sLocal+sz*cLocal,
        [x,z]=worldFromLocal(input.position[0],input.position[2],input.yaw,localX,localZ),
        height=input.sampleHeight(x,z);
      if(height===undefined||!Number.isFinite(height))throw new Error(`functional building site: entrance support leaves resident terrain at ${x},${z}`);
      supportMinimum=Math.min(supportMinimum,height);supportMaximum=Math.max(supportMaximum,height);supportSamples++;
    }
    const worldGradeY=rootY+support.exteriorGradeY,
      supportRelief=supportMaximum-supportMinimum,
      fillDepth=Math.max(0,worldGradeY-supportMinimum),
      cutDepth=Math.max(0,supportMaximum-worldGradeY);
    if(supportRelief>support.maximumVariation+1e-9||fillDepth>support.bearingDepth+1e-9||cutDepth>support.maximumCutDepth+1e-9)
      throw new Error(`functional building site: entrance support is unbuildable (variation=${supportRelief.toFixed(3)}m fill=${fillDepth.toFixed(3)}m cut=${cutDepth.toFixed(3)}m)`);
    entranceSupport=Object.freeze({terrainMinimum:supportMinimum,terrainMaximum:supportMaximum,terrainVariation:supportRelief,worldGradeY,fillDepth,cutDepth,sampleCount:supportSamples});
  }
  const clearX=halfX+site.vegetationClearance,clearZ=halfZ+site.vegetationClearance,c=Math.cos(input.yaw),s=Math.sin(input.yaw);
  const containsWorldXZ=(x:number,z:number):boolean=>{const dx=x-input.position[0],dz=z-input.position[2],localX=dx*c-dz*s-offsetX,localZ=dx*s+dz*c-offsetZ;return Math.abs(localX)<=clearX&&Math.abs(localZ)<=clearZ;};
  return Object.freeze({rootWorldY:rootY,rootY,terrainMinimum:minimum,terrainMaximum:maximum,terrainRelief:relief,sampleCount,...(entranceSupport?{entranceSupport}:{}),containsWorldXZ});
}
