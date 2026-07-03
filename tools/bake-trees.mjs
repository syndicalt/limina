#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const TOOLS_DIR = path.join(REPO_ROOT, "tools");
const ASSET_DIR = path.join(REPO_ROOT, "assets", "trees");
const EZ_CORE_BUNDLE = path.join(TOOLS_DIR, ".ez-core.mjs");
const ESBUILD_BIN = path.join(REPO_ROOT, "js", "node_modules", ".bin", "esbuild");
const SEEDS = [1, 2, 3];
const LEAF_COLOR = 0x2f5d34;
const BARK_COLOR = 0x5b4636;
const SPECIES = ["spruce", "pine", "birch"];

installHeadlessThreeShims();

function installHeadlessThreeShims() {
  globalThis.document = {
    createElementNS(_namespace, tagName) {
      return tagName === "img"
        ? {
            addEventListener() {},
            removeEventListener() {},
            set src(_value) {},
            get src() {
              return "";
            },
          }
        : { getContext: () => null };
    },
    createElement(tagName) {
      return this.createElementNS(null, tagName);
    },
  };

  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (arrayBuffer) => {
          this.result = arrayBuffer;
          this.onloadend && this.onloadend();
        },
        (error) => {
          this.onerror && this.onerror(error);
        },
      );
    }
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit ${code}\n${stdout}${stderr}`,
          ),
        );
      }
    });
  });
}

async function bundleEzTreeCore() {
  const bundleDir = await mkdtemp(path.join(tmpdir(), "limina-ez-tree-"));
  try {
    const entry = path.join(bundleDir, "entry.mjs");
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(bundleDir, "node_modules"));
    await writeFile(
      entry,
      'export * from "./node_modules/@dgreenheck/ez-tree/src/lib/index.js";\n',
      "utf8",
    );
    await run(ESBUILD_BIN, [
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--external:three",
      "--loader:.jpg=dataurl",
      "--loader:.png=dataurl",
      `--outfile=${EZ_CORE_BUNDLE}`,
    ]);
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
}

async function loadEzTreeCore() {
  await bundleEzTreeCore();
  return import(pathToFileURL(EZ_CORE_BUNDLE).href);
}

function configureTree(tree, ez, species, seed) {
  const { BarkType, Billboard, LeafType, TreeType } = ez;
  const options = tree.options;
  options.seed = seed;
  options.trellis.enabled = false;
  options.leaves.billboard = Billboard.Double;
  options.bark.textured = false;
  options.bark.tint = 0xffffff;
  options.leaves.tint = 0xffffff;
  options.leaves.alphaTest = 0.3;

  if (species === "spruce") {
    options.type = TreeType.Evergreen;
    options.bark.type = BarkType.Pine;
    options.leaves.type = LeafType.Pine;
    options.branch.levels = 2;
    options.branch.angle = { 1: 123, 2: 112, 3: 60 };
    options.branch.children = { 0: 64, 1: 4, 2: 0 };
    options.branch.force = { direction: { x: 0, y: 1, z: 0 }, strength: 0.004 };
    options.branch.gnarliness = { 0: 0.025, 1: 0.04, 2: 0.035, 3: 0 };
    options.branch.length = { 0: 38, 1: 10, 2: 4.5, 3: 1 };
    options.branch.radius = { 0: 0.82, 1: 0.28, 2: 0.13, 3: 0.08 };
    options.branch.sections = { 0: 14, 1: 7, 2: 5, 3: 4 };
    options.branch.segments = { 0: 8, 1: 5, 2: 4, 3: 3 };
    options.branch.start = { 1: 0.13, 2: 0.28, 3: 0.3 };
    options.branch.taper = { 0: 0.82, 1: 0.72, 2: 0.7, 3: 0.7 };
    options.branch.twist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    options.leaves.angle = 8;
    options.leaves.count = 14;
    options.leaves.start = 0.04;
    options.leaves.size = 0.72;
    options.leaves.sizeVariance = 0.22;
    return;
  }

  if (species === "pine") {
    options.type = TreeType.Evergreen;
    options.bark.type = BarkType.Pine;
    options.leaves.type = LeafType.Pine;
    options.branch.levels = 1;
    options.branch.angle = { 1: 126, 2: 60, 3: 60 };
    options.branch.children = { 0: 44, 1: 0, 2: 0 };
    options.branch.force = { direction: { x: 0, y: 1, z: 0 }, strength: 0.006 };
    options.branch.gnarliness = { 0: 0.035, 1: 0.08, 2: 0, 3: 0 };
    options.branch.length = { 0: 48, 1: 18, 2: 10, 3: 1 };
    options.branch.radius = { 0: 0.72, 1: 0.24, 2: 0.7, 3: 0.7 };
    options.branch.sections = { 0: 13, 1: 8, 2: 8, 3: 6 };
    options.branch.segments = { 0: 8, 1: 5, 2: 4, 3: 3 };
    options.branch.start = { 1: 0.48, 2: 0.3, 3: 0.3 };
    options.branch.taper = { 0: 0.82, 1: 0.7, 2: 0.7, 3: 0.7 };
    options.branch.twist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    options.leaves.angle = 15;
    options.leaves.count = 10;
    options.leaves.start = 0.16;
    options.leaves.size = 1.35;
    options.leaves.sizeVariance = 0.28;
    return;
  }

  if (species === "birch") {
    options.type = TreeType.Deciduous;
    options.bark.type = BarkType.Birch;
    options.leaves.type = LeafType.Aspen;
    options.leaves.alphaTest = 0.45;
    options.branch.levels = 2;
    options.branch.angle = { 1: 58, 2: 34, 3: 18 };
    options.branch.children = { 0: 8, 1: 3, 2: 0 };
    options.branch.force = { direction: { x: 0.06, y: 1, z: 0.02 }, strength: 0.018 };
    options.branch.gnarliness = { 0: 0.035, 1: 0.09, 2: 0.08, 3: 0.02 };
    options.branch.length = { 0: 42, 1: 8.5, 2: 9.5, 3: 1 };
    options.branch.radius = { 0: 0.46, 1: 0.22, 2: 0.14, 3: 0.08 };
    options.branch.sections = { 0: 13, 1: 8, 2: 6, 3: 4 };
    options.branch.segments = { 0: 7, 1: 5, 2: 4, 3: 3 };
    options.branch.start = { 1: 0.52, 2: 0.28, 3: 0.3 };
    options.branch.taper = { 0: 0.38, 1: 0.32, 2: 0.42, 3: 0.7 };
    options.branch.twist = { 0: 0, 1: 0.02, 2: 0.02, 3: 0 };
    options.leaves.angle = 32;
    options.leaves.count = 7;
    options.leaves.start = 0.1;
    options.leaves.size = 1.55;
    options.leaves.sizeVariance = 0.35;
    return;
  }

  throw new Error(`Unknown tree species: ${species}`);
}

function rematerialTree(tree) {
  // ez-tree exposes the two meshes explicitly (tree.js: this.branchesMesh / this.leavesMesh);
  // GLTFExporter renames them to mesh_0/mesh_1, so identify by these references, NOT by name.
  const apply = (mesh, isLeaf) => {
    if (!mesh) return;
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material.dispose();
    } else if (mesh.material) {
      mesh.material.dispose();
    }
    mesh.name = isLeaf ? "leaves" : "branches";
    mesh.material = new THREE.MeshStandardMaterial({
      color: isLeaf ? LEAF_COLOR : BARK_COLOR,
      roughness: 0.9,
      metalness: 0,
      side: isLeaf ? THREE.DoubleSide : THREE.FrontSide,
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  };
  apply(tree.branchesMesh, false);
  apply(tree.leavesMesh, true);
}

function buildTree(ez, species, seed) {
  const tree = new ez.Tree();
  tree.name = `${species}-${seed}`;
  configureTree(tree, ez, species, seed);
  tree.generate();
  rematerialTree(tree);
  return tree;
}

async function exportGlbBuffer(tree) {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(tree, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("GLTFExporter returned JSON data; expected binary GLB ArrayBuffer");
  }
  return Buffer.from(result);
}

async function bakeOne(ez, species, seed) {
  const tree = buildTree(ez, species, seed);
  const buffer = await exportGlbBuffer(tree);
  return {
    filename: `${species}-${seed}.glb`,
    buffer,
    vertices: tree.vertexCount,
    triangles: tree.triangleCount,
  };
}

async function writeManifest(manifest) {
  await writeFile(
    path.join(ASSET_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function bakeAll(ez) {
  await mkdir(ASSET_DIR, { recursive: true });
  const manifest = {
    generator: "ez-tree",
    species: {
      spruce: [],
      pine: [],
      birch: [],
    },
  };

  for (const species of SPECIES) {
    for (const seed of SEEDS) {
      const result = await bakeOne(ez, species, seed);
      await writeFile(path.join(ASSET_DIR, result.filename), result.buffer);
      manifest.species[species].push(result.filename);
      console.log(
        `${result.filename}: ${result.buffer.length} bytes, ${result.vertices} verts, ${result.triangles} tris`,
      );
    }
  }

  await writeManifest(manifest);
  console.log("manifest.json: wrote 9 archetypes");
}

async function checkDeterminism(ez) {
  const first = await bakeOne(ez, "spruce", 1);
  const second = await bakeOne(ez, "spruce", 1);
  if (Buffer.compare(first.buffer, second.buffer) !== 0) {
    throw new Error(
      `bake-trees determinism: FAIL (${first.filename} differed across two same-process bakes)`,
    );
  }
  console.log("bake-trees determinism: PASS");
}

async function verifyFullBake(ez) {
  for (const species of SPECIES) {
    for (const seed of SEEDS) {
      const filename = path.join(ASSET_DIR, `${species}-${seed}.glb`);
      const buffer = await readFile(filename);
      if (buffer.length === 0) {
        throw new Error(`Generated empty GLB: ${filename}`);
      }
    }
  }

  const manifest = JSON.parse(await readFile(path.join(ASSET_DIR, "manifest.json"), "utf8"));
  for (const species of SPECIES) {
    const expected = SEEDS.map((seed) => `${species}-${seed}.glb`);
    const actual = manifest.species?.[species] ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Manifest entry for ${species} was ${JSON.stringify(actual)}`);
    }
  }

  await checkDeterminism(ez);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log("Usage: node tools/bake-trees.mjs [--check]");
    return;
  }

  const ez = await loadEzTreeCore();
  if (args.has("--check")) {
    await checkDeterminism(ez);
    return;
  }

  await bakeAll(ez);
  await verifyFullBake(ez);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
