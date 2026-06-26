#!/usr/bin/env node
// check-coordinator-demo.mjs — build + portability guard for the coordinator-demo
// web client (sibling to check-host-portability.mjs).
//
// It proves two headless-verifiable claims about coordinator-demo/:
//   1. BUILD — the browser entry (src/app.js) bundles clean for `--platform=browser`
//      (the same esbuild path the runtime + editor ship), writing dist/coordinator-
//      demo.js. A bundle failure (missing import, bad specifier) fails the check.
//   2. DENO-FREE AT MODULE INIT — the PURE modules a non-browser host could load
//      (the tested view-model builders + the MCP client) bundle for a neutral
//      platform and evaluate their module top-level with `globalThis.Deno` deleted
//      WITHOUT throwing. (app.js + the THREE world renderer touch DOM/WebGPU and are
//      browser-only by design — their render is UAT, not evaluated here.)
//
// Run: `node js/scripts/check-coordinator-demo.mjs`
// Exits 0 on success, non-zero on any failure.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = join(HERE, "..");
const REPO_ROOT = join(JS_ROOT, "..");
const DEMO_ROOT = join(REPO_ROOT, "coordinator-demo");
const DEMO_SRC = join(DEMO_ROOT, "src");
const DIST = join(DEMO_ROOT, "dist");
const OUT = join(DIST, "coordinator-demo.js");

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error("[coordinator-demo] esbuild not installed (run from js/ with node_modules present)");
  process.exit(2);
}

console.log("coordinator-demo — build + portability guard");
console.log("============================================\n");

let failed = false;

// --- 1. BUILD the browser bundle -------------------------------------------
mkdirSync(DIST, { recursive: true });
try {
  await esbuild.build({
    entryPoints: [join(DEMO_SRC, "app.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: OUT,
    logLevel: "silent",
    resolveExtensions: [".ts", ".mjs", ".js"],
    loader: { ".ts": "ts" },
  });
  const bytes = statSync(OUT).size;
  console.log(`[build] PASS — bundled src/app.js -> dist/coordinator-demo.js (${bytes.toLocaleString()} bytes, --platform=browser)`);
} catch (e) {
  failed = true;
  console.log(`[build] FAIL — esbuild could not bundle src/app.js:\n        ${String(e.message || e).split("\n")[0]}`);
}

// --- 2. DENO-FREE module-init for the pure modules -------------------------
async function bundleAndEval(entryAbs) {
  let bundled;
  try {
    const res = await esbuild.build({
      entryPoints: [entryAbs],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      logLevel: "silent",
      resolveExtensions: [".ts", ".mjs", ".js"],
      loader: { ".ts": "ts" },
    });
    bundled = res.outputFiles[0].text;
  } catch (e) {
    return { ok: false, phase: "bundle", error: String(e.message || e) };
  }
  const dir = mkdtempSync(join(tmpdir(), "coord-demo-"));
  const bundlePath = join(dir, "bundle.mjs");
  const runnerPath = join(dir, "runner.mjs");
  writeFileSync(bundlePath, bundled);
  writeFileSync(
    runnerPath,
    [
      "delete globalThis.Deno;",
      'if (typeof globalThis.Deno !== "undefined") { console.error("DENO_PRESENT"); process.exit(3); }',
      "try {",
      `  await import(${JSON.stringify("file://" + bundlePath)});`,
      '  console.log("OK");',
      "} catch (e) {",
      '  console.error("THREW:" + (e && e.stack ? e.stack : e)); process.exit(4);',
      "}",
    ].join("\n"),
  );
  const proc = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (proc.status === 0) return { ok: true };
  return { ok: false, phase: "eval", error: (proc.stderr || proc.stdout || "").trim() };
}

const PURE = ["viewmodel.js", "mcp-client.js"];
console.log("\n[portability] evaluating pure-module init with `globalThis.Deno` deleted:");
for (const rel of PURE) {
  const r = await bundleAndEval(join(DEMO_SRC, rel));
  if (r.ok) {
    console.log(`  PASS  src/${rel}`);
  } else {
    failed = true;
    console.log(`  FAIL  src/${rel}  (${r.phase})`);
    console.log(`        ${(r.error || "").split("\n")[0]}`);
  }
}

console.log(`\nVERDICT: coordinator-demo ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
