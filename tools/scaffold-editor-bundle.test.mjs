import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  atlasLaunchConfig,
  derivedRuntimeLaunchConfig,
  ensureFreshEditorBundles,
  ensureFreshWorldCompilerBundle,
  parseDerivedRuntimeDiscoveryLine,
  waitForEditorHostReady,
} from "./scaffold/scripts/editor.mjs";

{
  assert.deepEqual(atlasLaunchConfig({ environment: {} }), {
    port: 4321,
    origin: "http://127.0.0.1:4321",
  });
  assert.deepEqual(atlasLaunchConfig({ environment: { LIMINA_ATLAS_PORT: "61001" } }), {
    port: 61_001,
    origin: "http://127.0.0.1:61001",
  });
  for (const port of ["0", "04321", "65536", "1.5", "not-a-port", ""]) {
    assert.throws(
      () => atlasLaunchConfig({ environment: { LIMINA_ATLAS_PORT: port } }),
      /canonical TCP port/,
    );
  }
}

{
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const ready = waitForEditorHostReady(child, stdout, 8787);
  stdout.write("[js] editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:8787/ (profiles)\n");
  await ready;

  const wrongChild = new EventEmitter();
  const wrongStdout = new PassThrough();
  const wrongReady = waitForEditorHostReady(wrongChild, wrongStdout, 8787);
  wrongStdout.write("editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:8788/\n");
  wrongChild.emit("exit", 1, null);
  await assert.rejects(wrongReady, /exited before readiness/);
}

{
  const runtime = derivedRuntimeLaunchConfig({
    uiPort: 5173,
    environment: {},
    randomBytesFn: (length) => { assert.equal(length, 32); return new Uint8Array(32).fill(0x42); },
  });
  assert.deepEqual(runtime, {
    port: 5174,
    token: Buffer.alloc(32, 0x42).toString("base64url"),
    origin: "http://localhost:5173",
  });
  assert.doesNotMatch(`http://localhost:5173/?server=ws%3A%2F%2Flocalhost%3A8787%2F`, new RegExp(runtime.token));
  assert.equal(derivedRuntimeLaunchConfig({
    uiPort: 5173,
    environment: { LIMINA_DERIVED_RUNTIME_PORT: "61000" },
    randomBytesFn: () => new Uint8Array(32),
  }).port, 61_000);
  for (const port of ["0", "05174", "65536", "1.5", "not-a-port"]) {
    assert.throws(() => derivedRuntimeLaunchConfig({
      uiPort: 5173,
      environment: { LIMINA_DERIVED_RUNTIME_PORT: port },
      randomBytesFn: () => new Uint8Array(32),
    }), /canonical TCP port/);
  }
  assert.throws(() => derivedRuntimeLaunchConfig({
    uiPort: 65_535,
    environment: {},
    randomBytesFn: () => new Uint8Array(32),
  }), /required/);
  assert.throws(() => derivedRuntimeLaunchConfig({
    uiPort: 5173,
    environment: {},
    randomBytesFn: () => new Uint8Array(31),
  }), /exactly 32 bytes/);
}

{
  const line = `[derived-runtime] ready ${JSON.stringify({
    schema: "limina.derived-runtime-discovery/v1",
    baseUrl: "http://127.0.0.1:5174",
  })}`;
  assert.deepEqual(parseDerivedRuntimeDiscoveryLine(line, 5174), {
    schema: "limina.derived-runtime-discovery/v1",
    baseUrl: "http://127.0.0.1:5174",
  });
  assert.throws(() => parseDerivedRuntimeDiscoveryLine(line, 5175), /does not match/);
  assert.throws(() => parseDerivedRuntimeDiscoveryLine(`${line}?token=secret`, 5174), /JSON|fields|match/);
  assert.throws(() => parseDerivedRuntimeDiscoveryLine(`[derived-runtime] ready ${JSON.stringify({
    schema: "limina.derived-runtime-discovery/v1",
    baseUrl: "http://127.0.0.1:5174",
    token: "leak",
  })}`, 5174), /unsupported/);
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "limina-editor-bundle-"));
  const source = join(home, "js", "src", "browser-entry.ts");
  const packageJson = join(home, "js", "package.json");
  const runtime = join(home, "editor", "vendor", "limina-runtime.js");
  const worker = join(home, "editor", "vendor", "sim-worker-entry.js");
  const derivedWorker = join(home, "editor", "vendor", "derived-runtime-worker-entry.js");
  mkdirSync(join(home, "js", "src"), { recursive: true });
  mkdirSync(join(home, "editor", "vendor"), { recursive: true });
  writeFileSync(source, "export const source = true;\n");
  writeFileSync(packageJson, '{"scripts":{"bundle:editor":"build"}}\n');
  writeFileSync(runtime, "runtime\n");
  writeFileSync(worker, "worker\n");
  writeFileSync(derivedWorker, "derived worker\n");
  const setMtime = (path, seconds) => utimesSync(path, seconds, seconds);
  setMtime(source, 10);
  setMtime(runtime, 20);
  setMtime(worker, 20);
  setMtime(derivedWorker, 20);
  return { home, source, packageJson, runtime, worker, derivedWorker, setMtime, cleanup: () => rmSync(home, { recursive: true, force: true }) };
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
    rmSync(f.derivedWorker);
    let invocation;
    const result = ensureFreshEditorBundles(f.home, { spawnSync: (command, args) => {
      invocation = { command, args };
      writeFileSync(f.runtime, "rebuilt runtime\n");
      writeFileSync(f.worker, "rebuilt worker\n");
      writeFileSync(f.derivedWorker, "rebuilt derived worker\n");
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

console.log("scaffold-editor-bundle.test OK: Atlas/runtime launch config and editor/compiler bundle freshness paths");
