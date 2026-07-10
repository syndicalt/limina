import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadBuildProjectConfig } from "./design/build-world.mjs";
import { loadProjectConfig, ProjectConfigError } from "./project-config.mjs";
import { editorHostEnvironment, loadEditorProjectConfig } from "./scaffold/scripts/editor.mjs";
import { loadExportProjectConfig } from "./scaffold/scripts/export.mjs";

const LIMINA_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(config, source) {
  const root = mkdtempSync(join(tmpdir(), "limina-project-config-"));
  if (source !== undefined) writeFileSync(join(root, "limina.project.json"), source, "utf8");
  else if (config !== undefined) writeFileSync(join(root, "limina.project.json"), `${JSON.stringify(config)}\n`, "utf8");
  return root;
}

function valid(projectId = "grey-field") {
  return { schema: "limina-project/1", projectId, assetRoot: "assets", stateDir: ".limina" };
}

function rejects(root, pattern) {
  assert.throws(() => loadProjectConfig(root), (error) => {
    assert.ok(error instanceof ProjectConfigError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("loads the strict project identity from the explicit root", () => {
  const root = fixture(valid());
  try {
    const config = loadProjectConfig(root);
    assert.equal(config.schema, "limina-project/1");
    assert.equal(config.projectId, "grey-field");
    assert.equal(config.projectRoot, root);
    assert.ok(Object.isFrozen(config));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not use package.json or directory-name fallbacks", () => {
  const root = fixture(undefined);
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fallback-name" }));
    rejects(root, /limina\.project\.json does not exist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects malformed JSON, non-object roots, duplicate fields, wrong schemas, and extra fields", () => {
  const cases = [
    ["{", /not valid JSON/],
    ["[]", /must contain one JSON object/],
    ['{"schema":"limina-project\/1","projectId":"one","projectId":"two"}', /duplicate field "projectId"/],
    ['{"schema":"limina-project\/1","projectId":"one","\\u0070rojectId":"two"}', /duplicate field "projectId"/],
    [JSON.stringify({ schema: "limina-project/2", projectId: "one" }), /schema must be exactly/],
    [JSON.stringify({ schema: "limina-project/1", projectId: "one", name: "ignored" }), /unsupported field.*name/],
  ];
  for (const [source, pattern] of cases) {
    const root = fixture(undefined, source);
    try { rejects(root, pattern); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejects invalid and unbounded project ids", () => {
  for (const projectId of ["", "Uppercase", "-leading", "has/slash", "has space", "a".repeat(65), 17, null]) {
    const root = fixture(valid(projectId));
    try { rejects(root, /projectId must be 1-64 lowercase characters/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejects a config symlink even when its target is valid", () => {
  const outer = mkdtempSync(join(tmpdir(), "limina-project-symlink-"));
  const root = join(outer, "project");
  mkdirSync(root);
  const outside = join(outer, "outside.json");
  writeFileSync(outside, JSON.stringify(valid()));
  symlinkSync(outside, join(root, "limina.project.json"));
  try { rejects(root, /must be a regular file, not a symbolic link/); }
  finally { rmSync(outer, { recursive: true, force: true }); }
});

test("rejects a symlink passed as the project root", () => {
  const outer = mkdtempSync(join(tmpdir(), "limina-project-root-link-"));
  const root = join(outer, "project");
  const linked = join(outer, "linked-project");
  mkdirSync(root);
  writeFileSync(join(root, "limina.project.json"), JSON.stringify(valid()));
  symlinkSync(root, linked, "dir");
  try { rejects(linked, /project root must be an explicit directory, not a symbolic link/); }
  finally { rmSync(outer, { recursive: true, force: true }); }
});

test("rejects non-file configs and symlink escapes in configured directories", () => {
  const outer = mkdtempSync(join(tmpdir(), "limina-project-paths-"));
  const root = join(outer, "project");
  mkdirSync(root);
  mkdirSync(join(root, "limina.project.json"));
  rejects(root, /must be a regular file/);
  rmSync(join(root, "limina.project.json"), { recursive: true });
  symlinkSync(outer, join(root, "assets"), "dir");
  writeFileSync(join(root, "limina.project.json"), JSON.stringify(valid()));
  try { rejects(root, /assetRoot.*resolves outside the project root/); }
  finally { rmSync(outer, { recursive: true, force: true }); }
});

test("validates configured paths against the project root, independent of cwd", () => {
  const root = fixture(valid());
  const other = mkdtempSync(join(tmpdir(), "limina-project-cwd-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(other);
    assert.equal(loadProjectConfig(root).projectId, "grey-field");
    writeFileSync(join(root, "limina.project.json"), JSON.stringify({ ...valid(), stateDir: "../outside" }));
    rejects(root, /must not contain empty, '\.' or '\.\.' path segments/);
  } finally {
    process.chdir(originalCwd);
    rmSync(other, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous or platform-dependent configured paths", () => {
  for (const path of [".", "../outside", "assets//textures", "assets/./textures", "assets/../outside", "assets\\textures", "C:/outside", "/tmp/outside"]) {
    const root = fixture({ ...valid(), assetRoot: path });
    try { rejects(root, /assetRoot/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("editor, export, and Atlas build wrappers return the same canonical identity", async () => {
  const root = fixture(valid("shared.identity-1"));
  const design = join(root, "design");
  mkdirSync(design);
  try {
    const [editor, exported, built] = await Promise.all([
      loadEditorProjectConfig(LIMINA_HOME, root),
      loadExportProjectConfig(LIMINA_HOME, root),
      Promise.resolve(loadBuildProjectConfig(design)),
    ]);
    assert.deepEqual([editor.projectId, exported.projectId, built.projectId], ["shared.identity-1", "shared.identity-1", "shared.identity-1"]);
    assert.deepEqual([editor.projectRoot, exported.projectRoot, built.projectRoot], [root, root, root]);
    const hostEnvironment = editorHostEnvironment({
      projectId: editor.projectId, editorPort: 8787, uiPort: 5173, token: "x".repeat(32), projectRoot: root, environment: {},
      derivedRuntime: {
        baseUrl: "http://127.0.0.1:5174",
        token: "A".repeat(43),
        branchId: "main",
      },
    });
    assert.equal(hostEnvironment.LIMINA_PROJECT_ID, "shared.identity-1");
    assert.equal(hostEnvironment.LIMINA_ASSET_ROOT, join(root, "assets"));
    assert.equal(hostEnvironment.LIMINA_EDITOR_WORLDLOG, "shared.identity-1.editor.worldlog.jsonl");
    assert.equal(hostEnvironment.LIMINA_DERIVED_RUNTIME_BASE_URL, "http://127.0.0.1:5174");
    assert.equal(hostEnvironment.LIMINA_DERIVED_RUNTIME_TOKEN, "A".repeat(43));
    assert.equal(hostEnvironment.LIMINA_DERIVED_RUNTIME_BRANCH_ID, "main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Atlas build rejects a design-vault symlink that escapes its project", () => {
  const outer = mkdtempSync(join(tmpdir(), "limina-vault-link-"));
  const root = join(outer, "project");
  const outside = join(outer, "outside-design");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "limina.project.json"), JSON.stringify(valid()));
  symlinkSync(outside, join(root, "design"), "dir");
  try {
    assert.throws(() => loadBuildProjectConfig(join(root, "design")), /design vault resolves outside the explicit project root/);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test("build and Design Space CLIs fail closed instead of accepting package fallbacks", () => {
  const root = fixture(undefined);
  const design = join(root, "design");
  mkdirSync(design);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fallback-name" }));
  writeFileSync(join(design, "maps.json"), "{}");
  try {
    const build = spawnSync(process.execPath, [join(LIMINA_HOME, "tools/design/build-world.mjs"), design, "x"], { encoding: "utf8" });
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /limina\.project\.json does not exist/);

    const serve = spawnSync(process.execPath, [join(LIMINA_HOME, "tools/design/serve-design.mjs"), design, "49187"], { encoding: "utf8" });
    assert.notEqual(serve.status, 0);
    assert.match(serve.stderr, /limina\.project\.json does not exist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
