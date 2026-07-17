import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateVegetationLod } from "../asset/generate-vegetation-lod.mjs";
import { classifyBounds, glbBbox } from "../qc/asset-sanity.mjs";
import { runAssetQcGate } from "../../gates/design/asset-qc-gate.mjs";

export const EVIDENCE_SCHEMA = "limina.retopo-static/1";
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const CAP_M = 60;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
function finiteArray(values) { return Array.isArray(values) && values.every(Number.isFinite); }

function firstExtensionPath(value, path = "glTF") {
  if (value === null || typeof value !== "object") return null;
  if (!Array.isArray(value) && value.extensions && Object.keys(value.extensions).length > 0) return `${path}.extensions`;
  for (const [key, child] of Object.entries(value)) {
    if (key === "extensions") continue;
    const found = firstExtensionPath(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

export function parseGlbJson(bytes, label = "input") {
  if (bytes.byteLength < 20) throw new Error(`${label} is not a GLB 2.0 binary`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error(`${label} has an invalid GLB 2.0 header`);
  }
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.byteLength) throw new Error(`${label} has an invalid JSON chunk`);
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)).trimEnd()); }
  catch (error) { throw new Error(`${label} has invalid JSON: ${error.message}`, { cause: error }); }
}

export function validateStaticOpaqueGlb(bytes, label = "input") {
  const json = parseGlbJson(bytes, label);
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    if (buffer.uri !== undefined) throw new Error(`${label} buffer ${index} is external; only self-contained GLBs are accepted`);
  }
  for (const [index, image] of (json.images ?? []).entries()) {
    if (image.uri !== undefined && !image.uri.startsWith("data:")) {
      throw new Error(`${label} image ${index} is external; only self-contained GLBs are accepted`);
    }
  }
  const extensionPath = firstExtensionPath(json);
  if ((json.extensionsUsed?.length ?? 0) > 0 || (json.extensionsRequired?.length ?? 0) > 0 || extensionPath !== null) {
    const names = [...new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])];
    throw new Error(`${label} uses unsupported glTF extensions${names.length > 0 ? ` (${names.join(", ")})` : ""}${extensionPath !== null ? ` at ${extensionPath}` : ""}`);
  }
  if ((json.animations?.length ?? 0) > 0) throw new Error(`${label} contains animations`);
  if ((json.skins?.length ?? 0) > 0 || (json.nodes ?? []).some((node) => node.skin !== undefined)) throw new Error(`${label} contains a rig`);
  if (!(json.meshes?.length > 0)) throw new Error(`${label} contains no meshes`);
  for (const [index, material] of (json.materials ?? []).entries()) {
    if ((material.alphaMode ?? "OPAQUE") !== "OPAQUE") {
      throw new Error(`${label} material ${index} is not supported static opaque PBR`);
    }
  }
  let triangles = 0;
  let vertices = 0;
  for (const [meshIndex, mesh] of json.meshes.entries()) {
    if ((mesh.weights?.length ?? 0) > 0) throw new Error(`${label} mesh ${meshIndex} has morph weights`);
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.targets?.length ?? 0) > 0) throw new Error(`${label} mesh ${meshIndex} contains shape keys`);
      if ((primitive.mode ?? 4) !== 4) throw new Error(`${label} mesh ${meshIndex} is not triangle-list geometry`);
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (!position || position.type !== "VEC3" || !finiteArray(position.min) || !finiteArray(position.max)) {
        throw new Error(`${label} mesh ${meshIndex} has missing or non-finite POSITION bounds`);
      }
      if ([...position.min, ...position.max].some((value) => Math.abs(value) > CAP_M)) throw new Error(`${label} mesh ${meshIndex} bounds exceed ${CAP_M} metres`);
      vertices += position.count ?? 0;
      const indices = primitive.indices === undefined ? position : json.accessors?.[primitive.indices];
      triangles += Math.floor((indices?.count ?? 0) / 3);
    }
  }
  for (const [index, node] of (json.nodes ?? []).entries()) {
    for (const field of ["matrix", "translation", "rotation", "scale"]) {
      if (node[field] !== undefined && !finiteArray(node[field])) throw new Error(`${label} node ${index} has a non-finite ${field}`);
    }
  }
  if (triangles === 0) throw new Error(`${label} contains no triangles`);
  return { json, metrics: { meshCount: json.meshes.length, materialCount: json.materials?.length ?? 0, vertices, triangles } };
}

function assertRepositoryAssetGates(bytes, label, floor) {
  const bbox = glbBbox(bytes);
  if (bbox === null) throw new Error(`${label} has no transform-aware POSITION bounds`);
  const dimensions = bbox.mx.map((value, index) => value - bbox.mn[index]);
  const blockingBounds = classifyBounds(dimensions, bbox.mn).filter((flag) => flag === "DEGENERATE" || flag === "OVERSIZE");
  if (blockingBounds.length > 0) throw new Error(`${label} fails asset sanity: ${blockingBounds.join(", ")}`);
  const verdict = runAssetQcGate(bytes, { floor, class: "default" });
  if (!verdict.pass) {
    throw new Error(`${label} fails asset QC: ${verdict.failures.map((failure) => `${failure.gate}: ${failure.detail}`).join("; ")}`);
  }
  return { bbox: { min: bbox.mn, max: bbox.mx, dimensions }, qc: { score: verdict.score, measured: verdict.measured } };
}

function assertInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
}
function assertFinite(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`${name} must be finite and in [${min}, ${max}]`);
}
function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`Blender failed (${signal ?? code}): ${stderr.trim() || stdout.trim()}`)));
  });
}

async function ensureDestination(path) {
  if (extname(path).toLowerCase() !== (path.endsWith(".json") ? ".json" : ".glb")) throw new Error(`unsupported output extension: ${path}`);
  await stat(dirname(path));
  try { await access(path); throw new Error(`refusing to overwrite existing output: ${path}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function packageVersion(packagePath) {
  return JSON.parse(await readFile(packagePath, "utf8")).version;
}

export async function retopoStatic({ input, output, lodOutput, evidence, seed = 1, targetFaces = 5000, resolution = 1024, bakeSamples = 32, cageExtrusion = 0.05, lodRatio = 0.5, lodError = 1, blenderBin = process.env.BLENDER_BIN ?? join(process.env.HOME ?? "", "blender-5.1.2-linux-x64", "blender") }) {
  for (const [name, value] of [["input", input], ["output", output], ["lodOutput", lodOutput], ["evidence", evidence], ["blenderBin", blenderBin]]) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty path`);
  }
  assertInteger("seed", seed, 0, 2_147_483_647);
  assertInteger("targetFaces", targetFaces, 64, 2_000_000);
  assertInteger("resolution", resolution, 16, 8192);
  assertInteger("bakeSamples", bakeSamples, 1, 4096);
  if ((resolution & (resolution - 1)) !== 0) throw new TypeError("resolution must be a power of two");
  assertFinite("cageExtrusion", cageExtrusion, Number.MIN_VALUE, 1);
  assertFinite("lodRatio", lodRatio, Number.MIN_VALUE, 1);
  assertFinite("lodError", lodError, 0, 1);

  const paths = { input: resolve(input), output: resolve(output), lodOutput: resolve(lodOutput), evidence: resolve(evidence) };
  if (extname(paths.input).toLowerCase() !== ".glb") throw new Error("input must be a .glb file");
  if (new Set(Object.values(paths)).size !== 4) throw new Error("input, output, LOD, and evidence paths must be distinct");
  if (new Set([dirname(paths.output), dirname(paths.lodOutput), dirname(paths.evidence)]).size !== 1) {
    throw new Error("output, LOD, and evidence must share one directory for atomic publication");
  }
  await Promise.all([ensureDestination(paths.output), ensureDestination(paths.lodOutput), ensureDestination(paths.evidence)]);
  const inputBytes = await readFile(paths.input);
  const inputInspection = validateStaticOpaqueGlb(inputBytes, "input");

  const stage = join(dirname(paths.output), `.retopo-${process.pid}-${randomUUID()}`);
  const stageOutput = join(stage, "retopo.glb");
  const stageLod = join(stage, "retopo-lod.glb");
  const stageBlenderSummary = join(stage, "blender-summary.json");
  const stageEvidence = join(stage, "evidence.json");
  const script = fileURLToPath(new URL("./retopo-static.py", import.meta.url));
  const packagePath = fileURLToPath(new URL("../node_modules/meshoptimizer/package.json", import.meta.url));
  const floorPath = fileURLToPath(new URL("../../art-direction/fidelity-floor.json", import.meta.url));
  const published = [];
  await mkdir(stage, { mode: 0o700 });
  try {
    const blenderArgs = ["--background", "--factory-startup", "--threads", "1", "--python", script, "--",
      "--input", paths.input, "--output", stageOutput, "--summary", stageBlenderSummary,
      "--seed", String(seed), "--target-faces", String(targetFaces), "--resolution", String(resolution), "--bake-samples", String(bakeSamples), "--cage-extrusion", String(cageExtrusion)];
    await run(blenderBin, blenderArgs, { env: { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", BLIS_NUM_THREADS: "1" } });
    const outputBytes = await readFile(stageOutput);
    const outputInspection = validateStaticOpaqueGlb(outputBytes, "retopo output");
    if (outputInspection.metrics.materialCount !== 1) throw new Error(`retopo output must contain exactly one material; found ${outputInspection.metrics.materialCount}`);
    const outputJson = outputInspection.json;
    const material = outputJson.materials[0];
    if (material.normalTexture === undefined || material.occlusionTexture === undefined || material.pbrMetallicRoughness?.baseColorTexture === undefined || material.pbrMetallicRoughness?.metallicRoughnessTexture === undefined) {
      throw new Error("retopo output did not export the required albedo, normal, and packed ORM bindings");
    }
    if (material.occlusionTexture.index !== material.pbrMetallicRoughness.metallicRoughnessTexture.index) {
      throw new Error("retopo output did not bind AO and metallic-roughness from one packed ORM texture");
    }
    const floor = JSON.parse(await readFile(floorPath, "utf8"));
    const repositoryGates = assertRepositoryAssetGates(outputBytes, "retopo output", floor);
    const lod = await generateVegetationLod({ input: stageOutput, output: stageLod, ratio: lodRatio, error: lodError });
    const lodBytes = await readFile(stageLod);
    const lodInspection = validateStaticOpaqueGlb(lodBytes, "LOD output");
    const blender = JSON.parse(await readFile(stageBlenderSummary, "utf8"));
    const { input: _stageInput, output: _stageOutput, ...portableLodSummary } = lod;
    const provenance = {
      schema: EVIDENCE_SCHEMA,
      tool: "tools/retopo/retopo-static.mjs",
      input: { path: paths.input, sha256: sha256(inputBytes), bytes: inputBytes.byteLength, metrics: inputInspection.metrics },
      output: { path: paths.output, sha256: sha256(outputBytes), bytes: outputBytes.byteLength, metrics: outputInspection.metrics },
      lod: { path: paths.lodOutput, sha256: sha256(lodBytes), bytes: lodBytes.byteLength, metrics: lodInspection.metrics, recipe: { ratio: lodRatio, error: lodError }, summary: portableLodSummary },
      tools: {
        wrapper: { path: fileURLToPath(import.meta.url), sha256: await sha256File(fileURLToPath(import.meta.url)) },
        blenderScript: { path: script, sha256: await sha256File(script) },
        blender: { binary: resolve(blenderBin), version: blender.blenderVersion, binarySha256: await sha256File(blenderBin) },
        meshoptimizer: { package: "meshoptimizer", version: await packageVersion(packagePath) },
      },
      recipe: blender.recipe,
      blenderMetrics: { input: blender.input, output: blender.output },
      repositoryGates,
      determinism: { quadriflowSeed: seed, processThreads: 1, cpuOnly: true, environmentThreads: { OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", BLIS_NUM_THREADS: "1" } },
    };
    await writeFile(stageEvidence, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    for (const [from, to] of [[stageOutput, paths.output], [stageLod, paths.lodOutput], [stageEvidence, paths.evidence]]) {
      await link(from, to);
      published.push(to);
      await unlink(from);
    }
    return provenance;
  } catch (error) {
    for (const path of published.reverse()) await rm(path, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
