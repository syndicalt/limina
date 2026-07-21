import assert from "node:assert/strict";
import fs from "node:fs";
import { assertFb4V4EvidenceCameraIntent } from "../../tools/architecture/build-fb4-multi-room-site-review.ts";

const path = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/functional-hall-house-fb4-multi-room.glb.architecture.json";
const architecture = JSON.parse(fs.readFileSync(path, "utf8"));
assert.doesNotThrow(() => assertFb4V4EvidenceCameraIntent(architecture));

const missingWestWindow = structuredClone(architecture);
missingWestWindow.primitives = missingWestWindow.primitives.filter((item: { id: string }) => item.id !== "window/space/bedroom-a/1/glass");
assert.throws(() => assertFb4V4EvidenceCameraIntent(missingWestWindow), /west-gable windows/);

const missingFrontPortal = structuredClone(architecture);
missingFrontPortal.functionalContract.portals = missingFrontPortal.functionalContract.portals.filter((entry: { id: string }) => entry.id !== "portal/landing-front");
assert.throws(() => assertFb4V4EvidenceCameraIntent(missingFrontPortal), /front portal/);

const missingTopLanding = structuredClone(architecture);
missingTopLanding.primitives = missingTopLanding.primitives.filter((item: { id: string }) => item.id !== "stairs/stairs/primary/landing-top");
assert.throws(() => assertFb4V4EvidenceCameraIntent(missingTopLanding), /return flights, landings, or approaches/);

const missingTurnLanding = structuredClone(architecture);
missingTurnLanding.primitives = missingTurnLanding.primitives.filter((item: { id: string }) => item.id !== "stairs/stairs/primary/landing-intermediate-0");
assert.throws(() => assertFb4V4EvidenceCameraIntent(missingTurnLanding), /return flights, landings, or approaches/);

const missingApproachSockets = structuredClone(architecture);
delete missingApproachSockets.functionalContract.verticalLinks[0].approaches;
assert.throws(() => assertFb4V4EvidenceCameraIntent(missingApproachSockets), /return flights, landings, or approaches/);

const blockedStairSightline = structuredClone(architecture);
blockedStairSightline.primitives.push({ id: "wall-interior/test/stair-camera-occluder", kind: "box", center: [1.5, 2.1, 0], halfExtents: [0.1, 2, 3] });
assert.throws(() => assertFb4V4EvidenceCameraIntent(blockedStairSightline), /wall sightline is occluded/);

const closedStairOpening = structuredClone(architecture);
closedStairOpening.primitives.push({ id: "volume/volume/storey-upper/floor-fragment-test", kind: "polygon-slab", boundary: [[3.3, -1], [4.3, -1], [4.3, 1], [3.3, 1]], bottomY: 3.3, topY: 3.46 });
assert.throws(() => assertFb4V4EvidenceCameraIntent(closedStairOpening), /upper-floor stair opening/);

console.log("p_fb4_v4_camera_intent OK: gable, upper-room, and dogleg-stair views are mechanically bound to claimed apertures, all landings and approaches, open floor, frustum, and unobstructed wall sightlines");
