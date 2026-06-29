#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  create-limina-app — scaffold a new Limina world project.
//
//    npx create-limina-app my-world
//    node tools/create-limina-app/index.mjs my-world      (from the limina repo)
//
//  Copies the scaffold template into the target directory, substitutes the app
//  name, validates the target, and prints the next steps. Zero dependencies.
// ════════════════════════════════════════════════════════════════════════════

import { readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const PLACEHOLDER = "__APP_NAME__";
// Substitute the placeholder only in genuine text templates; copy everything
// else (the 4 MB player, the sample bundle .jsonl) verbatim.
const TEXT_EXTS = new Set([".json", ".md", ".html", ".ts", ".mjs", ".js", ".txt", ".gitignore"]);
const VERBATIM = (relPath) => relPath.includes("limina-player.js") || relPath.split(sep).includes("island");

function die(msg, { usage = false } = {}) {
  console.error(`\ncreate-limina-app: ${msg}`);
  if (usage) console.error(USAGE);
  console.error("");
  process.exit(1);
}

const USAGE = `
Usage:  create-limina-app <project-directory> [options]

Options:
  --force        Scaffold into a non-empty directory (existing files are kept;
                 same-named template files are overwritten).
  -h, --help     Show this help.
  -v, --version  Print the version.

Example:
  npx create-limina-app my-world
`;

/** Parse argv into { target, force, help, version }. Rejects unknown flags. */
function parseArgs(argv) {
  const out = { target: undefined, force: false, help: false, version: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "-v" || arg === "--version") out.version = true;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("-")) die(`unknown option: ${arg}`, { usage: true });
    else if (out.target === undefined) out.target = arg;
    else die(`unexpected extra argument: ${arg}`, { usage: true });
  }
  return out;
}

/** Locate the scaffold template dir (repo layout, or bundled inside the package). */
function findScaffold() {
  const candidates = [
    join(__dirname, "..", "scaffold"), // repo layout: tools/scaffold
    join(__dirname, "scaffold"),       // published: bundled copy
    join(__dirname, "template"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "world.ts"))) return dir;
  }
  die(
    "could not locate the scaffold template.\n" +
    "  Looked in:\n    " + candidates.join("\n    "),
  );
}

/** Validate + normalize the requested app name (npm-package-ish). */
function validateName(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    die(
      `invalid project name "${name}".\n` +
      "  Use lowercase letters, digits, '-', '_' or '.', starting with a letter or digit\n" +
      "  (e.g. my-world).",
    );
  }
  return name;
}

/** Recursively gather files (relative paths) under a dir. */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full));
  }
  return acc;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) { console.log(PKG_VERSION); return; }
  if (args.help || args.target === undefined) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const targetDir = resolve(process.cwd(), args.target);
  const appName = validateName(basename(targetDir));

  // Validate the target directory: must not exist, or be empty (unless --force).
  if (existsSync(targetDir)) {
    if (!statSync(targetDir).isDirectory()) die(`target exists and is not a directory: ${targetDir}`);
    const contents = readdirSync(targetDir).filter((n) => n !== ".git");
    if (contents.length > 0 && !args.force) {
      die(
        `target directory is not empty: ${targetDir}\n` +
        `  Refusing to overwrite. Use --force to scaffold into it anyway, or pick a new directory.`,
      );
    }
  }

  const scaffold = findScaffold();
  const files = walk(scaffold);
  if (files.length === 0) die(`scaffold template is empty: ${scaffold}`);

  mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const rel of files) {
    const src = join(scaffold, rel);
    const dest = join(targetDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "";
    if (!VERBATIM(rel) && TEXT_EXTS.has(ext)) {
      const text = readFileSync(src, "utf8").split(PLACEHOLDER).join(appName);
      writeFileSync(dest, text);
    } else {
      copyFileSync(src, dest);
    }
    copied++;
  }

  console.log(`\n  Created ${appName} at ${targetDir}  (${copied} files)\n`);
  console.log("  Next steps:\n");
  console.log(`    cd ${args.target}`);
  console.log("    npm install");
  console.log("    npm run dev      # play the sample instantly — no native toolchain\n");
  console.log("  Then author your world in world.ts and:\n");
  console.log("    npm run export   # build dist/ (needs the native limina binary; see README)");
  console.log("    npm run serve    # play your world\n");
}

main();
