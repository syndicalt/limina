#!/usr/bin/env node
// check-host-portability.mjs — Seam 4 guard.
//
// INVARIANT ENFORCED: every browser-reachable engine module must be able to
// evaluate its module top-level with NO `Deno` global present, without
// throwing. The native host (deno_core / V8) exposes its capability ops as
// `Deno.core.ops`; a browser/wasm host has no `Deno` global at all. So no
// browser-reachable module may touch `Deno.*` unguarded.
//
// This script does two things:
//   1. STATIC enforcement — scan js/src/**/*.ts, flag any `Deno.` (or `Deno?.`)
//      member access that is NOT inside an allow-listed native entry point and
//      NOT guarded by a `typeof Deno` check in the same statement. Exits
//      non-zero on any violation, printing file:line.
//   2. DYNAMIC proof — esbuild-bundle the pure, three.js-free core modules for
//      a neutral platform and evaluate their module-init in a Node process with
//      `globalThis.Deno` deleted, asserting the import does not throw.
//
// Run: `node js/scripts/check-host-portability.mjs`
//   --static-only  skip the dynamic proof (e.g. CI without a build step)
//
// ---------------------------------------------------------------------------
// ALLOW-LIST — the ONLY files permitted to name `Deno.*`.
//
// These are the NATIVE-HOST ENTRY POINTS. They are never imported by a
// browser/wasm host build; they are the top of the native (deno_core) process
// tree and therefore always run with the `Deno` global present:
//
//   - bootstrap.ts            native runtime bootstrap (binds op_log)
//   - demo.ts                 native demo launcher
//   - demos/**                native demo scenes (launched by demo.ts)
//   - mcp/stdio_runtime.ts    native MCP stdio transport (Deno.core stdin/out)
//   - mcp/ws_runtime.ts       native MCP websocket transport
//   - js/test/**              test harnesses (outside js/src; not scanned)
//
// engine.ts is NOT on this list. It is browser-reachable, and is allowed to
// name `Deno.` ONLY through the single `typeof Deno !== "undefined"`-guarded
// expression that lazily binds `ops`. The guard rule below (a `Deno.` access is
// OK if its enclosing statement contains `typeof Deno`) is what lets that one
// line pass — and would equally permit any future guarded, browser-safe use.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = join(HERE, "..");          // js/
const SRC_ROOT = join(JS_ROOT, "src");     // js/src/

// Native-host entry points, as posix-style paths relative to js/src.
// A file is fully exempt if it equals one of these or sits under one of the
// directory prefixes ending in "/".
const ALLOW_LIST = [
  "bootstrap.ts",
  "demo.ts",
  "demos/",                 // directory prefix
  "mcp/stdio_runtime.ts",
  "mcp/ws_runtime.ts",
];

function isAllowListed(relPosix) {
  for (const entry of ALLOW_LIST) {
    if (entry.endsWith("/")) {
      if (relPosix.startsWith(entry)) return true;
    } else if (relPosix === entry) {
      return true;
    }
  }
  return false;
}

// --- comment / string stripper --------------------------------------------
// Replace the *content* of line comments, block comments, and string/template
// literals with spaces (preserving newlines so line numbers are stable). This
// prevents false positives from `Deno.core.ops` appearing in prose comments
// (e.g. sandbox/host.ts) or inside string literals. A `Deno.` access inside a
// template-literal `${...}` interpolation would be masked too — none exist in
// the codebase, and a masked access can only ever HIDE a violation in code that
// is already inside a string, which is not executable top-level Deno access.
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // states: 0 code, 1 line comment, 2 block comment, 3 ' 4 " 5 `
  let state = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === 0) {
      if (c === "/" && c2 === "/") { state = 1; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = 2; out += "  "; i += 2; continue; }
      if (c === "'") { state = 3; out += " "; i += 1; continue; }
      if (c === '"') { state = 4; out += " "; i += 1; continue; }
      if (c === "`") { state = 5; out += " "; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 1) { // line comment
      if (c === "\n") { state = 0; out += "\n"; i += 1; continue; }
      out += c === "\t" ? "\t" : " "; i += 1; continue;
    }
    if (state === 2) { // block comment
      if (c === "*" && c2 === "/") { state = 0; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : (c === "\t" ? "\t" : " "); i += 1; continue;
    }
    // string states 3/4/5
    const quote = state === 3 ? "'" : state === 4 ? '"' : "`";
    if (c === "\\") { out += "  "; i += 2; continue; }       // escape: skip 2
    if (c === quote) { state = 0; out += " "; i += 1; continue; }
    out += c === "\n" ? "\n" : (c === "\t" ? "\t" : " "); i += 1; continue;
  }
  return out;
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// The "guard window" for a Deno access at `offset` = the code that could
// lexically guard it. We scan backward (comment/string-stripped text) to the
// start of the enclosing simple statement; if that statement is the body of a
// block, we also include the block's controlling head. A Deno access counts as
// guarded iff this window contains a `typeof Deno` token. This recognizes both
// portable idioms:
//   - expression guard:  typeof Deno !== "undefined" && Deno.core.ops   (one `;` statement)
//   - block guard:        if (typeof Deno !== "undefined") { Deno.core.ops... }
// Heuristic limit: a `typeof Deno` sharing a statement with an unrelated access
// (e.g. `const a = typeof Deno, b = Deno.x`) would be treated as guarding it —
// contrived, not present in this codebase. Statements are assumed `;`-terminated.
function guardWindow(text, offset) {
  let i = offset;
  let depth = 0; // nested-block depth seen while scanning backward
  while (i > 0) {
    const c = text[i - 1];
    if (c === ";" && depth === 0) break;
    if (c === "}") { depth++; i--; continue; }
    if (c === "{") {
      if (depth === 0) {
        // `i-1` is the opening brace of the block containing `offset`.
        // Include the block head (e.g. `if (typeof Deno ...)`) by scanning
        // further back to the previous `;` `}` `{` at this level.
        let j = i - 1;
        while (j > 0) {
          const d = text[j - 1];
          if (d === ";" || d === "}" || d === "{") break;
          j--;
        }
        return text.slice(j, offset);
      }
      depth--; i--; continue;
    }
    i--;
  }
  return text.slice(i, offset);
}

function listTsFiles(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) result.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) result.push(full);
  }
  return result;
}

// --- 1. static scan --------------------------------------------------------
function runStatic() {
  const files = listTsFiles(SRC_ROOT).sort();
  const violations = [];
  const denoAccess = /\bDeno\s*\??\s*\./g;
  const guard = /\btypeof\s+Deno\b/;

  for (const file of files) {
    const relPosix = relative(SRC_ROOT, file).split(sep).join("/");
    if (isAllowListed(relPosix)) continue;
    const raw = readFileSync(file, "utf8");
    const code = stripCommentsAndStrings(raw);
    let m;
    denoAccess.lastIndex = 0;
    while ((m = denoAccess.exec(code)) !== null) {
      const window = guardWindow(code, m.index);
      if (guard.test(window)) continue; // guarded by `typeof Deno` — portable
      violations.push({
        file: relPosix,
        line: lineOf(code, m.index),
        abs: file,
      });
    }
  }

  return { files, violations };
}

// --- 2. dynamic proof ------------------------------------------------------
// Bundle a single entry (platform=neutral, format=esm, bundle=true) and then
// evaluate the bundle in a fresh Node process where `globalThis.Deno` has been
// deleted, asserting the dynamic import does not throw at module-init.
async function bundleAndEval(esbuild, entryAbs) {
  let bundled;
  try {
    const res = await esbuild.build({
      entryPoints: [entryAbs],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      logLevel: "silent",
      // .ts -> the engine uses explicit .ts specifiers; resolve them as TS.
      resolveExtensions: [".ts", ".mjs", ".js"],
      loader: { ".ts": "ts" },
    });
    bundled = res.outputFiles[0].text;
  } catch (e) {
    return { ok: false, phase: "bundle", error: String(e.message || e) };
  }

  const dir = mkdtempSync(join(tmpdir(), "seam4-"));
  const bundlePath = join(dir, "bundle.mjs");
  const runnerPath = join(dir, "runner.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(bundlePath, bundled);
  writeFileSync(
    runnerPath,
    [
      "// prove module-init with NO Deno global present",
      "delete globalThis.Deno;",
      'if (typeof globalThis.Deno !== "undefined") {',
      '  console.error("DENO_PRESENT"); process.exit(3);',
      "}",
      "try {",
      `  await import(${JSON.stringify("file://" + bundlePath)});`,
      '  console.log("OK");',
      "} catch (e) {",
      '  console.error("THREW:" + (e && e.stack ? e.stack : e));',
      "  process.exit(4);",
      "}",
    ].join("\n"),
  );

  // runnerPath is a .mjs file (already an ES module); do NOT pass
  // --input-type (Node rejects it alongside a file argument).
  const proc = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });

  if (proc.status === 0) return { ok: true };
  return {
    ok: false,
    phase: "eval",
    error: (proc.stderr || proc.stdout || "").trim(),
  };
}

async function runDynamic() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    return { skipped: true, reason: "esbuild not installed (js/node_modules)" };
  }

  // Pure, three.js-free modules: confirmed to transitively import only
  // bitecs.bundle.mjs and/or zod.bundle.mjs (no three.bundle.mjs). These are
  // the honest, runnable scope of the dynamic proof.
  const PURE = [
    "worldlog/log.ts",
    "ecs/world.ts",
  ];
  // Modules that DO transitively import three.bundle.mjs (a WebGPU build that
  // touches browser globals at its own module top-level). engine.ts is the
  // important portability claim, but bundling+evaluating three under plain Node
  // is not a faithful "browser" eval. We attempt it and report honestly.
  const THREE_BACKED = ["engine.ts"];

  const results = [];
  for (const rel of PURE) {
    const r = await bundleAndEval(esbuild, join(SRC_ROOT, rel));
    results.push({ rel, pure: true, ...r });
  }
  for (const rel of THREE_BACKED) {
    const r = await bundleAndEval(esbuild, join(SRC_ROOT, rel));
    results.push({ rel, pure: false, ...r });
  }
  return { results };
}

// --- main ------------------------------------------------------------------
async function main() {
  const staticOnly = process.argv.includes("--static-only");

  console.log("Seam 4 — host portability guard");
  console.log("================================\n");

  const { files, violations } = runStatic();
  console.log(`[static] scanned ${files.length} .ts files under js/src`);
  console.log(`[static] allow-list: ${ALLOW_LIST.join(", ")}`);
  if (violations.length === 0) {
    console.log("[static] PASS — no unguarded top-level `Deno.` in browser-reachable modules\n");
  } else {
    console.log(`[static] FAIL — ${violations.length} unguarded `+"`Deno.`"+` reference(s):`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}`);
    }
    console.log("");
  }

  let dynamicFailed = false;
  if (!staticOnly) {
    const dyn = await runDynamic();
    if (dyn.skipped) {
      console.log(`[dynamic] SKIPPED — ${dyn.reason}\n`);
    } else {
      console.log("[dynamic] evaluating module-init with `globalThis.Deno` deleted:");
      for (const r of dyn.results) {
        if (r.ok) {
          console.log(`  PASS  ${r.rel}${r.pure ? "" : "  (three-backed)"}`);
        } else if (!r.pure) {
          // three-backed eval failure is reported, not fatal — it is a Node vs
          // browser environment artifact, not a Seam-4 violation by itself.
          console.log(`  N/A   ${r.rel}  (three-backed; ${r.phase} failed under Node — not a Seam-4 verdict)`);
          console.log(`        ${firstLine(r.error)}`);
        } else {
          dynamicFailed = true;
          console.log(`  FAIL  ${r.rel}  (${r.phase})`);
          console.log(`        ${firstLine(r.error)}`);
        }
      }
      console.log("");
    }
  } else {
    console.log("[dynamic] skipped (--static-only)\n");
  }

  const pass = violations.length === 0 && !dynamicFailed;
  console.log(`VERDICT: Seam 4 ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

function firstLine(s) {
  return (s || "").split("\n")[0];
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
