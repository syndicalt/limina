import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFireReviewAuthorityR2 } from "./build-fire-review-authority-r2.mjs";

export const FIRE_REVIEW_R3_DEFAULTS = Object.freeze({
  contract: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-contract.json",
  artifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-artifact-draft.json",
  output: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-review-authority-r2.json",
});

export function buildFireReviewAuthorityR3({ repoRoot = resolve(import.meta.dirname, "../.."), paths = {}, write = true } = {}) {
  return buildFireReviewAuthorityR2({ repoRoot, paths: { ...FIRE_REVIEW_R3_DEFAULTS, ...paths }, write });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireReviewAuthorityR3(); console.log(JSON.stringify({ schema: result.authority.schema, revision: result.authority.fireStage.contract.revision, frames: result.authority.evidenceFrames.length, output: result.output }, null, 2));
}
