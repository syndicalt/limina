// SKILLS CATALOG WRITER — spawns the native limina binary on tools/dump-skills.ts,
// extracts the catalog JSON between markers, and writes it to BOTH the site's data
// import (src/data/skills.json, used by agents.astro + gen-skills-doc) and the public
// agent endpoint (public/agents/skills.json, served at /agents/skills.json).
//
//   node tools/dump-skills.mjs
//
// The binary path is overridable via LIMINA_BIN (default ./target/release/limina).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bin = process.env.LIMINA_BIN ?? path.join(root, "target/release/limina");

if (!fs.existsSync(bin)) {
  console.error(`limina binary not found at ${bin} — build it first: cargo build --release`);
  process.exit(1);
}

const run = spawnSync(bin, [path.join(root, "tools/dump-skills.ts")], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error(`limina exited with status ${run.status}`);
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

const out = run.stdout ?? "";
const begin = out.indexOf("===LIMINA_SKILLS_BEGIN===");
const end = out.indexOf("===LIMINA_SKILLS_END===");
if (begin === -1 || end === -1 || end < begin) {
  console.error("could not find skills catalog markers in binary output");
  console.error(out.slice(0, 2000));
  process.exit(1);
}
const json = out.slice(begin + "===LIMINA_SKILLS_BEGIN===".length, end).trim();

let catalog;
try {
  catalog = JSON.parse(json);
} catch (err) {
  console.error("catalog JSON failed to parse:", err.message);
  process.exit(1);
}
if (!Array.isArray(catalog.skills) || catalog.skills.length === 0) {
  console.error("catalog has no skills — refusing to write");
  process.exit(1);
}

const pretty = JSON.stringify(catalog, null, 2) + "\n";
const targets = [
  path.join(root, "site/src/data/skills.json"),
  path.join(root, "site/public/agents/skills.json"),
];
for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pretty);
  console.log(`wrote ${path.relative(root, target)} (${catalog.count} skills, ${pretty.length} bytes)`);
}
