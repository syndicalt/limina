import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { compileArchitecture } from "../../js/src/architecture/compiler.ts";
import { serializeBlenderArchitectureInput } from "../../js/src/architecture/blender-adapter.ts";
import { partitionCompiledArchitecture } from "../../js/src/architecture/staged-partition.ts";
import type { ArchitectureSpec } from "../../js/src/architecture/schema.ts";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingVisualContract } from "../../js/src/assets/functional-building-visual-contract.ts";
import { resolveBlender } from "./blender-toolchain.mjs";
import { batchArchitectureBuilding } from "../asset/batch-architecture-building.mjs";

const args = process.argv.slice(2),
  at = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: bun tools/architecture/build-building.ts --spec <json> --out <glb> --evidence <json> [--lod-out <glb>] [--blend-out <blend>] [--handoff <json>]",
      );
    return resolve(args[i + 1]);
  },
  optional = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0
      ? undefined
      : !args[i + 1]
        ? (() => {
            throw new Error(`${flag} requires a path`);
          })()
        : resolve(args[i + 1]);
  };
const specPath = at("--spec"),
  outputPath = at("--out"),
  evidencePath = at("--evidence"),
  stem = outputPath.slice(0, outputPath.length - extname(outputPath).length),
  lodOutputPath = optional("--lod-out") ?? `${stem}-lod.glb`,
  blendOutputPath = optional("--blend-out") ?? `${stem}.source.blend`,
  handoffPath = optional("--handoff") ?? `${stem}.authoring-handoff.json`,
  stagesOutputPath = optional("--stages-out") ?? `${stem}.stages`,
  logicalFrom = optional("--logical-from"),
  logicalTo = optional("--logical-to"),
  toolchain = resolveBlender();
if ((logicalFrom === undefined) !== (logicalTo === undefined))
  throw new Error("--logical-from and --logical-to must be supplied together");
const published = (path: string) =>
  logicalFrom && logicalTo && path.startsWith(`${logicalFrom}/`)
    ? resolve(logicalTo, relative(logicalFrom, path))
    : path;
const spec = JSON.parse(await readFile(specPath, "utf8")) as ArchitectureSpec,
  compiled = compileArchitecture(spec),
  partition = partitionCompiledArchitecture(spec, compiled),
  payload = serializeBlenderArchitectureInput(compiled),
  compiledPath = `${outputPath}.architecture.json`;
await Promise.all([
  mkdir(dirname(outputPath), { recursive: true }),
  mkdir(dirname(lodOutputPath), { recursive: true }),
  mkdir(dirname(blendOutputPath), { recursive: true }),
  mkdir(dirname(handoffPath), { recursive: true }),
  mkdir(stagesOutputPath, { recursive: true }),
  mkdir(dirname(evidencePath), { recursive: true }),
]);
await writeFile(compiledPath, payload + "\n", { mode: 0o600 });
const stageRecords: Array<{ id: string; kind: string; path: string; payloadHash: string; sha256: string }> = [],
  writeStage = async (id: string, kind: string, value: unknown, payloadHash: string) => {
    const safe = id.replaceAll("/", "__"),
      path = resolve(stagesOutputPath, `${safe}.json`),
      bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
    await writeFile(path, bytes, { mode: 0o600 });
    stageRecords.push({ id, kind, path, payloadHash, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
await writeStage("shell", "shell", partition.shell, partition.shell.payloadHash);
await writeStage("interior-plan", "interior-plan", partition.interiorPlan, partition.interiorPlan.payloadHash);
await writeStage("fire-runtime", "fire-runtime", partition.fireRuntime, partition.fireRuntime.payloadHash);
for (const item of partition.furniturePacks)
  await writeStage(`furniture/${item.payload.id}`, "furniture-pack", item, item.payloadHash);
for (const item of partition.propPacks)
  await writeStage(`prop/${item.payload.id}`, "prop-pack", item, item.payloadHash);
const adapterPath = new URL("../blender/architecture-adapter.py", import.meta.url).pathname;
const processResult = Bun.spawnSync(
  [
    toolchain.binary,
    "--background",
    "--factory-startup",
    "--python-exit-code",
    "1",
    "--python",
    adapterPath,
    "--",
    "--input",
    compiledPath,
    "--out",
    outputPath,
    "--blend-out",
    blendOutputPath,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (processResult.exitCode !== 0)
  throw new Error(
    `architecture Blender adapter failed (${processResult.exitCode})\n${processResult.stderr.toString()}`,
  );
const blendValidatorPath = new URL("../blender/validate-architecture-blend.py", import.meta.url).pathname,
  blendValidation = Bun.spawnSync(
    [
      toolchain.binary,
      "--background",
      blendOutputPath,
      "--python-exit-code",
      "1",
      "--python",
      blendValidatorPath,
      "--",
      "--spec-hash",
      compiled.specHash,
      "--ir-hash",
      compiled.irHash,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
if (blendValidation.exitCode !== 0)
  throw new Error(
    `architecture source blend validation failed (${blendValidation.exitCode})\n${blendValidation.stderr.toString()}`,
  );
const validationLine = blendValidation.stdout
  .toString()
  .split(/\r?\n/)
  .find((line) => line.startsWith("LIMINA_BLEND_VALIDATION="));
if (!validationLine) throw new Error("architecture source blend validator returned no canonical report");
const sourceValidation = JSON.parse(validationLine.slice("LIMINA_BLEND_VALIDATION=".length));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
  adapter = await readFile(adapterPath),
  asset = await readFile(outputPath),
  blend = await readFile(blendOutputPath);
const blendMagic = new TextDecoder().decode(blend.subarray(0, 7)),
  zstdBlend = blend.length >= 4 && blend[0] === 0x28 && blend[1] === 0xb5 && blend[2] === 0x2f && blend[3] === 0xfd;
if (blendMagic !== "BLENDER" && !zstdBlend)
  throw new Error("architecture Blender adapter did not produce a valid source .blend");
const assetSha256 = digest(asset),
  blendSha256 = digest(blend),
  functional = compiled.functionalContract ? parseFunctionalBuildingContract(asset) : undefined,
  visual = compiled.visualContract ? parseFunctionalBuildingVisualContract(asset) : undefined;
const lod = visual ? await batchArchitectureBuilding(outputPath, lodOutputPath, assetSha256) : undefined;
const logical = (path: string) => relative(process.cwd(), published(path)).replaceAll("\\", "/");
const stages = {
  schema: "limina.building-stage-index/v1",
  partitionSchema: partition.schema,
  records: stageRecords
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({ ...item, path: logical(item.path), sha256: `sha256:${item.sha256}` })),
};
const stageIndexPath = resolve(stagesOutputPath, "index.json");
await writeFile(stageIndexPath, JSON.stringify(stages, null, 2) + "\n", { mode: 0o600 });
const stageIndexBytes = await readFile(stageIndexPath);
const handoff = {
  schema: "limina.blender-authoring-handoff/v1",
  assetId: functional?.buildingId ?? spec.id,
  canonicalSource: "blend+recipe",
  genericGltfExportAllowed: false,
  editPolicyVersion: 1,
  modifierPreservation: "partial/applied-edge-easing",
  sourceBlend: { path: logical(blendOutputPath), sha256: `sha256:${blendSha256}`, bytes: blend.length },
  recipe: { path: logical(specPath), schema: spec.schema, specHash: compiled.specHash, irHash: compiled.irHash },
  stageIndex: {
    path: logical(stageIndexPath),
    sha256: `sha256:${digest(stageIndexBytes)}`,
    records: stageRecords.length,
  },
  toolchain,
  adapter: { path: logical(adapterPath), sha256: `sha256:${digest(adapter)}` },
  semanticInventory: {
    schema: "limina.blender-semantic-inventory/v1",
    count: sourceValidation.semanticCount,
    sha256: sourceValidation.semanticInventorySha256,
    collections: sourceValidation.collections,
  },
  derived: {
    sourceGlb: { path: logical(outputPath), sha256: `sha256:${assetSha256}`, bytes: asset.length },
    ...(lod ? { lodGlb: { path: logical(lodOutputPath), sha256: `sha256:${lod.sha256}`, bytes: lod.bytes } } : {}),
  },
};
await writeFile(handoffPath, JSON.stringify(handoff, null, 2) + "\n", { mode: 0o600 });
const handoffBytes = await readFile(handoffPath);
const evidence = {
  schema: "limina.architecture-build-evidence/v1",
  specPath: published(specPath),
  specHash: compiled.specHash,
  irHash: compiled.irHash,
  compilerSchema: compiled.schema,
  blender: toolchain,
  adapterSha256: digest(adapter),
  assetSha256,
  authoring: {
    blendOutputPath: published(blendOutputPath),
    blendSha256,
    handoffPath: published(handoffPath),
    handoffSha256: digest(handoffBytes),
  },
  ...(lod ? { lod: { ...lod, outputPath: published(lodOutputPath) } } : {}),
  ...(functional
    ? {
        functional: {
          buildingId: functional.buildingId,
          rooms: functional.roomIds.length,
          portals: functional.portalIds.length,
          colliders: functional.colliders.length,
          doors: functional.doors.length,
        },
      }
    : {}),
  ...(visual
    ? {
        visual: {
          openings: visual.openings.length,
          materialRoles: visual.materialRoles.length,
          furnishings: visual.interior.furnishingNodeIds.length,
          lodIdentity: visual.lod.identity,
        },
      }
    : {}),
  review: compiled.review,
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...evidence, output: outputPath, evidence: evidencePath }, null, 2));
