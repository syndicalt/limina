import type { ArchitectureReviewManifest, ArchitectureReviewStage } from "./schema.ts";
import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
const hash=(value:unknown)=>`sha256:${sha256(canonicalStringify(value))}`;
export function createArchitectureReview(specHash:string,irHash:string,owners:{foundations:string[];walls:string[];frames:string[];roofs:string[];entrances:string[];fireplaces:string[]}):ArchitectureReviewManifest {
  const rows:[ArchitectureReviewStage["id"],string[],string[],string[]][]=[
    ["massing",owners.foundations,["finite-datum","foundation-support"],["massing-hero","foundation-support"]],
    ["envelope",owners.walls,["wall-closure","floor-support","opening-subtraction"],["envelope-exterior","envelope-interior"]],
    ...(owners.frames.length?[["construction-expression",owners.frames,["perceptual-only-claim","facade-contact-graph","aperture-clearance","gable-roof-clearance","lod2-primary-frame"],["frame-front-three-quarter","frame-rear-three-quarter","frame-gable-elevation","frame-entry-window-detail","frame-lod-25m"]] as [ArchitectureReviewStage["id"],string[],string[],string[]]]:[]),
    ["roof-junctions",owners.roofs,["plane-closure","dual-substrate-seams","gable-clearance","penetration-void-closure","chimney-flashing-continuity","penetration-seam-clearance"],["roof-hero","roof-seams"]],
    ["openings-circulation",owners.entrances,["threshold-continuity","monotonic-stairs","door-sweep"],["threshold-detail","portal-sweep"]],
    ["interior-fireplace",owners.fireplaces,["firebox-completeness","fuel-containment","chimney-clearance","continuous-flue-authority"],["interior-open","hearth-detail"]],
    ["materials-uv",[...owners.walls,...owners.roofs],["material-role-closure","uv-phase-continuity"],["materials-exterior","materials-interior"]],
    ["lod-final",[...owners.foundations,...owners.walls,...owners.roofs],["semantic-lod-preservation","runtime-contract","lifecycle-return"],["exterior-closed","exterior-open","threshold-detail","interior-open","lod-25m"]],
  ];let prerequisiteHash:string|undefined;
  const stages=rows.map(([id,requiredOwners,checks,cameraIds])=>{const stage=Object.freeze({id,...(prerequisiteHash?{prerequisiteHash}:{}),requiredOwners:Object.freeze(requiredOwners),checks:Object.freeze(checks),cameraIds:Object.freeze(cameraIds)});prerequisiteHash=hash({schema:"limina.architecture-stage-gate/v1",specHash,irHash,stage});return stage;});
  return Object.freeze({schema:"limina.architecture-review/v1",specHash,irHash,stages:Object.freeze(stages)});
}
