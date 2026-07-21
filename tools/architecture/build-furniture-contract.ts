import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  validateVisualDesignContract,
} from "../../js/src/architecture/index.ts";
import { resolveBlender } from "./blender-toolchain.mjs";
import { inspectFurnitureGlb, parseGlbJson } from "./glb-runtime-geometry.mjs";

const args = process.argv.slice(2),
  at = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: bun tools/architecture/build-furniture-contract.ts --contract <json> --visual <json> --out <glb> --blend-out <blend> --evidence <json>",
      );
    return resolve(args[i + 1]);
  };
const contractPath = at("--contract"),
  visualPath = at("--visual"),
  out = at("--out"),
  blendOut = at("--blend-out"),
  evidencePath = at("--evidence"),
  toolchain = resolveBlender();
const visual = validateVisualDesignContract(JSON.parse(await readFile(visualPath, "utf8"))),
  contract = validateFurnitureDesignContract(JSON.parse(await readFile(contractPath, "utf8")), visual),
  contractHash = furnitureDesignContractHash(contract);
await Promise.all([
  mkdir(dirname(out), { recursive: true }),
  mkdir(dirname(blendOut), { recursive: true }),
  mkdir(dirname(evidencePath), { recursive: true }),
]);
const adapterPath = new URL("../blender/furniture-contract-adapter.py", import.meta.url).pathname,
  validatorPath = new URL("../blender/validate-furniture-contract-blend.py", import.meta.url).pathname;
const run = Bun.spawnSync(
  [
    toolchain.binary,
    "--background",
    "--factory-startup",
    "--python",
    adapterPath,
    "--",
    "--input",
    contractPath,
    "--contract-hash",
    contractHash,
    "--out",
    out,
    "--blend-out",
    blendOut,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (run.exitCode !== 0)
  throw new Error(
    `furniture Blender adapter failed (${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`,
  );
const adapterLine = run.stdout
  .toString()
  .split("\n")
  .find((line) => line.startsWith("LIMINA_FURNITURE_OUTPUT="));
if (!adapterLine)
  throw new Error(
    `furniture Blender adapter did not attest completion\n${run.stdout.toString()}\n${run.stderr.toString()}`,
  );
const adapterOutput = JSON.parse(adapterLine.slice(adapterLine.indexOf("=") + 1));
const validation = Bun.spawnSync(
  [
    toolchain.binary,
    "--background",
    blendOut,
    "--python",
    validatorPath,
    "--",
    "--contract",
    contractPath,
    "--contract-hash",
    contractHash,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (validation.exitCode !== 0)
  throw new Error(
    `furniture source validation failed (${validation.exitCode})\n${validation.stdout.toString()}\n${validation.stderr.toString()}`,
  );
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  glb = await readFile(out),
  blend = await readFile(blendOut),
  adapter = await readFile(adapterPath),
  validator = await readFile(validatorPath);
const document = parseGlbJson(glb),
  extras = document.asset?.extras;
if (
  extras?.liminaFurnitureContractHash !== contractHash ||
  extras?.liminaVisualDesignHash !== contract.visualDesign.hash
)
  throw new Error("exported GLB identity drifted");
if (
  extras?.liminaFurnitureContract?.id !== contract.id ||
  extras?.liminaMaterialSources?.packs?.[0]?.provider !== "Poly Haven"
)
  throw new Error("exported GLB provenance missing");
for (const accessor of document.accessors ?? [])
  for (const field of [accessor.min, accessor.max])
    if (field?.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v)))
      throw new Error("exported GLB has non-finite accessor bounds");
const nodeIds = new Set((document.nodes ?? []).map((node: any) => node.extras?.["limina.id"]).filter(Boolean)),
  expectedIds = new Set([
    contract.id,
    ...contract.parts.map((p) => p.id),
    ...contract.sockets.map((s) => s.id),
    ...contract.colliders.map((c) => c.id),
  ]);
if (nodeIds.size !== expectedIds.size || [...expectedIds].some((id) => !nodeIds.has(id)))
  throw new Error("exported GLB semantic inventory drifted");
const glbBounds = inspectFurnitureGlb(glb, contract).bounds;
const blendValidationLine = validation.stdout
  .toString()
  .split("\n")
  .find((line) => line.startsWith("LIMINA_FURNITURE_BLEND_VALIDATION="));
if (!blendValidationLine) throw new Error("fresh-process validator produced no evidence");
const evidence = {
  schema: "limina.furniture-contract-build-evidence/v1",
  id: contract.id.split("/").slice(-2).join("-"),
  kind: contract.role,
  payloadHash: contractHash,
  sourceSpecHash: contract.visualDesign.hash,
  sourceIrHash: contractHash,
  primitiveCount: contract.parts.length,
  bounds: glbBounds,
  authoringBounds: adapterOutput.bounds,
  contract: { path: contractPath, hash: contractHash, visualDesignHash: contract.visualDesign.hash },
  toolchain,
  adapter: { path: adapterPath, sha256: hash(adapter) },
  validator: { path: validatorPath, sha256: hash(validator) },
  sourceBlend: { path: blendOut, sha256: hash(blend), bytes: blend.length },
  asset: { path: out, sha256: hash(glb), bytes: glb.length },
  inventory: {
    parts: contract.parts.length,
    joints: contract.joints.length,
    sockets: contract.sockets.length,
    occupancySockets: contract.sockets.filter((s) => s.kind === "occupancy").length,
    colliders: contract.colliders.length,
    materialRoles: contract.materialRoles,
  },
  freshProcessValidation: JSON.parse(blendValidationLine.slice(blendValidationLine.indexOf("=") + 1)),
  glbValidation: {
    version: document.asset.version,
    generator: document.asset.generator,
    nodes: document.nodes?.length ?? 0,
    meshes: document.meshes?.length ?? 0,
    materials: document.materials?.length ?? 0,
    semanticIds: nodeIds.size,
    finiteAccessorBounds: true,
    contractIdentity: true,
    materialProvenance: true,
    boundsSource: "exported-glb-scene-graph",
  },
  rendered: false,
  gpuUsed: false,
  status: "cpu-authored-unreviewed",
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
