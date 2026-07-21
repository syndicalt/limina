import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { evaluateFixedCameraRegression } from "../../js/src/render/fixed-camera-regression.ts";

const [candidateArgument] = process.argv.slice(2);
if (!candidateArgument) {
  throw new Error("usage: node tools/preview/compare-native-temperate-fidelity.mjs CANDIDATE.png");
}
const repo = resolve(import.meta.dirname, "../..");
const authority = JSON.parse(await readFile(resolve(repo, "art-direction/temperate-fidelity-native-regression.json"), "utf8"));
if (authority.schema !== "limina.fixed-camera-regression-authority/v1"
    || authority.referenceSetId !== "project-gorgon-floor-20260711"
    || authority.cameraRoute !== "river-leading-line") {
  throw new Error("fixed-camera regression authority has the wrong schema, reference set, or camera route");
}
const policy = authority.policy;

async function loadRgba(argument) {
  const path = resolve(repo, argument);
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`${path} did not decode to RGBA8`);
  return { path, width: info.width, height: info.height, rgba: new Uint8Array(data) };
}

const baselinePath = resolve(repo, "assets", authority.candidateBaseline.assetId);
const baselineBytes = await readFile(baselinePath);
const baselineSha256 = createHash("sha256").update(baselineBytes).digest("hex");
if (baselineBytes.byteLength !== authority.candidateBaseline.byteLength
    || baselineSha256 !== authority.candidateBaseline.sha256) {
  throw new Error("fixed-camera candidate baseline bytes drifted from regression authority");
}
const baseline = await loadRgba(baselinePath);
const candidate = await loadRgba(candidateArgument);
if (baseline.width !== authority.candidateBaseline.width || baseline.height !== authority.candidateBaseline.height) {
  throw new Error("fixed-camera candidate baseline dimensions drifted from regression authority");
}
if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
  throw new Error(`fixed-camera dimensions differ: ${baseline.width}x${baseline.height} != ${candidate.width}x${candidate.height}`);
}
const evaluation = evaluateFixedCameraRegression({
  width: baseline.width,
  height: baseline.height,
  baselineRgba: baseline.rgba,
  candidateRgba: candidate.rgba,
  policy,
});
console.log(JSON.stringify({
  schema: "limina.fixed-camera-regression-result/v1",
  authority: "art-direction/temperate-fidelity-native-regression.json",
  candidateBaselineSha256: baselineSha256,
  baseline: baseline.path,
  candidate: candidate.path,
  resolution: [baseline.width, baseline.height],
  policy,
  ...evaluation,
  interpretation: authority.interpretation,
}, null, 2));
if (!evaluation.passed) process.exitCode = 1;
