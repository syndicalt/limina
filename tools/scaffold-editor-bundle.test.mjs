import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureFreshEditorBundles, ensureFreshWorldCompilerBundle } from "./scaffold/scripts/editor.mjs";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "limina-editor-bundle-"));
  const source = join(home, "js", "src", "browser-entry.ts");
  const packageJson = join(home, "js", "package.json");
  const runtime = join(home, "editor", "vendor", "limina-runtime.js");
  const worker = join(home, "editor", "vendor", "sim-worker-entry.js");
  mkdirSync(join(home, "js", "src"), { recursive: true });
  mkdirSync(join(home, "editor", "vendor"), { recursive: true });
  writeFileSync(source, "export const source = true;\n");
  writeFileSync(packageJson, '{"scripts":{"bundle:editor":"build"}}\n');
  writeFileSync(runtime, "runtime\n");
  writeFileSync(worker, "worker\n");
  const setMtime = (path, seconds) => utimesSync(path, seconds, seconds);
  setMtime(source, 10);
  setMtime(runtime, 20);
  setMtime(worker, 20);
  return { home, source, packageJson, runtime, worker, setMtime, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function compilerFixture() {
  const f = fixture();
  const bundle = join(f.home, "js", "build", "world-compiler.bundle.mjs");
  mkdirSync(join(f.home, "js", "build"), { recursive: true });
  writeFileSync(bundle, "compiler\n");
  f.setMtime(bundle, 20);
  return { ...f, bundle };
}

{
  const f = fixture();
  try {
    let spawned = false;
    const result = ensureFreshEditorBundles(f.home, { spawnSync: () => { spawned = true; return { status: 0 }; } });
    assert.equal(result.rebuilt, false);
    assert.equal(spawned, false, "fresh bundles must not rebuild");
  } finally { f.cleanup(); }
}

{
  const f = fixture();
  try {
    rmSync(f.worker);
    let invocation;
    const result = ensureFreshEditorBundles(f.home, { spawnSync: (command, args) => {
      invocation = { command, args };
      writeFileSync(f.runtime, "rebuilt runtime\n");
      writeFileSync(f.worker, "rebuilt worker\n");
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.rebuilt, true);
    assert.deepEqual(invocation, {
      command: "npm",
      args: ["--prefix", join(f.home, "js"), "run", "bundle:editor"],
    });
  } finally { f.cleanup(); }
}

{
  const f = fixture();
  try {
    f.setMtime(f.source, 30);
    assert.throws(
      () => ensureFreshEditorBundles(f.home, { spawnSync: () => ({ status: 1, stderr: "esbuild missing" }) }),
      /failed to build editor runtime.*esbuild missing.*Install the Limina JavaScript dependencies/,
    );
  } finally { f.cleanup(); }
}

{
  const f = fixture();
  try {
    rmSync(f.packageJson);
    assert.throws(
      () => ensureFreshEditorBundles(f.home, { spawnSync: () => { throw new Error("must not spawn"); } }),
      /source\/build metadata is missing.*complete Limina release/,
    );
  } finally { f.cleanup(); }
}

{
  const f = compilerFixture();
  try {
    let spawned = false;
    const result = ensureFreshWorldCompilerBundle(f.home, { spawnSync: () => { spawned = true; return { status: 0 }; } });
    assert.equal(result.rebuilt, false);
    assert.equal(result.bundle, f.bundle);
    assert.equal(spawned, false, "fresh world compiler must not rebuild");
  } finally { f.cleanup(); }
}

{
  const f = compilerFixture();
  try {
    rmSync(f.bundle);
    let invocation;
    const result = ensureFreshWorldCompilerBundle(f.home, { spawnSync: (command, args) => {
      invocation = { command, args };
      writeFileSync(f.bundle, "rebuilt compiler\n");
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.rebuilt, true);
    assert.deepEqual(invocation, {
      command: "npm",
      args: ["--prefix", join(f.home, "js"), "run", "bundle:world-compiler"],
    });
  } finally { f.cleanup(); }
}

{
  const f = compilerFixture();
  try {
    f.setMtime(f.source, 30);
    assert.throws(
      () => ensureFreshWorldCompilerBundle(f.home, { spawnSync: () => ({ status: 1, stderr: "compiler build failed" }) }),
      /failed to build world compiler.*compiler build failed.*Install the Limina JavaScript dependencies/,
    );
  } finally { f.cleanup(); }
}

console.log("scaffold-editor-bundle.test OK: editor and world-compiler fresh, missing, stale-failure, and incomplete-release paths");
