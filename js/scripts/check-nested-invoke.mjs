#!/usr/bin/env node
// check-nested-invoke.mjs — a REAL guard for the WorldRecorder chainId contract.
//
// INVARIANT ENFORCED: any object literal built as a registry `invoke` BASE from a
// handler's `ctx.*` MUST thread `chainId: ctx.chainId`. Otherwise the WorldRecorder
// records the nested call as a SEPARATE top-level command, and replay applies it
// TWICE (the recorded parent re-runs the nested call on replay -- a double-apply).
// The single-thread recorder can't use ambient async context (the embedded host
// exposes no AsyncLocalStorage), so the chain MUST be declared explicitly in the
// data, at every nesting site.
//
// This scans every js/src/**/*.ts source and FAILS (exit 1) if it finds an object
// literal that:
//   1. is passed as the trailing argument to a `.invoke(` call, OR assigned to an
//      `InvokeBase`-typed / `*base`-named binding; AND
//   2. references `ctx.` (so it can ONLY exist where a handler's `ctx` is in scope
//      -- top-level/demo bases never reference `ctx`, which is what keeps this
//      precise); AND
//   3. does NOT contain `chainId`.
//
// Strings and comments are stripped first (strings -> spaces, preserving length and
// newlines) so a `ctx.` or a `chainId` inside a string/comment can neither trigger
// nor satisfy the check. Brace matching then runs on the code-only text, so fake
// braces inside strings can't unbalance it.
//
// LIMITATIONS: line/column reporting is by stripped-text index (good enough to jump
// to the site). Template-literal interpolations ${...} are treated as string content
// (a `ctx.` hidden inside one is missed) -- base literals do not use them. Regex
// literals are not specially recognized (a `/` could be misread) -- base-construction
// code does not use them. These cases do not occur in this codebase. No deps beyond
// node:fs/node:path. Mirrors the lexical-guard style of check-determinism.mjs.
//
// Run: `node js/scripts/check-nested-invoke.mjs`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src"); // js/src
const BASE_KEYS = ["agentId", "sessionId", "permissions", "tick", "world"];

/** List all .ts files under `dir` recursively. */
function tsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsFiles(p));
    else if (ent.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Strip strings and comments to spaces, preserving length and newlines, keeping
 *  all structural chars ({}()[]:,;) and identifiers. Lets brace matching and
 *  ctx./chainId detection run on code-only text. */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? n : nl;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += " ";
      i++;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { out += "  "; i += 2; continue; }
        if (d === c) { out += " "; i++; break; }
        out += d === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 1-based line number of `idx` in `code` (newlines preserved by strip). */
function lineOf(code, idx) {
  let line = 1;
  for (let k = 0; k < idx && k < code.length; k++) if (code[k] === "\n") line++;
  return line;
}

/** Index of the matching `}` for the `{` at `open`, over code-only text. */
function matchBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Range {start,end} of the LAST top-level argument of the call whose `(` is at
 *  `open`. Comma-splits at the call's own depth only (commas inside nested
 *  ()/[]/{} are not separators), so for `invoke(name, {input}, {base})` it returns
 *  the {base} range, NOT the {input} range. */
function lastCallArgRange(code, open) {
  let depth = 0;
  let argStart = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return { start: argStart, end: i };
    } else if (c === "," && depth === 1) {
      argStart = i + 1;
    }
  }
  return null;
}

/** Does `litText` (code-only) look like a hand-built invoke BASE that copies a
 *  handler ExecutionContext's IDENTITY without threading chainId? Requires
 *  `ctx.(agentId|sessionId|permissions)` -- the ExecutionContext identity fields --
 *  (not generic `ctx.`, which also names runDecision's local {perception,world,tick}
 *  view and the sandbox bridge's top-level capability calls, neither of which nests)
 *  AND >=2 base-shaped keys, so an incidental object can't trip it. */
function missingChainId(litText) {
  if (!/\bctx\s*\.\s*(?:agentId|sessionId|permissions)\b/.test(litText)) return false;
  if (/\bchainId\b/.test(litText)) return false; // threads chainId -> OK
  const present = BASE_KEYS.filter((k) => new RegExp(`\\b${k}\\b`).test(litText)).length;
  return present >= 2;
}

const RE_INVOKE = /\.invoke\s*\(/g;
const RE_BASEDECL =
  /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[\w$.]*InvokeBase\b[^=]*=\s*\{|(?:const|let|var)\s+[A-Za-z_$]\w*[Bb]ase\b\s*(?::[^=]+)?=\s*\{/g;

let violations = 0;
const files = tsFiles(ROOT);

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const code = strip(src);
  const sites = new Set(); // line -> kind, dedupe per line

  // Anchor A: object literals passed as the trailing arg of `.invoke(`.
  for (const m of code.matchAll(RE_INVOKE)) {
    const open = m.index + m[0].length - 1; // the '('
    const range = lastCallArgRange(code, open);
    if (range === null) continue;
    // First non-space char of the last arg must be '{' for it to be an object base.
    let braceOpen = -1;
    for (let k = range.start; k < range.end; k++) {
      if (code[k] !== " " && code[k] !== "\t" && code[k] !== "\n" && code[k] !== "\r") { braceOpen = code[k] === "{" ? k : -1; break; }
    }
    if (braceOpen === -1) continue; // last arg is not an object literal (e.g. a `base` var)
    const braceClose = matchBrace(code, braceOpen);
    const lit = code.slice(braceOpen, braceClose === -1 ? code.length : braceClose + 1);
    if (missingChainId(lit)) sites.add(`:${lineOf(code, braceOpen)}: nested .invoke base built from ctx.* without chainId`);
  }

  // Anchor B: object literals assigned to an InvokeBase-typed / *base-named binding.
  for (const m of code.matchAll(RE_BASEDECL)) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBrace(code, braceOpen);
    const lit = code.slice(braceOpen, braceClose === -1 ? code.length : braceClose + 1);
    if (missingChainId(lit)) sites.add(`:${lineOf(code, braceOpen)}: InvokeBase/base binding built from ctx.* without chainId`);
  }

  for (const s of sites) {
    console.error(`${relative(process.cwd(), file)}${s}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(`\ncheck-nested-invoke: ${violations} site(s) build a nested invoke base from ctx.* without threading chainId.`);
  console.error("Add `chainId: ctx.chainId` to each, or the WorldRecorder double-records it (replay applies it twice).");
  process.exit(1);
}
console.log("check-nested-invoke clean");
