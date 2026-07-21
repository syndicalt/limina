import { ops } from "../src/engine.ts";
import {
  assertMultiRoomReviewCaptureReady,
  resolveFb4V4ReviewDoorPosePlan,
  validateMultiRoomReviewAuthority,
  verifyMultiRoomReviewV4Closure,
} from "../src/render/building-multi-room-review-scene.ts";

const authorityPath = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/review-v4-r1/review-authority.json";
const decoder = new TextDecoder("utf8", { fatal: true });
const read = (path: string): Uint8Array => ops.op_read_asset(path);
const authority = assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(JSON.parse(decoder.decode(read(authorityPath)))));
verifyMultiRoomReviewV4Closure(authority, read);
const poses = resolveFb4V4ReviewDoorPosePlan(authority, read);
if (JSON.stringify(poses.filter((entry) => entry.openDoorIds.length > 0)) !== JSON.stringify([{ reviewViewId: "upper-room", openDoorIds: ["door/landing-front"] }])) throw new Error("FB-4 native host door-pose closure drifted");
console.log("p_fb4_v4_native_host_closure OK: exact V4 articulation, semantic, site, tool, camera, and door-pose authority recomputes under the native host before engine creation");
