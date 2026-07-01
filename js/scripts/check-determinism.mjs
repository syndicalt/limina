#!/usr/bin/env node
// check-determinism.mjs — a REAL guard replacing the copy-pasted "no Date.now /
// Math.random / performance.now" comment banners in js/src/skills/*.ts.
//
// INVARIANT ENFORCED: the skills layer is deterministic and RNG-/wall-clock-free.
// This scans every js/src/skills/*.ts source and FAILS (exit 1) if any NON-COMMENT,
// non-string code contains a wall-clock or RNG call:
//   Date.now(   new Date(   Math.random(   performance.now(
// It prints the offending file:line on failure, or "determinism check clean" on success.
//
// LIMITATION: this is a line-level lexical heuristic, NOT a parser. It tracks /* */ block
// comments across lines and strips // line comments and single-/double-/back-tick string
// literals on a best-effort basis (escaped quotes are honored; template `${...}`
// interpolations are treated as string content, so a forbidden call hidden inside one
// would be missed). A forbidden token split across two physical lines is likewise not
// detected. These cases do not occur in this codebase. No dependencies beyond node:fs.
//
// Run: `node js/scripts/check-determinism.mjs`

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "skills");
const FORBIDDEN = ["Date.now(", "new Date(", "Math.random(", "performance.now("];

// ALLOW-LIST — the ONLY skills-dir files permitted a wall-clock/RNG call (mirrors the
// allow-list in check-host-portability.mjs). registry.ts is the invocation HARNESS, not a
// deterministic skill module: its Date.now() feeds `executionTimeMs`, which is returned in
// the MCPResponse.metadata to the CALLER only and is NEVER written into the tracer event
// log — so it does not affect the deterministic world log or replay. The determinism banner
// this guard enforces lives on the skill HANDLER modules, which stay clean.
const ALLOW = new Set(["registry.ts"]);

/** Strip block comments, line comments, and string literals from one physical line,
 *  carrying the "inside a block comment" flag across lines via `state`. Returns the
 *  code-only remainder (what a forbidden call would have to appear in to count). */
function stripNonCode(line, state) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf("*/", i);
      if (end === -1) return out; // block comment runs to end of line
      i = end + 2;
      state.inBlock = false;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") return out; // rest of line is a line comment
    if (two === "/*") { state.inBlock = true; i += 2; continue; }
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip to the matching, unescaped quote (or end of line if unterminated).
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === ch) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const failures = [];
const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".ts") && !ALLOW.has(f)).sort();
for (const file of files) {
  const full = join(SKILLS_DIR, file);
  const lines = readFileSync(full, "utf8").split("\n");
  const state = { inBlock: false };
  for (let n = 0; n < lines.length; n++) {
    const code = stripNonCode(lines[n], state);
    for (const bad of FORBIDDEN) {
      if (code.includes(bad)) {
        failures.push(`${full}:${n + 1}: forbidden non-deterministic call \`${bad}\``);
      }
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  console.error(`determinism check FAILED: ${failures.length} offending line(s)`);
  process.exit(1);
}
console.log("determinism check clean");
