export const PRODUCTION_REVIEW_SITE_V5=Object.freeze({position:Object.freeze([106.25,0,50.25]),yaw:1.175});

// Local-space production cameras. Interior views reuse the exact, human-approved
// C1 r3 v2 composition cameras instead of inventing unverified wall-adjacent shots.
const LOCAL_VIEWS=Object.freeze([
  Object.freeze({id:"exterior-three-quarter",role:"judge complete silhouette, joined roofs, timber/stone/material depth, dormer and chimney",camera:Object.freeze({position:Object.freeze([10.8,6.4,-12.5]),target:Object.freeze([0,3,0]),fovDeg:45,near:.05,far:180})}),
  Object.freeze({id:"entry-door-stairs",role:"inspect articulated door, threshold, aligned stairs, porch joinery and ground contact",camera:Object.freeze({position:Object.freeze([-.72,1.7,-7.5]),target:Object.freeze([-.72,1.2,-3.66]),fovDeg:48,near:.03,far:180})}),
  Object.freeze({id:"interior-overall",role:"review whole-room furnishing hierarchy, circulation, scale and interior lighting",camera:Object.freeze({position:Object.freeze([-.45,2.3,-2.9]),target:Object.freeze([0,.82,.25]),fovDeg:80,near:.03,far:180})}),
  Object.freeze({id:"hearth-fire-seating",role:"review completed firebox, deterministic volumetric fire, fuel, mantel, settle and hearth clearance",camera:Object.freeze({position:Object.freeze([-1.65,1.65,.35]),target:Object.freeze([2.75,.82,.9]),fovDeg:64,near:.03,far:180})}),
  Object.freeze({id:"dining-service",role:"review dining proportions, four-chair clearance and cohesive lived-in detail",camera:Object.freeze({position:Object.freeze([-1.05,1.58,-2.5]),target:Object.freeze([-3,.68,-.8]),fovDeg:58,near:.03,far:180})}),
]);

function worldPoint([x,y,z]){const {position,yaw}=PRODUCTION_REVIEW_SITE_V5,c=Math.cos(yaw),s=Math.sin(yaw);return Object.freeze([position[0]+x*c+z*s,y,position[2]-x*s+z*c]);}
export const PRODUCTION_REVIEW_LOCAL_VIEWS_V5=LOCAL_VIEWS;
export const PRODUCTION_REVIEW_VIEWS_V5=Object.freeze(LOCAL_VIEWS.map(view=>Object.freeze({...view,camera:Object.freeze({...view.camera,position:worldPoint(view.camera.position),target:worldPoint(view.camera.target)})})));
