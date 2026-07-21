import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("./visual-benchmark.schema.json", import.meta.url)), "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export class BenchmarkValidationError extends Error {
  constructor(errors) {
    super(`visual benchmark manifest is invalid:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    this.name = "BenchmarkValidationError";
    this.errors = errors;
  }
}

function jsonPath(pointer) {
  if (!pointer) return "$";
  return `$${pointer.split("/").slice(1).map((part) => `.${part.replaceAll("~1", "/").replaceAll("~0", "~")}`).join("")}`;
}

function schemaError(error) {
  const path = jsonPath(error.instancePath);
  if (error.keyword === "required") return `${path}.${error.params.missingProperty} is required`;
  if (error.keyword === "additionalProperties") return `${path}.${error.params.additionalProperty} is not allowed`;
  if (error.instancePath === "/recordOnly" && error.keyword === "const") {
    return "$.recordOnly must be true; v1 records evidence and defines no pass/fail budgets";
  }
  if (error.instancePath === "/simulation/fixedTimestepSeconds" && error.keyword === "const") {
    return "$.simulation.fixedTimestepSeconds must equal the Limina runtime fixed step (1/60)";
  }
  return `${path} ${error.message ?? "is invalid"}`;
}

export function validateRelativePath(value, path = "path") {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    return `${path} must be a non-empty relative path of at most 1024 characters`;
  }
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value) || win32.isAbsolute(value)) {
    return `${path} must be a portable project-relative path`;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${path} must not contain empty, current-directory, or parent-directory segments`;
  }
  return null;
}

export function validateBenchmarkManifest(value) {
  if (!validateSchema(value)) {
    throw new BenchmarkValidationError((validateSchema.errors ?? []).map(schemaError).sort());
  }
  const errors = [];
  for (const [setName, artifact] of [["source", value.source], ["export", value.export]]) {
    artifact.files.forEach((file, index) => {
      const error = validateRelativePath(file, `$.${setName}.files[${index}]`);
      if (error) errors.push(error);
    });
  }
  const cameraIds = new Set();
  value.cameras.forEach((camera, index) => {
    if (cameraIds.has(camera.id)) errors.push(`$.cameras contains duplicate id ${JSON.stringify(camera.id)}`);
    cameraIds.add(camera.id);
    const error = validateRelativePath(camera.viewPath, `$.cameras[${index}].viewPath`);
    if (error) errors.push(error);
  });
  const outputError = validateRelativePath(value.output.directory, "$.output.directory");
  if (outputError) errors.push(outputError);
  if (errors.length) throw new BenchmarkValidationError(errors.sort());
  return value;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveProjectFile(projectRoot, projectPath, { mustExist = true } = {}) {
  const pathError = validateRelativePath(projectPath);
  if (pathError) throw new BenchmarkValidationError([pathError]);
  const root = realpathSync(resolve(projectRoot));
  const candidate = resolve(root, projectPath);
  if (!inside(root, candidate)) throw new BenchmarkValidationError([`path escapes project root: ${projectPath}`]);
  if (!mustExist) return candidate;
  if (!existsSync(candidate)) throw new BenchmarkValidationError([`project file does not exist: ${projectPath}`]);
  const stat = lstatSync(candidate);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new BenchmarkValidationError([`project path is not a file: ${projectPath}`]);
  const real = realpathSync(candidate);
  if (!inside(root, real)) throw new BenchmarkValidationError([`project file resolves outside project root: ${projectPath}`]);
  if (!lstatSync(real).isFile()) throw new BenchmarkValidationError([`project path is not a regular file: ${projectPath}`]);
  return real;
}

export function resolveProjectOutputDirectory(projectRoot, projectPath) {
  const pathError = validateRelativePath(projectPath);
  if (pathError) throw new BenchmarkValidationError([pathError]);
  const root = realpathSync(resolve(projectRoot));
  const candidate = resolve(root, projectPath);
  if (!inside(root, candidate)) throw new BenchmarkValidationError([`output path escapes project root: ${projectPath}`]);
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) throw new BenchmarkValidationError([`cannot resolve output directory: ${projectPath}`]);
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (!inside(root, realAncestor)) throw new BenchmarkValidationError([`output directory resolves outside project root: ${projectPath}`]);
  if (existsSync(candidate)) {
    const realCandidate = realpathSync(candidate);
    if (!inside(root, realCandidate)) throw new BenchmarkValidationError([`output directory resolves outside project root: ${projectPath}`]);
    if (!lstatSync(realCandidate).isDirectory()) throw new BenchmarkValidationError([`output path is not a directory: ${projectPath}`]);
    return realCandidate;
  }
  return candidate;
}

export function sha256File(projectRoot, projectPath) {
  const bytes = readFileSync(resolveProjectFile(projectRoot, projectPath));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256Tree(projectRoot, files) {
  const hash = createHash("sha256");
  hash.update("limina-sha256-tree-v1\0");
  for (const projectPath of [...files].sort()) {
    const bytes = readFileSync(resolveProjectFile(projectRoot, projectPath));
    const pathBytes = Buffer.from(projectPath, "utf8");
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update(`\0${bytes.length}:`);
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function loadAndValidateBenchmark(projectRoot, manifestPath) {
  const manifestFile = resolveProjectFile(projectRoot, manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new BenchmarkValidationError([`cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const manifest = validateBenchmarkManifest(parsed);
  const errors = [];
  for (const [label, artifact] of [["source", manifest.source], ["export", manifest.export]]) {
    let actual;
    try { actual = sha256Tree(projectRoot, artifact.files); }
    catch (error) {
      if (error instanceof BenchmarkValidationError) errors.push(...error.errors.map((message) => `${label}: ${message}`));
      else throw error;
      continue;
    }
    if (actual !== artifact.sha256) errors.push(`${label} hash mismatch: expected ${artifact.sha256}, got ${actual}`);
  }
  for (const camera of manifest.cameras) {
    let actualHash;
    try { actualHash = sha256File(projectRoot, camera.viewPath); }
    catch (error) {
      if (error instanceof BenchmarkValidationError) errors.push(...error.errors.map((message) => `camera ${camera.id}: ${message}`));
      else throw error;
      continue;
    }
    if (actualHash !== camera.viewSha256) errors.push(`camera ${camera.id} view hash mismatch: expected ${camera.viewSha256}, got ${actualHash}`);
    try {
      const actualView = JSON.parse(readFileSync(resolveProjectFile(projectRoot, camera.viewPath), "utf8"));
      if (!equalJson(actualView, camera.orbit)) errors.push(`camera ${camera.id} orbit does not match ${camera.viewPath}`);
    } catch (error) {
      if (error instanceof BenchmarkValidationError) errors.push(...error.errors);
      else errors.push(`camera ${camera.id} view is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const logPaths = manifest.export.files.filter((file) => file.endsWith("/log.jsonl") || file === "log.jsonl");
  if (logPaths.length !== 1) {
    errors.push("export must pin exactly one log.jsonl so the benchmark seed can be verified");
  } else {
    try {
      const records = readFileSync(resolveProjectFile(projectRoot, logPaths[0]), "utf8")
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const seeds = records.filter((record) => record?.kind === "seed");
      if (seeds.length !== 1 || !Number.isInteger(seeds[0].seed)) {
        errors.push(`${logPaths[0]} must contain exactly one integer seed record`);
      } else if (seeds[0].seed !== manifest.simulation.seed) {
        errors.push(`simulation seed mismatch: manifest declares ${manifest.simulation.seed}, export records ${seeds[0].seed}`);
      }
    } catch (error) {
      errors.push(`cannot verify export seed from ${logPaths[0]}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new BenchmarkValidationError(errors);
  return { manifest, manifestFile };
}
