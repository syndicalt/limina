import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const repo = resolve(import.meta.dirname, "../..");

export async function buildShellStageArtifact({ evidencePath, outputPath, artifactId = "shell/functional-hall-house-v4/r1", revision = 1, repoRoot = repo }) {
  const root = resolve(repoRoot), evidenceFile = resolve(root, evidencePath), out = resolve(root, outputPath);
  if (!Number.isSafeInteger(revision) || revision < 1 || !artifactId.endsWith(`/r${revision}`)) throw new Error("shell artifact id and revision must form the same positive append-only revision");
  const localPortable = (path) => relative(root, path).split(sep).join("/");
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  if (evidence.schema !== "limina.building-shell-build-evidence/v1") throw new Error("unsupported shell evidence schema");
  for (const key of ["furniture", "domesticProps", "fireVisuals", "practicalLights"]) if (evidence.exclusions?.[key] !== true) throw new Error(`shell must exclude ${key}`);
  const glbPath = resolve(root, evidence.asset.path), blendPath = resolve(root, evidence.sourceBlend.path);
  const [glb, blend] = await Promise.all([readFile(glbPath), readFile(blendPath)]);
  if (digest(glb) !== evidence.asset.sha256 || digest(blend) !== evidence.sourceBlend.sha256) throw new Error("shell evidence source hashes drifted");
  const contractHash = evidence.shellPayloadHash;
  const facets = BUILDING_STAGE_FACETS.shell.map((scope) => ({ scope, hash: digest(JSON.stringify({ schema: "limina.shell-facet/v1", scope, contractHash, contentHash: evidence.asset.sha256 })) }));
  const artifact = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1", artifactId, kind: "shell", revision,
    ...(revision > 1 ? { supersedes: artifactId.replace(/\/r\d+$/, `/r${revision - 1}`) } : {}),
    status: "draft", contractHash, contentHash: evidence.asset.sha256, facets, inputs: [], evidence: [],
    metadata: {
      gate: "A1-shell", humanDecision: "not-reviewed-as-staged-shell", buildEvidencePath: localPortable(evidenceFile),
      sourceBlend: { path: localPortable(blendPath), sha256: evidence.sourceBlend.sha256 },
      runtimeGlb: { path: localPortable(glbPath), sha256: evidence.asset.sha256 },
      functional: evidence.functional, exclusions: evidence.exclusions, toolchain: evidence.toolchain,
    },
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600, flag: revision === 1 ? "w" : "wx" });
  return artifact;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), value = (flag, fallback) => { const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1]; };
  const evidencePath = value("--evidence"), outputPath = value("--out");
  if (!evidencePath || !outputPath) throw new Error("usage: node tools/architecture/build-shell-stage-artifact.mjs --evidence <json> --out <json> [--artifact-id <id/rN> --revision <N>]");
  const artifact = await buildShellStageArtifact({ evidencePath, outputPath, artifactId: value("--artifact-id", undefined), revision: value("--revision", undefined) === undefined ? undefined : Number(value("--revision")) });
  console.log(JSON.stringify({ artifactId: artifact.artifactId, status: artifact.status, contentHash: artifact.contentHash, sourceBlendHash: artifact.metadata.sourceBlend.sha256 }, null, 2));
}
