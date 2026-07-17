import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { glbBbox } from "../qc/asset-sanity.mjs";
import {
  buildTreeImpostorArtifact,
  normalizeTreeImpostorConfig,
  packTreeImpostorViews,
  readTreeImpostorDescriptor,
  treeImpostorViewDirections,
  treeImpostorCacheKey,
  validateTreeImpostorArtifact,
} from "./tree-impostor-artifact.mjs";

export const TREE_IMPOSTOR_BAKE_SUMMARY_SCHEMA = "limina.tree-impostor-bake/1";
const HASH = /^sha256:[0-9a-f]{64}$/;
function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function liminaContentHash(bytes) { return `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex")).digest("hex")}`; }
function roundedBounds(bbox) { return { min: bbox.mn.map((value) => Number(value.toFixed(8))), max: bbox.mx.map((value) => Number(value.toFixed(8))) }; }
function contained(root, candidate) { const rel = relative(root, candidate); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }

export async function assertAcceptedTreeSource({ input, lodInput, manifest, assetRoot, allowCandidate = false }) {
  const root = await realpath(resolve(assetRoot));
  const inputPath = await realpath(resolve(input)), lodPath = await realpath(resolve(lodInput));
  if (!contained(root, inputPath) || !contained(root, lodPath)) throw new Error("tree impostor source/LOD must be contained by assetRoot");
  const manifestJson = JSON.parse(await readFile(resolve(manifest), "utf8"));
  const sourceRelative = relative(root, inputPath).split(sep).join("/"), lodRelative = relative(root, lodPath).split(sep).join("/");
  const accepted = (manifestJson.entries ?? []).find((candidate) => candidate?.model?.path === sourceRelative);
  const candidate = allowCandidate ? (manifestJson.candidates ?? []).find((value) => value?.model?.path === sourceRelative) : undefined;
  const entry = accepted ?? candidate;
  const candidateOnly = accepted === undefined && candidate !== undefined;
  if (entry?.class !== "vegetation" || (candidateOnly
      ? !String(entry.status ?? "").startsWith("candidate-") || entry?.qc?.humanVisualApproval !== null
      : entry?.qc?.humanVisualApproval?.approved !== true)) {
    throw new Error(`tree impostor source '${sourceRelative}' is not an accepted, human-approved vegetation entry`);
  }
  const [sourceBytes, lodBytes] = await Promise.all([readFile(inputPath), readFile(lodPath)]);
  const sourceSha256 = sha256(sourceBytes), lodSha256 = sha256(lodBytes);
  if (entry.model.sha256 !== sourceSha256) throw new Error("tree impostor source manifest hash is stale");
  const lod = (entry.lods ?? []).find((candidate) => candidate?.path === lodRelative);
  if (lod?.sha256 !== lodSha256) throw new Error(`tree impostor reduced LOD '${lodRelative}' is not pinned by the accepted source entry`);
  const bbox = glbBbox(sourceBytes);
  if (bbox === null) throw new Error("tree impostor source has no inspectable POSITION bounds");
  return Object.freeze({ entryId: entry.id, candidateOnly, inputPath, lodPath, sourceBytes, lodBytes, sourceSha256, lodSha256,
    sourceContentHash: liminaContentHash(sourceBytes), lodContentHash: liminaContentHash(lodBytes), bounds: roundedBounds(bbox) });
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CUDA_VISIBLE_DEVICES: "" } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolvePromise({ stdout, stderr })
      : reject(new Error(`tree impostor Blender subprocess failed code=${code} signal=${signal ?? "none"}: ${stderr.slice(-2000)}`)));
  });
}

function renderSummary(stdout) {
  const line = stdout.split(/\r?\n/).findLast((candidate) => candidate.startsWith("LIMINA_TREE_IMPOSTOR_SUMMARY="));
  if (line === undefined) throw new Error("tree impostor Blender subprocess emitted no machine-readable summary");
  const summary = JSON.parse(line.slice("LIMINA_TREE_IMPOSTOR_SUMMARY=".length));
  if (summary.schema !== "limina.tree-impostor-render/1" || summary.engine !== "CYCLES" || summary.device !== "CPU") {
    throw new Error("tree impostor Blender subprocess did not prove Cycles CPU rendering");
  }
  return summary;
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export async function bakeTreeImpostor({ input, lodInput, output, evidence = `${output}.evidence.json`, manifest, assetRoot,
  grid = 8, cellSize = 128, alphaCutoff = 0.45, samples = 32, seed = 1,
  allowCandidate = false,
  blenderBin = process.env.BLENDER_BIN ?? join(process.env.HOME ?? "", "blender-5.1.2-linux-x64", "blender") }) {
  const accepted = await assertAcceptedTreeSource({ input, lodInput, manifest, assetRoot, allowCandidate });
  const config = normalizeTreeImpostorConfig({ grid, cellSize, alphaCutoff });
  const bake = Object.freeze({ blenderVersion: "5.1.2", engine: "CYCLES", device: "CPU", samples, seed });
  const cacheKey = treeImpostorCacheKey({ sourceSha256: accepted.sourceSha256, lodSha256: accepted.lodSha256,
    sourceContentHash: accepted.sourceContentHash, lodContentHash: accepted.lodContentHash, bounds: accepted.bounds, config, bake });
  const outputPath = resolve(output), evidencePath = resolve(evidence);
  try {
    const existing = await readFile(outputPath), descriptor = await readTreeImpostorDescriptor(existing);
    if (descriptor?.cacheKey === cacheKey) {
      const qc = await validateTreeImpostorArtifact(existing);
      return Object.freeze({ schema: TREE_IMPOSTOR_BAKE_SUMMARY_SCHEMA, cacheHit: true, output: outputPath, evidence: evidencePath,
        sourceSha256: accepted.sourceSha256, lodSha256: accepted.lodSha256, sourceContentHash: accepted.sourceContentHash,
        lodContentHash: accepted.lodContentHash, outputSha256: sha256(existing), cacheKey, qc });
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }

  const work = await mkdtemp(join(tmpdir(), "limina-tree-impostor-"));
  try {
    const script = resolve(import.meta.dirname, "../blender/render-tree-impostor.py");
    const result = await run(blenderBin, ["--background", "--factory-startup", "--threads", "1", "--python", script, "--",
      "--input", accepted.inputPath, "--output-dir", work, "--grid", String(config.grid), "--cell-size", String(config.cellSize),
      "--samples", String(samples), "--seed", String(seed)]);
    const rendered = renderSummary(result.stdout);
    if (rendered.grid !== config.grid || rendered.cellSize !== config.cellSize || rendered.samples !== samples || rendered.seed !== seed) {
      throw new Error("tree impostor Blender summary differs from requested bake config");
    }
    const expectedDirections = treeImpostorViewDirections(config.grid);
    if (!Array.isArray(rendered.directions) || rendered.directions.length !== expectedDirections.length || rendered.directions.some((direction, index) =>
      !Array.isArray(direction) || direction.length !== 3 || direction.some((value, axis) => Math.abs(value - expectedDirections[index][axis]) > 2e-7))) {
      throw new Error("tree impostor Blender orientation table differs from the runtime selector contract");
    }
    const names = Array.from({ length: config.grid * config.grid }, (_, index) => String(index).padStart(3, "0"));
    const packed = await packTreeImpostorViews({
      albedoViews: names.map((name) => join(work, `albedo-${name}.png`)),
      normalDepthViews: names.map((name) => join(work, `normal-depth-${name}.png`)), config,
    });
    const artifact = await buildTreeImpostorArtifact({ sourceSha256: accepted.sourceSha256, lodSha256: accepted.lodSha256,
      sourceContentHash: accepted.sourceContentHash, lodContentHash: accepted.lodContentHash,
      bounds: accepted.bounds, packed, bakeConfig: bake, output: outputPath });
    if (artifact.descriptor.cacheKey !== cacheKey) throw new Error("tree impostor cache key diverged between orchestration and artifact publication");
    const summary = Object.freeze({ schema: TREE_IMPOSTOR_BAKE_SUMMARY_SCHEMA, cacheHit: false, entryId: accepted.entryId,
      candidateOnly: accepted.candidateOnly,
      input: accepted.inputPath, lodInput: accepted.lodPath, output: outputPath, sourceSha256: accepted.sourceSha256,
      lodSha256: accepted.lodSha256, sourceContentHash: accepted.sourceContentHash, lodContentHash: accepted.lodContentHash,
      outputSha256: artifact.sha256, cacheKey, config, bake, rendered, qc: artifact.qc });
    await atomicJson(evidencePath, summary);
    return Object.freeze({ ...summary, evidence: evidencePath });
  } finally { await rm(work, { recursive: true, force: true }); }
}

function cliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; if (!key?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`invalid argument '${key ?? ""}'`);
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const result = await bakeTreeImpostor({ input: args.input, lodInput: args.lod, output: args.output, evidence: args.evidence,
      manifest: args.manifest, assetRoot: args["asset-root"], grid: args.grid === undefined ? undefined : Number(args.grid),
      cellSize: args["cell-size"] === undefined ? undefined : Number(args["cell-size"]), samples: args.samples === undefined ? undefined : Number(args.samples),
      seed: args.seed === undefined ? undefined : Number(args.seed), alphaCutoff: args["alpha-cutoff"] === undefined ? undefined : Number(args["alpha-cutoff"]),
      allowCandidate: args.candidate === "true", blenderBin: args.blender });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
