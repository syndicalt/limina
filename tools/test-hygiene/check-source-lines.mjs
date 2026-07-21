#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_LINE_BYTES = 500;
export const SOURCE_EXTENSIONS = Object.freeze([
  ".astro",
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
]);

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(moduleDir, "../..");
const defaultManifestPath = resolve(moduleDir, "generated-source-manifest.json");
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function decodeUtf8(buffer, label) {
  try {
    return fatalUtf8.decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function decodeGitPaths(buffer, label) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) paths.push(decodeUtf8(buffer.subarray(start, index), `${label} path`));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error(`${label} returned a non-NUL-terminated path list`);
  return paths;
}

function listGitPaths(root, args, label) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", ...args, "-z"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr?.toString?.("utf8")?.trim() || error?.message || String(error);
    throw new Error(`${label} failed: ${detail}`);
  }
  return decodeGitPaths(output, label);
}

function isSourcePath(path) {
  return SOURCE_EXTENSIONS.includes(extname(path).toLowerCase());
}

function assertInsideRoot(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes repository root: ${JSON.stringify(path)}`);
  }
  return absolute;
}

function findLongLines(buffer) {
  const lines = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 10) continue;
    const end = index > start && buffer[index - 1] === 13 ? index - 1 : index;
    const bytes = end - start;
    if (bytes > MAX_LINE_BYTES) lines.push({ line, bytes });
    start = index + 1;
    line += 1;
  }
  return lines;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateManifest(raw) {
  const errors = [];
  if (!exactKeys(raw, ["artifacts", "lineLimitBytes", "schemaVersion", "sourceExtensions"])) {
    errors.push(issue("manifest_shape", "generated-source manifest has unknown or missing top-level fields"));
    return { errors, artifacts: [] };
  }
  if (raw.schemaVersion !== 1)
    errors.push(issue("manifest_version", "generated-source manifest schemaVersion must be 1"));
  if (raw.lineLimitBytes !== MAX_LINE_BYTES) {
    errors.push(issue("manifest_limit", `generated-source manifest lineLimitBytes must remain ${MAX_LINE_BYTES}`));
  }
  if (
    !Array.isArray(raw.sourceExtensions) ||
    raw.sourceExtensions.length !== SOURCE_EXTENSIONS.length ||
    raw.sourceExtensions.some((entry, index) => entry !== SOURCE_EXTENSIONS[index])
  ) {
    errors.push(
      issue("manifest_extensions", "generated-source manifest must contain the exact source-extension allowlist"),
    );
  }
  if (!Array.isArray(raw.artifacts)) {
    errors.push(issue("manifest_artifacts", "generated-source manifest artifacts must be an array"));
    return { errors, artifacts: [] };
  }

  const artifacts = [];
  const seen = new Set();
  for (const [index, entry] of raw.artifacts.entries()) {
    if (!exactKeys(entry, ["path", "recipeId"])) {
      errors.push(issue("manifest_artifact_shape", `artifact ${index} must contain exactly path and recipeId`));
      continue;
    }
    const path = entry.path;
    const recipeId = entry.recipeId;
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[*?[\]{}]/u.test(path)
    ) {
      errors.push(issue("manifest_artifact_path", `artifact ${index} has a non-exact or unsafe path`, { path }));
      continue;
    }
    if (!isSourcePath(path)) {
      errors.push(
        issue("manifest_artifact_extension", `artifact ${path} is not in the source-extension allowlist`, { path }),
      );
      continue;
    }
    if (typeof recipeId !== "string" || !/^[a-z0-9][a-z0-9:._-]*@[1-9][0-9]*$/u.test(recipeId)) {
      errors.push(issue("manifest_recipe_id", `artifact ${path} has an invalid named recipe ID`, { path, recipeId }));
      continue;
    }
    if (seen.has(path)) {
      errors.push(issue("manifest_duplicate", `artifact path is duplicated: ${path}`, { path }));
      continue;
    }
    seen.add(path);
    artifacts.push({ path, recipeId });
  }
  const sorted = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (artifacts.some((entry, index) => entry !== sorted[index])) {
    errors.push(issue("manifest_order", "generated-source artifacts must be sorted by exact path"));
  }
  return { errors, artifacts };
}

async function loadManifest(path) {
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new Error(`${path} contains a NUL byte`);
  return JSON.parse(decodeUtf8(buffer, path));
}

function readPinnedPackage(root, relativePath, dependencySection, dependencyName) {
  return Promise.all([
    readFile(resolve(root, relativePath), "utf8").then(JSON.parse),
    readFile(resolve(root, `js/node_modules/${dependencyName}/package.json`), "utf8").then(JSON.parse),
  ]).then(([project, installed]) => {
    const pin = project?.[dependencySection]?.[dependencyName];
    if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/u.test(pin)) {
      throw new Error(`${dependencyName} must use an exact package pin for generated-source verification`);
    }
    if (installed.version !== pin)
      throw new Error(`installed ${dependencyName} ${installed.version} does not match pin ${pin}`);
    return pin;
  });
}

async function produceEsbuild(root, scratch, recipeId, cwdRelative, args) {
  await readPinnedPackage(root, "js/package.json", "devDependencies", "esbuild");
  const output = resolve(scratch, `${recipeId.replace(/[^a-z0-9]+/giu, "-")}.js`);
  const executable = resolve(root, "js/node_modules/.bin/esbuild");
  const result = spawnSync(executable, [...args, `--outfile=${output}`], {
    cwd: resolve(root, cwdRelative),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${recipeId} failed with status ${String(result.status)}: ${(result.stderr || result.stdout || "no output").trim()}`,
    );
  }
  return readFile(output);
}

async function producePatchedThreeBundle(root, scratch) {
  await readPinnedPackage(root, "js/package.json", "devDependencies", "esbuild");
  const threePin = await readPinnedPackage(root, "js/package.json", "dependencies", "three");
  if (threePin !== "0.184.0") throw new Error(`timestamp patch recipe requires Three 0.184.0, found ${threePin}`);

  // bundle:three patches two pinned Three files before invoking esbuild. Re-run
  // that real project patcher against a private package copy so the hygiene gate
  // is read-only even on a pristine npm-ci installation.
  const recipeRoot = resolve(scratch, "three-bundle-recipe", "js");
  await Promise.all([
    mkdir(resolve(recipeRoot, "build"), { recursive: true }),
    mkdir(resolve(recipeRoot, "scripts"), { recursive: true }),
    mkdir(resolve(recipeRoot, "node_modules"), { recursive: true }),
  ]);
  await Promise.all([
    cp(resolve(root, "js/node_modules/three"), resolve(recipeRoot, "node_modules/three"), { recursive: true }),
    cp(resolve(root, "js/build/three-entry.js"), resolve(recipeRoot, "build/three-entry.js")),
    cp(
      resolve(root, "js/scripts/patch-three-timestamp-query.mjs"),
      resolve(recipeRoot, "scripts/patch-three-timestamp-query.mjs"),
    ),
  ]);
  const patchResult = spawnSync(process.execPath, [resolve(recipeRoot, "scripts/patch-three-timestamp-query.mjs")], {
    cwd: recipeRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (patchResult.status !== 0) {
    throw new Error(
      `esbuild:three-bundle@1 vendor patch failed with status ${String(patchResult.status)}: ${(
        patchResult.stderr ||
        patchResult.stdout ||
        "no output"
      ).trim()}`,
    );
  }
  const output = resolve(scratch, "esbuild-three-bundle-1.mjs");
  const executable = resolve(root, "js/node_modules/.bin/esbuild");
  const bundleResult = spawnSync(
    executable,
    ["build/three-entry.js", "--bundle", "--format=esm", `--outfile=${output}`],
    {
      cwd: recipeRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (bundleResult.status !== 0) {
    throw new Error(
      `esbuild:three-bundle@1 failed with status ${String(bundleResult.status)}: ${(
        bundleResult.stderr ||
        bundleResult.stdout ||
        "no output"
      ).trim()}`,
    );
  }
  return readFile(output);
}

export function productionRecipes(root) {
  const recipe = (allowedArtifacts, produce) => ({ allowedArtifacts: new Set(allowedArtifacts), produce });
  return new Map([
    [
      "esbuild:browser-player@1",
      recipe(["site/public/examples/limina-player.js", "tools/scaffold/public/limina-player.js"], ({ scratch }) =>
        produceEsbuild(root, scratch, "esbuild:browser-player@1", "js", [
          "src/browser-entry.ts",
          "--bundle",
          "--format=iife",
          "--global-name=LiminaPlayer",
          "--platform=browser",
          "--define:import.meta.url=document.baseURI",
          "--loader:.ts=ts",
        ]),
      ),
    ],
    [
      "esbuild:browser-runtime@1",
      recipe(["web/public/limina-runtime.js"], ({ scratch }) =>
        produceEsbuild(root, scratch, "esbuild:browser-runtime@1", "js", [
          "src/browser-entry.ts",
          "--bundle",
          "--format=esm",
          "--platform=browser",
          "--loader:.ts=ts",
        ]),
      ),
    ],
    [
      "esbuild:sim-worker@1",
      recipe(["web/public/sim-worker-entry.js"], ({ scratch }) =>
        produceEsbuild(root, scratch, "esbuild:sim-worker@1", "js", [
          "src/browser/sim-worker-entry.ts",
          "--bundle",
          "--format=esm",
          "--platform=browser",
          "--loader:.ts=ts",
        ]),
      ),
    ],
    [
      "esbuild:three-bundle@1",
      recipe(["js/build/three.bundle.mjs"], ({ scratch }) => producePatchedThreeBundle(root, scratch)),
    ],
    [
      "esbuild:bitecs-bundle@1",
      recipe(["js/build/bitecs.bundle.mjs"], ({ scratch }) =>
        produceEsbuild(root, scratch, "esbuild:bitecs-bundle@1", "js", [
          "build/bitecs-entry.js",
          "--bundle",
          "--format=esm",
        ]),
      ),
    ],
    [
      "esbuild:silhouette-spike@1",
      recipe(["gates/design/spike/silhouette.js"], ({ scratch }) =>
        produceEsbuild(root, scratch, "esbuild:silhouette-spike@1", ".", [
          "gates/design/spike/silhouette.ts",
          "--bundle",
          "--format=esm",
          "--platform=browser",
          "--loader:.ts=ts",
        ]),
      ),
    ],
    [
      "copy:three-0.184.0-basis-transcoder@1",
      recipe(
        [
          "runtime/basis/basis_transcoder.js",
          "tools/scaffold/public/runtime/basis/basis_transcoder.js",
          "web/public/runtime/basis/basis_transcoder.js",
        ],
        async () => {
          const pin = await readPinnedPackage(root, "js/package.json", "dependencies", "three");
          if (pin !== "0.184.0") throw new Error(`recipe requires the audited Three 0.184.0 pin, found ${pin}`);
          return readFile(resolve(root, "js/node_modules/three/examples/jsm/libs/basis/basis_transcoder.js"));
        },
      ),
    ],
  ]);
}

export async function auditSourceLines({
  root = defaultRoot,
  manifestPath = defaultManifestPath,
  manifest: suppliedManifest,
  recipes = productionRecipes(root),
} = {}) {
  root = resolve(root);
  const errors = [];
  let rawManifest;
  try {
    rawManifest = suppliedManifest ?? (await loadManifest(manifestPath));
  } catch (error) {
    errors.push(issue("manifest_read", `cannot read generated-source manifest: ${error.message}`));
    rawManifest = {};
  }
  const validated = validateManifest(rawManifest);
  errors.push(...validated.errors);

  let tracked = [];
  let untracked = [];
  try {
    tracked = listGitPaths(root, ["--cached"], "tracked source inventory");
    untracked = listGitPaths(root, ["--others", "--exclude-standard"], "untracked source inventory");
  } catch (error) {
    errors.push(issue("git_inventory", error.message));
  }

  const entries = new Map();
  for (const [category, paths] of [
    ["tracked", tracked],
    ["untracked", untracked],
  ]) {
    for (const path of paths) {
      if (!isSourcePath(path) || entries.has(path)) continue;
      entries.set(path, { category, path, buffer: null, longLines: [] });
    }
  }

  for (const entry of entries.values()) {
    let absolute;
    try {
      absolute = assertInsideRoot(root, entry.path);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        errors.push(issue("source_symlink", `source path is a symlink: ${entry.path}`, { path: entry.path }));
        continue;
      }
      if (!stats.isFile()) {
        errors.push(issue("source_not_file", `source path is not a regular file: ${entry.path}`, { path: entry.path }));
        continue;
      }
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) {
        errors.push(issue("source_nul", `source file contains a NUL byte: ${entry.path}`, { path: entry.path }));
        continue;
      }
      try {
        fatalUtf8.decode(buffer);
      } catch {
        errors.push(issue("source_utf8", `source file is not valid UTF-8: ${entry.path}`, { path: entry.path }));
        continue;
      }
      entry.buffer = buffer;
      entry.longLines = findLongLines(buffer);
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(
          issue("source_missing", `Git inventories a source path that is missing from the worktree: ${entry.path}`, {
            path: entry.path,
          }),
        );
      } else {
        errors.push(
          issue("source_read", `cannot inspect source file ${entry.path}: ${error.message}`, { path: entry.path }),
        );
      }
    }
  }

  const verifiedGenerated = new Set();
  const produced = new Map();
  const verifiedRecipes = new Set();
  let scratch = null;
  try {
    if (validated.artifacts.length > 0) scratch = await mkdtemp(join(tmpdir(), "limina-source-lines-"));
    for (const artifact of validated.artifacts) {
      const entry = entries.get(artifact.path);
      if (!entry || !entry.buffer) {
        errors.push(
          issue("generated_missing", `generated artifact is absent or unreadable: ${artifact.path}`, {
            path: artifact.path,
          }),
        );
        continue;
      }
      const recipe = recipes.get(artifact.recipeId);
      if (!recipe) {
        errors.push(
          issue("generated_unresolved", `UNRESOLVED generated producer ${artifact.recipeId} for ${artifact.path}`, {
            path: artifact.path,
            recipeId: artifact.recipeId,
          }),
        );
        continue;
      }
      if (!(recipe.allowedArtifacts instanceof Set) || !recipe.allowedArtifacts.has(artifact.path)) {
        errors.push(
          issue(
            "generated_recipe_path",
            `recipe ${artifact.recipeId} is not authorized for exact path ${artifact.path}`,
            {
              path: artifact.path,
              recipeId: artifact.recipeId,
            },
          ),
        );
        continue;
      }
      let expected = produced.get(artifact.recipeId);
      if (!expected) {
        try {
          expected = await recipe.produce({ root, scratch, recipeId: artifact.recipeId });
          if (!Buffer.isBuffer(expected)) throw new Error("producer did not return a Buffer");
          produced.set(artifact.recipeId, expected);
        } catch (error) {
          errors.push(
            issue("generated_producer_failed", `generated recipe ${artifact.recipeId} failed: ${error.message}`, {
              path: artifact.path,
              recipeId: artifact.recipeId,
            }),
          );
          continue;
        }
      }
      if (!entry.buffer.equals(expected)) {
        errors.push(
          issue("generated_mismatch", `generated artifact is stale for ${artifact.recipeId}: ${artifact.path}`, {
            path: artifact.path,
            recipeId: artifact.recipeId,
          }),
        );
        continue;
      }
      verifiedGenerated.add(artifact.path);
      verifiedRecipes.add(artifact.recipeId);
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  for (const entry of entries.values()) {
    if (verifiedGenerated.has(entry.path)) continue;
    for (const line of entry.longLines) {
      errors.push(
        issue("line_too_long", `${entry.path}:${line.line} is ${line.bytes} UTF-8 bytes (maximum ${MAX_LINE_BYTES})`, {
          path: entry.path,
          line: line.line,
          bytes: line.bytes,
        }),
      );
    }
  }

  const values = [...entries.values()];
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      scanned: values.length,
      tracked: values.filter((entry) => entry.category === "tracked").length,
      untracked: values.filter((entry) => entry.category === "untracked").length,
      generatedArtifacts: verifiedGenerated.size,
      generatedRecipes: verifiedRecipes.size,
      handwrittenFiles: values.length - verifiedGenerated.size,
      lineLimitBytes: MAX_LINE_BYTES,
      sourceExtensions: [...SOURCE_EXTENSIONS],
    },
  };
}

function printResult(result) {
  const { summary } = result;
  if (result.ok) {
    console.log(
      `source-line-hygiene: PASS — ${summary.scanned} source files (${summary.tracked} tracked, ${summary.untracked} nonignored untracked); ` +
        `${summary.generatedArtifacts} generated artifacts verified by ${summary.generatedRecipes} recipes; ` +
        `${summary.handwrittenFiles} handwritten files at <=${summary.lineLimitBytes} UTF-8 bytes/line`,
    );
    return;
  }
  console.error(
    `source-line-hygiene: FAIL — ${result.errors.length} issue(s) across ${summary.scanned} scanned source files; ` +
      `${summary.generatedArtifacts} generated artifacts verified`,
  );
  const visible = result.errors.slice(0, 100);
  for (const error of visible) console.error(`  [${error.code}] ${error.message}`);
  if (visible.length < result.errors.length)
    console.error(`  ... ${result.errors.length - visible.length} additional issue(s) omitted`);
}

async function main() {
  const args = process.argv.slice(2);
  let root = defaultRoot;
  let manifestPath = defaultManifestPath;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" && args[index + 1]) root = resolve(args[++index]);
    else if (arg === "--manifest" && args[index + 1]) manifestPath = resolve(args[++index]);
    else throw new Error(`usage: node check-source-lines.mjs [--root PATH] [--manifest PATH]`);
  }
  const result = await auditSourceLines({ root, manifestPath, recipes: productionRecipes(root) });
  printResult(result);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`source-line-hygiene: FATAL — ${error.stack || error.message || String(error)}`);
    process.exitCode = 1;
  });
}
