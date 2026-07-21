#!/usr/bin/env node
// check-determinism-check.mjs — FALSIFIABILITY proof for check-determinism.mjs
// (the gates/design/check.mjs pattern: a guard is only real if a deliberately broken
// input FAILS it). Plants violating fixtures in a temp tree and asserts the checker
// exits 1 on each, including one hidden in a SUBDIRECTORY (the recursion regression:
// js/src/skills/building/*.ts was once unscanned). A clean tree must still exit 0.
//
// Run: `node js/scripts/check-determinism-check.mjs`
//   exit 0 = checker is real + falsifiable · 1 = checker is a rubber stamp

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "check-determinism.mjs");

/** Run the checker against `dir`; returns {status, output}. */
function check(dir) {
  const r = spawnSync(process.execPath, [CHECKER, dir], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const VIOLATIONS = [
  ["date-now.ts", "export const t = Date.now();"],
  ["new-date.ts", "export const d = new Date();"],
  ["math-random.ts", "export const r = Math.random();"],
  ["performance-now.ts", "export const p = performance.now();"],
  ["date-parse.ts", "export const dp = Date.parse(input);"],
  ["crypto-grv.ts", "export const b = crypto.getRandomValues(new Uint8Array(8));"],
  ["crypto-uuid.ts", "export const u = crypto.randomUUID();"],
];

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

// 1. Each banned token, alone in an otherwise-clean tree, must FAIL the checker.
for (const [name, code] of VIOLATIONS) {
  const dir = mkdtempSync(join(tmpdir(), "det-check-"));
  try {
    writeFileSync(join(dir, name), `${code}\n`);
    const r = check(dir);
    if (r.status !== 1) fail(`${name}: expected exit 1, got ${r.status}`);
    else if (!r.output.includes(name)) fail(`${name}: violation not reported by file name`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 2. RECURSION: a violation buried in a subdirectory must be found.
{
  const dir = mkdtempSync(join(tmpdir(), "det-check-"));
  try {
    mkdirSync(join(dir, "building"));
    writeFileSync(join(dir, "clean.ts"), "export const ok = 1;\n");
    writeFileSync(join(dir, "building", "nested.ts"), "export const t = Date.now();\n");
    const r = check(dir);
    if (r.status !== 1) fail(`nested violation: expected exit 1, got ${r.status}`);
    else if (!r.output.includes("nested.ts")) fail("nested violation not reported");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 3. The top-level allow-list must NOT extend into subdirectories.
{
  const dir = mkdtempSync(join(tmpdir(), "det-check-"));
  try {
    mkdirSync(join(dir, "building"));
    writeFileSync(join(dir, "building", "registry.ts"), "export const t = Date.now();\n");
    const r = check(dir);
    if (r.status !== 1) fail(`nested registry.ts should not be allow-listed (got exit ${r.status})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 4. Comments/strings must NOT trip it, and a clean tree must PASS.
{
  const dir = mkdtempSync(join(tmpdir(), "det-check-"));
  try {
    writeFileSync(join(dir, "clean.ts"), [
      "// Date.now( in a comment is fine",
      "/* Math.random( in a block comment */",
      'export const s = "crypto.randomUUID( in a string";',
      "export const ok = 1;",
      "",
    ].join("\n"));
    const r = check(dir);
    if (r.status !== 0) fail(`clean tree: expected exit 0, got ${r.status}\n${r.output}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (failures > 0) {
  console.error(`check-determinism-check FAILED: ${failures} case(s) — the determinism guard is not falsifiable.`);
  process.exit(1);
}
console.log("check-determinism-check OK: every banned token fails the checker (incl. nested dirs), clean trees pass.");
