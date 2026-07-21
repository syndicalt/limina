/** CPU-side final R1 review composition. Rendering/capture is owned by the guarded native runner. */
import type { WorldContext } from "../skills/registry.ts";
import { mountBuildingProductionPackage, type BuildingProductionPackageMount } from "./building-production-package.ts";
import { verifyBuildingProductionReviewClosure, type BuildingProductionReviewAuthority, type BuildingProductionReviewView } from "./building-production-review-authority.ts";

export interface BuildingProductionReviewMount {
  readonly authority: BuildingProductionReviewAuthority;
  readonly production: BuildingProductionPackageMount;
  readonly fireSample: Readonly<{ phase: string; envelope: number; tick: number }>;
  readonly currentView: BuildingProductionReviewView;
  readonly disposed: boolean;
  setEvidenceView(id: BuildingProductionReviewView["id"]): BuildingProductionReviewView;
  dispose(): Promise<void>;
}

function applyCamera(world:WorldContext,view:BuildingProductionReviewView,terrainRootY:number):void{
  const camera=world.camera as unknown as {position:{set(x:number,y:number,z:number):void};fov?:number;near?:number;far?:number;lookAt(x:number,y:number,z:number):void;updateProjectionMatrix?():void;updateMatrixWorld?(force?:boolean):void};
  camera.position.set(view.camera.position[0],view.camera.position[1]+terrainRootY,view.camera.position[2]);camera.fov=view.camera.fovDeg;camera.near=view.camera.near;camera.far=view.camera.far;camera.lookAt(view.camera.target[0],view.camera.target[1]+terrainRootY,view.camera.target[2]);camera.updateProjectionMatrix?.();camera.updateMatrixWorld?.(true);
}

/** Verify exact frozen authority, mount solely through the production package API, and lock fire time. */
export async function mountBuildingProductionReview(world:WorldContext,authorityValue:unknown,terrainRootY=0):Promise<BuildingProductionReviewMount>{
  const closure=verifyBuildingProductionReviewClosure(authorityValue,(path)=>world.ops.op_read_asset(path)),authority=closure.authority;
  if(!Number.isFinite(terrainRootY))throw new Error("R1 review terrain root height must be finite");
  let production:BuildingProductionPackageMount|undefined,disposed=false,current=authority.evidenceViews[0];
  try{
    production=await mountBuildingProductionPackage(world,closure.manifest,closure.candidate,{position:[authority.placement.position[0],authority.placement.position[1]+terrainRootY,authority.placement.position[2]],yaw:authority.placement.yaw});
    if(!production.fire.start())throw new Error("R1 review fire did not accept deterministic start");
    const fireSample=production.fire.advanceTicks(authority.fire.advanceTicks);
    if(fireSample.phase!==authority.fire.expectedPhase||fireSample.envelope!==authority.fire.expectedEnvelope||fireSample.tick!==authority.fire.advanceTicks)throw new Error("R1 review fire failed deterministic burn schedule");
    applyCamera(world,current,terrainRootY);const mounted=production;
    return Object.freeze({authority,production:mounted,fireSample,get currentView(){return current;},get disposed(){return disposed;},
      setEvidenceView(id: BuildingProductionReviewView["id"]){if(disposed)throw new Error("R1 review mount is disposed");const view=authority.evidenceViews.find((candidate)=>candidate.id===id);if(view===undefined)throw new Error(`unknown R1 evidence view ${id}`);current=view;applyCamera(world,view,terrainRootY);return view;},
      dispose:async()=>{if(disposed)return;await mounted.dispose();disposed=true;},
    });
  }catch(error){if(production!==undefined)try{await production.dispose();}catch(cleanup){throw new AggregateError([error,cleanup],"R1 review mount failed and cleanup failed");}throw error;}
}
