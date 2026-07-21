import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compileArchitecture,
  partitionCompiledArchitecture,
  serializeBlenderShellInput,
  type ArchitectureSpec,
} from "../../js/src/architecture/index.ts";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { resolveBlender } from "./blender-toolchain.mjs";

const args = process.argv.slice(2),
  at = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1])
      throw new Error(
        "usage: bun tools/architecture/build-shell.ts --spec <json> --out <glb> --blend-out <blend> --evidence <json>",
      );
    return resolve(args[index + 1]);
  };
const specPath = at("--spec"),
  outputPath = at("--out"),
  blendOutputPath = at("--blend-out"),
  evidencePath = at("--evidence"),
  toolchain = resolveBlender();
const spec = JSON.parse(await readFile(specPath, "utf8")) as ArchitectureSpec,
  compiled = compileArchitecture(spec),
  partition = partitionCompiledArchitecture(spec, compiled),
  payload = serializeBlenderShellInput(partition, compiled),
  inputPath = `${outputPath}.shell.json`;
await Promise.all([
  mkdir(dirname(outputPath), { recursive: true }),
  mkdir(dirname(blendOutputPath), { recursive: true }),
  mkdir(dirname(evidencePath), { recursive: true }),
]);
await writeFile(inputPath, payload + "\n", { mode: 0o600 });
const adapterPath = new URL("../blender/architecture-adapter.py", import.meta.url).pathname,
  run = Bun.spawnSync(
    [
      toolchain.binary,
      "--background",
      "--factory-startup",
      "--python",
      adapterPath,
      "--",
      "--input",
      inputPath,
      "--out",
      outputPath,
      "--blend-out",
      blendOutputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
if (run.exitCode !== 0) throw new Error(`shell Blender adapter failed (${run.exitCode})\n${run.stderr.toString()}`);
const validatorPath = new URL("../blender/validate-architecture-blend.py", import.meta.url).pathname,
  validation = Bun.spawnSync(
    [
      toolchain.binary,
      "--background",
      blendOutputPath,
      "--python",
      validatorPath,
      "--",
      "--spec-hash",
      compiled.specHash,
      "--ir-hash",
      partition.shell.payloadHash,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
if (validation.exitCode !== 0)
  throw new Error(`shell source blend validation failed (${validation.exitCode})\n${validation.stderr.toString()}`);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
  asset = await readFile(outputPath),
  blend = await readFile(blendOutputPath),
  functional = parseFunctionalBuildingContract(asset);
const evidence = {
  schema: "limina.building-shell-build-evidence/v1",
  sourceSpecHash: compiled.specHash,
  sourceIrHash: compiled.irHash,
  shellPayloadHash: partition.shell.payloadHash,
  toolchain,
  adapterSha256: digest(await readFile(adapterPath)),
  asset: { path: outputPath, sha256: `sha256:${digest(asset)}`, bytes: asset.length },
  sourceBlend: { path: blendOutputPath, sha256: `sha256:${digest(blend)}`, bytes: blend.length },
  functional: {
    buildingId: functional.buildingId,
    rooms: functional.roomIds.length,
    portals: functional.portalIds.length,
    colliders: functional.colliders.length,
    doors: functional.doors.length,
  },
  exclusions: { furniture: true, domesticProps: true, fireVisuals: true, practicalLights: true },
  primitiveCount: partition.shell.payload.primitives.length,
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
