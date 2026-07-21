import fs from "node:fs";
import {
  createSiteReviewDiscretePopulationExclusion,
  derivePopulationMaximumHorizontalReach,
  validateBuildingSiteReviewEnvelope,
  verifySiteReviewCameras,
  verifySiteReviewRuntimePack,
} from "../src/render/building-site-review-envelope.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";

const bytes = fs.readFileSync("assets/biomes/temperate-fidelity-runtime-pack.json"),
  pack = JSON.parse(bytes.toString("utf8")),
  raw = `sha256:${sha256(bytes)}` as const;
const envelope = validateBuildingSiteReviewEnvelope({
  schema: "limina.building-site-review-envelope/v1",
  runtimePack: {
    path: "assets/biomes/temperate-fidelity-runtime-pack.json",
    sha256: raw,
    contentHash: portableAssetContentHash(bytes),
  },
  populationMaximumHorizontalReachM: 8.85,
  discretePopulationExclusion: {
    structure: "authored-footprint-plus-vegetation-clearance-plus-population-reach",
    cameraLineOfSight: "camera-to-subject-footprint-sweep-plus-population-reach",
    exteriorViewIds: ["exterior"],
  },
  subjectBounds: { minimum: [-4, 0, -3], maximum: [4, 8, 3] },
  cameraChecks: {
    minimumProjectedAreaFraction: 0.02,
    minimumProjectedHeightFraction: 0.1,
    maximumFullSubjectHeightFraction: 0.95,
    fullSubjectViewIds: ["exterior"],
    terrainRaySampleSpacingM: 0.5,
    minimumTerrainClearanceM: 0.1,
    interiorViewIds: ["interior"],
  },
});
const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_building_site_review_envelope FAIL: ${message}`);
};
assert(
  derivePopulationMaximumHorizontalReach(pack) === 8.85 && verifySiteReviewRuntimePack(envelope, bytes) === 8.85,
  "runtime-pack maximum canopy reach is not exact",
);
const contract: any = {
    site: {
      footprintCenter: [0, 0],
      footprintHalfExtents: [4, 3],
      finishedFloorY: 0,
      terrainClearance: 0.1,
      vegetationClearance: 1.2,
      maximumTerrainRelief: 1,
    },
  },
  views: any = [
    { id: "exterior", camera: { position: [0, 5, -20], target: [0, 4, 0], fovDeg: 50, near: 0.1, far: 200 } },
    { id: "interior", camera: { position: [0, 2, 0], target: [0, 2, 2], fovDeg: 60, near: 0.1, far: 100 } },
  ],
  excluded = createSiteReviewDiscretePopulationExclusion({ envelope, contract, position: [0, 0, 0], yaw: 0, views });
assert(
  excluded(0, 0) && excluded(0, -12) && !excluded(30, 30),
  "canopy-aware structure/camera sweep exclusion is incorrect",
);
const evidence = verifySiteReviewCameras({
  envelope,
  position: [0, 0, 0],
  yaw: 0,
  rootWorldY: 1,
  views,
  width: 1920,
  height: 1080,
  sampleHeight: () => 0,
});
assert(
  evidence.views.length === 2 &&
    evidence.views[0].projectedAreaFraction >= 0.02 &&
    evidence.views[1].interiorContained === true,
  "camera coverage/containment evidence is incomplete",
);
let failed = false;
try {
  verifySiteReviewCameras({
    envelope,
    position: [0, 0, 0],
    yaw: 0,
    rootWorldY: 1,
    views: [{ ...views[0], camera: { ...views[0].camera, position: [0, 5, -200] } }],
    width: 1920,
    height: 1080,
    sampleHeight: () => 0,
  });
} catch {
  failed = true;
}
assert(failed, "undersized subject coverage did not fail closed");
failed = false;
try {
  verifySiteReviewCameras({
    envelope,
    position: [0, 0, 0],
    yaw: 0,
    rootWorldY: 1,
    views,
    width: 1920,
    height: 1080,
    sampleHeight: () => 10,
  });
} catch {
  failed = true;
}
assert(failed, "terrain-occluded camera ray did not fail closed");
console.log(
  "p_building_site_review_envelope OK: exact 8.85m canopy reach, structure/camera sweep, projected coverage, interior containment, and terrain LOS are CPU fail-closed",
);
