import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { synthesizeTimberHallHouse } from "../../js/src/architecture/building-program-synthesizer.ts";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const PROGRAM = "assets/buildings/programs/functional-hall-house-fb4-program-v1.json";
const BUILD_SOURCE_AUTHORITIES = [
  "tools/architecture/build-fb4-multi-room-candidate.ts",
  "tools/architecture/build-building.ts",
  "tools/architecture/blender-toolchain.mjs",
  "tools/blender/architecture-adapter.py",
  "tools/blender/validate-architecture-blend.py",
  "tools/asset/batch-architecture-building.mjs",
  "js/src/architecture/building-program.ts",
  "js/src/architecture/building-program-synthesizer.ts",
  "js/src/architecture/schema.ts",
  "js/src/architecture/compiler.ts",
  "js/src/architecture/blender-adapter.ts",
  "js/src/architecture/staged-partition.ts",
  "js/src/architecture/stages.ts",
  "js/src/authoring/canonical.ts",
  "js/src/world/sha256.mjs",
  "js/src/world/asset-content-hash.mjs",
  "js/src/assets/functional-building-contract.ts",
  "js/src/assets/functional-building-visual-contract.ts",
] as const;
const MATERIAL_PACKS = ["cottage-fieldstone", "cottage-white-plaster", "cottage-structural-oak", "cottage-worn-planks", "cottage-grey-roof", "cottage-medieval-brick"] as const;
const raw = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const logical = (path: string) => path.slice(ROOT.length + 1).replaceAll("\\", "/");

async function missing(path: string): Promise<void> {
  try { await access(path); throw new Error(`append-only FB-4 candidate already exists: ${logical(path)}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

const programBytes = await readFile(resolve(ROOT, PROGRAM));
const synthesis = synthesizeTimberHallHouse(JSON.parse(programBytes.toString("utf8")));
const selected = synthesis.candidates[0];
if (!selected) throw new Error(`FB-4 synthesis produced no compiler-valid candidate:\n${JSON.stringify(synthesis.rejections, null, 2)}`);
const { spec, compiled } = selected;
const materialAuthorityPaths = new Set<string>();
for (const pack of MATERIAL_PACKS) {
  const manifestPath = `assets/materials/${pack}/material-pack.json`, manifest = JSON.parse(await readFile(resolve(ROOT, manifestPath), "utf8"));
  materialAuthorityPaths.add(manifestPath);
  for (const record of Object.values(manifest.maps) as { assetId: string }[]) materialAuthorityPaths.add(`assets/${record.assetId}`);
}
const authorityPaths = [...BUILD_SOURCE_AUTHORITIES, ...materialAuthorityPaths].sort();
const buildAuthority = await Promise.all(authorityPaths.map(async (path) => {
  const bytes = await readFile(resolve(ROOT, path));
  return Object.freeze({ path, sha256: raw(bytes), bytes: bytes.byteLength });
}));
const buildClosure = createHash("sha256").update(raw(programBytes)).update(synthesis.programHash)
  .update(synthesis.rulebookHash).update(selected.manifest.decisionHash).update(compiled.specHash).update(compiled.irHash);
for (const record of buildAuthority) buildClosure.update(record.path).update(record.sha256);
const buildClosureHash = `sha256:${buildClosure.digest("hex")}`;
const suffix = buildClosureHash.slice("sha256:".length, "sha256:".length + 12);
const relativeRoot = `assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-${suffix}`;
const finalRoot = resolve(ROOT, relativeRoot);
const stagingRoot = `${finalRoot}.staging-${process.pid}`;
await missing(finalRoot);
await missing(stagingRoot);
await mkdir(stagingRoot, { recursive: false, mode: 0o700 });

const paths = {
  spec: resolve(stagingRoot, "architecture-spec.json"),
  synthesis: resolve(stagingRoot, "synthesis-evidence.json"),
  glb: resolve(stagingRoot, "functional-hall-house-fb4-multi-room.glb"),
  lod: resolve(stagingRoot, "functional-hall-house-fb4-multi-room-lod.glb"),
  blend: resolve(stagingRoot, "functional-hall-house-fb4-multi-room.source.blend"),
  handoff: resolve(stagingRoot, "authoring-handoff.json"),
  evidence: resolve(stagingRoot, "build-evidence.json"),
  stages: resolve(stagingRoot, "stages"),
};

try {
  await writeFile(paths.spec, `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(paths.synthesis, `${JSON.stringify({
    schema: "limina.fb4-program-synthesis-evidence/v1",
    program: { path: PROGRAM, sha256: raw(programBytes) },
    evaluatedDecisionCount: synthesis.evaluatedDecisionCount,
    acceptedDecisionCount: synthesis.acceptedDecisionCount,
    selectedRank: selected.rank,
    selectedDecision: selected.decision,
    selectedScore: selected.score,
    selectedManifest: selected.manifest,
    rankedCandidates: synthesis.candidates.map(({ rank, decision, score, manifest }) => ({ rank, decision, score, manifest })),
    rejections: synthesis.rejections,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const run = Bun.spawnSync([
    process.execPath, "tools/architecture/build-building.ts",
    "--spec", paths.spec, "--out", paths.glb, "--lod-out", paths.lod,
    "--blend-out", paths.blend, "--handoff", paths.handoff,
    "--evidence", paths.evidence, "--stages-out", paths.stages,
  ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`FB-4 Blender build failed (${run.exitCode})\n${run.stdout}\n${run.stderr}`);

  const [specOut, synthesisOut, glb, lod, blend, handoff, evidence] = await Promise.all([
    readFile(paths.spec), readFile(paths.synthesis), readFile(paths.glb), readFile(paths.lod), readFile(paths.blend),
    readFile(paths.handoff), readFile(paths.evidence),
  ]);
  const contract = parseFunctionalBuildingContract(glb);
  if (contract.schema !== "limina.functional-building/v2" || contract.rooms.length !== 5
    || contract.portals.length !== 4 || contract.verticalLinks.length !== 1
    || contract.spawnAnchors.length !== 5 || contract.visibilityCells.length !== 5) {
    throw new Error("FB-4 candidate lost strict multi-room semantic authority");
  }
  const records = [
    ["architectureProgramSynthesis", paths.synthesis, synthesisOut], ["architectureSpec", paths.spec, specOut], ["productionGlb", paths.glb, glb],
    ["lodGlb", paths.lod, lod], ["sourceBlend", paths.blend, blend],
    ["authoringHandoff", paths.handoff, handoff], ["buildEvidence", paths.evidence, evidence],
  ].map(([role, path, bytes]) => Object.freeze({
    role, path: logical(path as string).replace(`.staging-${process.pid}`, ""),
    sha256: raw(bytes as Uint8Array), contentHash: portableAssetContentHash(bytes as Uint8Array),
    bytes: (bytes as Uint8Array).byteLength,
  }));
  const manifest = Object.freeze({
    schema: "limina.fb4-multi-room-production-candidate/v2",
    status: "cpu-verified-human-pending",
    candidateId: `functional-hall-house/fb4/${suffix}`,
    programAuthority: Object.freeze({ path: PROGRAM, sha256: raw(programBytes), programHash: synthesis.programHash }),
    synthesis: Object.freeze({ rulebookHash: synthesis.rulebookHash, rank: selected.rank, decisionId: selected.decision.id,
      decisionHash: selected.manifest.decisionHash, evidencePath: logical(paths.synthesis).replace(`.staging-${process.pid}`, "") }),
    compiler: Object.freeze({ schema: compiled.schema, specHash: compiled.specHash, irHash: compiled.irHash }),
    buildAuthority: Object.freeze({ closureHash: buildClosureHash, files: Object.freeze(buildAuthority) }),
    functional: Object.freeze({ schema: contract.schema, buildingId: contract.buildingId, rooms: contract.roomIds,
      portals: contract.portalIds, verticalLinks: contract.verticalLinks.map(({ id }) => id),
      spawnAnchors: contract.spawnAnchors.map(({ id }) => id), visibilityCells: contract.visibilityCells.map(({ id }) => id) }),
    placementSkill: "building.placeFunctional",
    nonEngineApprovalProhibited: true,
    visualApprovalClaimed: false,
    gpuCaptureAtBuild: false,
    files: records,
  });
  await writeFile(resolve(stagingRoot, "candidate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(stagingRoot, finalRoot);
  console.log(JSON.stringify({ candidateRoot: relativeRoot, manifest: `${relativeRoot}/candidate-manifest.json`, irHash: compiled.irHash,
    productionGlb: records.find(({ role }) => role === "productionGlb") }, null, 2));
} catch (error) {
  if (process.env.LIMINA_KEEP_FAILED_STAGING !== "1")
    await rm(stagingRoot, { recursive: true, force: true });
  else console.error(`kept failed staging for diagnostics: ${logical(stagingRoot)}`);
  throw error;
}
