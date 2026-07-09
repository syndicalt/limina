// SKILLS CATALOG WRITER — spawns the native limina binary on tools/dump-skills.ts,
// extracts the catalog JSON between markers, stamps it with the engine version, and
// writes it to the site's data import (src/data/skills.json, used by agents.astro +
// gen-skills-doc), the public agent endpoint (public/agents/skills.json, served at
// /agents/skills.json), and a generated Markdown capability doc
// (public/agents/capabilities.md, served at /agents/capabilities.md).
//
//   node tools/dump-skills.mjs
//
// The binary path is overridable via LIMINA_BIN (default ./target/release/limina).
//
// ENGINE VERSION: sourced from `[workspace.package].version` in the repo-root
// Cargo.toml (the version every crate, including the `limina` binary, inherits via
// `version.workspace = true`) plus the short git SHA of HEAD. js/package.json has no
// "version" field (it's `"private": true` with none set), so the workspace crate
// version is the only real semantic version in the repo; the SHA is appended because
// the crate version (0.1.0) does not change per-commit during pre-1.0 development —
// without it, every catalog snapshot before the next version bump would stamp
// identically despite the underlying skill surface changing. Format: "<semver>+<sha>"
// (falls back to bare "<semver>" if git is unavailable, e.g. an exported tarball).

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

function workspaceCrateVersion() {
  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const section = cargoToml.match(/\[workspace\.package\]([\s\S]*?)(\n\[|$)/);
  const m = section && section[1].match(/\nversion\s*=\s*"([^"]+)"/);
  if (!m) {
    console.error("could not find [workspace.package] version in Cargo.toml");
    process.exit(1);
  }
  return m[1];
}

function shortGitSha() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function engineVersion() {
  const semver = workspaceCrateVersion();
  const sha = shortGitSha();
  return sha ? `${semver}+${sha}` : semver;
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

let rawCatalog;
try {
  rawCatalog = JSON.parse(json);
} catch (err) {
  console.error("catalog JSON failed to parse:", err.message);
  process.exit(1);
}
if (!Array.isArray(rawCatalog.skills) || rawCatalog.skills.length === 0) {
  console.error("catalog has no skills — refusing to write");
  process.exit(1);
}

const version = engineVersion();

// Stamp the catalog. Existing consumers (site/src/pages/agents.astro,
// site/scripts/gen-skills-doc.mjs, site/scripts/gen-llms.mjs) all read the top-level
// object by field name (.count, .skills, .permissionProfiles, ...) — none treat
// skills.json as a bare array, so adding fields here is backward-compatible. Key
// order is rebuilt for readability (version info up front); no data is dropped.
const { engine, ...rest } = rawCatalog;
const catalog = {
  engine,
  engineVersion: version,
  generatedFrom: "skills-catalog",
  generatedAt: new Date().toISOString(),
  ...rest,
};

const pretty = JSON.stringify(catalog, null, 2) + "\n";
const jsonTargets = [
  path.join(root, "site/src/data/skills.json"),
  path.join(root, "site/public/agents/skills.json"),
];
for (const target of jsonTargets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pretty);
  console.log(`wrote ${path.relative(root, target)} (${catalog.count} skills, ${pretty.length} bytes)`);
}

// ── Markdown capability doc ──────────────────────────────────────────────────────
// Plain, agent/human-readable rundown of the same catalog: grouped by category, one
// skill per entry with its permissions and a compact input-field list. No prose, no
// marketing — this is a reference table in prose form.
function typeList(fields) {
  const keys = Object.keys(fields ?? {});
  if (keys.length === 0) return "_none_";
  return keys.map((k) => `\`${k}: ${fields[k]}\``).join(", ");
}

function permList(perms) {
  return perms && perms.length ? perms.map((p) => `\`${p}\``).join(" ") : "_none_";
}

function buildCapabilityMarkdown(cat) {
  const byCategory = new Map();
  for (const skill of cat.skills) {
    if (!byCategory.has(skill.category)) byCategory.set(skill.category, []);
    byCategory.get(skill.category).push(skill);
  }
  const categories = [...byCategory.keys()].sort();

  let md = `# Limina capability catalog\n\n`;
  md += `Engine version: ${cat.engineVersion}\n`;
  md += `Generated: ${cat.generatedAt}\n`;
  md += `Generated from: the live skill registry (\`js/src/skills/*\` via \`tools/dump-skills.ts\`) — this file cannot drift from the engine because it is built from the same registry the binary boots.\n`;
  md += `Regenerate: \`node tools/dump-skills.mjs\` (requires \`cargo build --release\` first).\n\n`;
  md += `${cat.count} skills across ${categories.length} categories. Each skill is a typed, permissioned, recorded mutation invoked via \`SkillRegistry.invoke\` and maps 1:1 to an MCP tool of the same name. Full JSON Schema (draft-07) for every input/output lives in the sibling \`skills.json\`.\n\n`;
  md += `Permission profiles:\n\n`;
  for (const [profile, list] of Object.entries(cat.permissionProfiles)) {
    md += `- \`${profile}\`: ${list.length ? list.map((p) => `\`${p}\``).join(" ") : "_none_"}\n`;
  }
  md += `\n---\n`;

  for (const category of categories) {
    const skills = byCategory.get(category).sort((a, b) => a.name.localeCompare(b.name));
    md += `\n## ${category} (${skills.length})\n\n`;
    for (const s of skills) {
      md += `### \`${s.name}\` (v${s.version})\n\n`;
      md += `${s.description}\n\n`;
      md += `- Permissions: ${permList(s.permissions)}\n`;
      md += `- Priority: \`${s.priority}\`\n`;
      md += `- Input: ${typeList(s.input)}\n`;
      md += `- Output: ${typeList(s.output)}\n\n`;
    }
  }
  return md;
}

const capabilityMd = buildCapabilityMarkdown(catalog);
const mdTarget = path.join(root, "site/public/agents/capabilities.md");
fs.mkdirSync(path.dirname(mdTarget), { recursive: true });
fs.writeFileSync(mdTarget, capabilityMd);
console.log(`wrote ${path.relative(root, mdTarget)} (${capabilityMd.length} bytes)`);
console.log(`engine version: ${version}`);
