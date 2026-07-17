export const PRODUCTION_REVIEW_SITE_V4=Object.freeze({position:Object.freeze([106.25,0,50.25]),yaw:1.175});

const LOCAL_VIEWS=Object.freeze([
  Object.freeze({id:"exterior-three-quarter",role:"judge complete silhouette, joined roofs, timber/stone/material depth, dormer and chimney",camera:Object.freeze({position:Object.freeze([10.8,6.4,-12.5]),target:Object.freeze([0,3,0]),fovDeg:45,near:.05,far:180})}),
  Object.freeze({id:"entry-door-stairs",role:"inspect articulated door, threshold, aligned stairs, porch joinery and ground contact",camera:Object.freeze({position:Object.freeze([1.5,2.25,-8.4]),target:Object.freeze([-.35,1.65,-3.2]),fovDeg:42,near:.03,far:180})}),
  Object.freeze({id:"interior-overall",role:"review enterable hall coherence, circulation, furnishing placement and interior lighting",camera:Object.freeze({position:Object.freeze([-.2,2.05,-2.7]),target:Object.freeze([0,1.45,1.8]),fovDeg:58,near:.03,far:180})}),
  Object.freeze({id:"hearth-fire-seating",role:"review completed firebox, deterministic volumetric fire, fuel, mantel and settle arrangement",camera:Object.freeze({position:Object.freeze([4.2,1.75,.9]),target:Object.freeze([2.15,1.25,2.5]),fovDeg:48,near:.03,far:180})}),
  Object.freeze({id:"dining-service",role:"review dining proportions, chair/table clearance, service storage and cohesive lived-in detail",camera:Object.freeze({position:Object.freeze([-5,2.15,1.7]),target:Object.freeze([-2.2,1.15,-.6]),fovDeg:50,near:.03,far:180})}),
]);

function worldPoint([x,y,z]){const {position,yaw}=PRODUCTION_REVIEW_SITE_V4,c=Math.cos(yaw),s=Math.sin(yaw);return Object.freeze([position[0]+x*c+z*s,y,position[2]-x*s+z*c]);}
export const PRODUCTION_REVIEW_VIEWS_V4=Object.freeze(LOCAL_VIEWS.map(view=>Object.freeze({...view,camera:Object.freeze({...view.camera,position:worldPoint(view.camera.position),target:worldPoint(view.camera.target)})})));
