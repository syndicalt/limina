import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateStagedMaterialReviewAuthority } from "../../js/src/render/staged-material-review-scene.ts";

export const BALANCED_M1_STUDIO_LIGHTING = Object.freeze({
  ambientColor: 0xe9edf2,
  ambientIntensity: 1.2,
  directionalColor: 0xfff4e2,
  directionalIntensity: 1.1,
  direction: Object.freeze([5, 8, 6]),
});

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function buildBalancedMaterialReviewAuthority(source) {
  const authority = validateStagedMaterialReviewAuthority(source);
  if (!authority.evidenceViews.some((view) => view.id === "roof-dormer-eave-continuity")) throw new Error("balanced M1 authority requires the roof continuity evidence view");
  return validateStagedMaterialReviewAuthority({
    ...authority,
    presentation: { ...authority.presentation, lighting: BALANCED_M1_STUDIO_LIGHTING },
  });
}

export async function writeBalancedMaterialReviewAuthority({
  repoRoot = resolve(import.meta.dirname, "../.."),
  sourcePath = "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-authority.json",
  outputPath = "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-authority-v2.json",
} = {}) {
  const repo = resolve(repoRoot), sourceBytes = await readFile(resolve(repo, sourcePath));
  const authority = buildBalancedMaterialReviewAuthority(JSON.parse(sourceBytes));
  const bytes = jsonBytes(authority);
  await writeFile(resolve(repo, outputPath), bytes, { mode: 0o600, flag: "wx" });
  return Object.freeze({ authority, sourceSha256: sha(sourceBytes), outputSha256: sha(bytes) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await writeBalancedMaterialReviewAuthority();
  console.log(JSON.stringify({ schema: result.authority.schema, views: result.authority.evidenceViews.length, sourceSha256: result.sourceSha256, outputSha256: result.outputSha256, lighting: result.authority.presentation.lighting }, null, 2));
}
