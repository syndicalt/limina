import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { auditSourceLines, MAX_LINE_BYTES, SOURCE_EXTENSIONS } from "./check-source-lines.mjs";

const emptyManifest = () => ({
  schemaVersion: 1,
  lineLimitBytes: MAX_LINE_BYTES,
  sourceExtensions: [...SOURCE_EXTENSIONS],
  artifacts: [],
});

async function fixture(files, { ignored = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "limina-source-lines-test-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (ignored.length > 0) await writeFile(join(root, ".gitignore"), `${ignored.join("\n")}\n`);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    if (value?.symlink) await symlink(value.symlink, join(root, path));
    else await writeFile(join(root, path), value);
  }
  return root;
}

async function add(root, ...paths) {
  execFileSync("git", ["add", "--", ...paths], { cwd: root });
}

async function audit(root, options = {}) {
  return auditSourceLines({ root, manifest: emptyManifest(), recipes: new Map(), ...options });
}

test("tracked and nonignored untracked source files are scanned, while ignored and content files are not", async () => {
  const root = await fixture(
    {
      "tracked.ts": "export const ok = true;\n",
      "untracked.mts": `${"u".repeat(501)}\n`,
      "ignored.js": `${"i".repeat(501)}\n`,
      "content.json": JSON.stringify({ ignored: "j".repeat(501) }),
      "content.md": `${"m".repeat(501)}\n`,
      "icon.svg": `<svg>${"v".repeat(501)}</svg>\n`,
    },
    { ignored: ["ignored.js"] },
  );
  try {
    await add(root, "tracked.ts", ".gitignore");
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.filter((entry) => entry.code === "line_too_long").map((entry) => entry.path),
      ["untracked.mts"],
    );
    assert.deepEqual(result.summary, {
      scanned: 2,
      tracked: 1,
      untracked: 1,
      generatedArtifacts: 0,
      generatedRecipes: 0,
      handwrittenFiles: 2,
      lineLimitBytes: 500,
      sourceExtensions: [...SOURCE_EXTENSIONS],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Python, Rust, shell, PowerShell, Astro, HTML, and CSS are load-bearing source extensions", async () => {
  const files = {
    "component.astro": `${"a".repeat(501)}\n`,
    "style.css": `${"c".repeat(501)}\n`,
    "page.html": `${"h".repeat(501)}\n`,
    "script.ps1": `${"w".repeat(501)}\n`,
    "script.py": `${"p".repeat(501)}\n`,
    "native.rs": `${"r".repeat(501)}\n`,
    "script.sh": `${"s".repeat(501)}\n`,
  };
  const root = await fixture(files);
  try {
    await add(root, ...Object.keys(files));
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.filter((entry) => entry.code === "line_too_long").map((entry) => entry.path),
      Object.keys(files).sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("line limit is measured in UTF-8 bytes and is inclusive at exactly 500", async () => {
  const root = await fixture({
    "exact.js": `${"a".repeat(500)}\n`,
    "ascii-over.js": `${"b".repeat(501)}\n`,
    "unicode-over.ts": `${"é".repeat(251)}\n`,
  });
  try {
    await add(root, "exact.js", "ascii-over.js", "unicode-over.ts");
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.filter((entry) => entry.code === "line_too_long").map(({ path, bytes }) => [path, bytes]),
      [
        ["ascii-over.js", 501],
        ["unicode-over.ts", 502],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinks, NUL bytes, and invalid UTF-8 fail closed", async () => {
  const root = await fixture({
    "target.txt": "not source\n",
    "linked.js": { symlink: "target.txt" },
    "nul.mjs": Buffer.from([0x61, 0x00, 0x62]),
    "invalid.cjs": Buffer.from([0xc3, 0x28]),
  });
  try {
    await add(root, "target.txt", "linked.js", "nul.mjs", "invalid.cjs");
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      new Set(result.errors.map((entry) => entry.code)),
      new Set(["source_symlink", "source_nul", "source_utf8"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tracked source missing from the worktree fails closed", async () => {
  const root = await fixture({ "missing.ts": "export {};\n" });
  try {
    await add(root, "missing.ts");
    await unlink(join(root, "missing.ts"));
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert(result.errors.some((entry) => entry.code === "source_missing" && entry.path === "missing.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a generated banner never authorizes an overlong handwritten file", async () => {
  const root = await fixture({ "banner.js": `// GENERATED FILE — DO NOT EDIT ${"x".repeat(501)}\n` });
  try {
    await add(root, "banner.js");
    const result = await audit(root);
    assert.equal(result.ok, false);
    assert(result.errors.some((entry) => entry.code === "line_too_long" && entry.path === "banner.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact generated bytes are exempt only through a named recipe bound to that exact path", async () => {
  const content = Buffer.from(`${"g".repeat(501)}\n`);
  const root = await fixture({ "dist/generated.js": content });
  try {
    await add(root, "dist/generated.js");
    const manifest = { ...emptyManifest(), artifacts: [{ path: "dist/generated.js", recipeId: "fixture:copy@1" }] };
    const exactRecipes = new Map([
      [
        "fixture:copy@1",
        { allowedArtifacts: new Set(["dist/generated.js"]), produce: async () => Buffer.from(content) },
      ],
    ]);
    const exact = await audit(root, { manifest, recipes: exactRecipes });
    assert.equal(exact.ok, true, exact.errors.map((entry) => entry.message).join("\n"));
    assert.equal(exact.summary.generatedArtifacts, 1);

    const staleRecipes = new Map([
      [
        "fixture:copy@1",
        { allowedArtifacts: new Set(["dist/generated.js"]), produce: async () => Buffer.from("different\n") },
      ],
    ]);
    const stale = await audit(root, { manifest, recipes: staleRecipes });
    assert.equal(stale.ok, false);
    assert(stale.errors.some((entry) => entry.code === "generated_mismatch"));
    assert(stale.errors.some((entry) => entry.code === "line_too_long"));

    const wrongPathRecipes = new Map([
      [
        "fixture:copy@1",
        { allowedArtifacts: new Set(["dist/somewhere-else.js"]), produce: async () => Buffer.from(content) },
      ],
    ]);
    const wrongPath = await audit(root, { manifest, recipes: wrongPathRecipes });
    assert(wrongPath.errors.some((entry) => entry.code === "generated_recipe_path"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown generated recipes are explicitly unresolved and never become exceptions", async () => {
  const root = await fixture({ "dist/mystery.js": `${"m".repeat(501)}\n` });
  try {
    await add(root, "dist/mystery.js");
    const manifest = { ...emptyManifest(), artifacts: [{ path: "dist/mystery.js", recipeId: "missing:producer@1" }] };
    const result = await audit(root, { manifest });
    assert.equal(result.ok, false);
    assert(result.errors.some((entry) => entry.code === "generated_unresolved" && /UNRESOLVED/u.test(entry.message)));
    assert(result.errors.some((entry) => entry.code === "line_too_long"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest rejects globs, traversal, duplicate paths, unknown fields, and attempts to raise the limit", async () => {
  const root = await fixture({ "safe.js": "ok\n" });
  try {
    await add(root, "safe.js");
    const malformed = {
      ...emptyManifest(),
      lineLimitBytes: 50_000,
      artifacts: [
        { path: "dist/*.js", recipeId: "fixture:copy@1" },
        { path: "../escape.js", recipeId: "fixture:copy@1" },
        { path: "safe.js", recipeId: "fixture:copy@1" },
        { path: "safe.js", recipeId: "fixture:copy@1" },
        { path: "extra.js", recipeId: "fixture:copy@1", hash: "grandfathered" },
      ],
    };
    const result = await audit(root, { manifest: malformed });
    const codes = new Set(result.errors.map((entry) => entry.code));
    assert(codes.has("manifest_limit"));
    assert(codes.has("manifest_artifact_path"));
    assert(codes.has("manifest_duplicate"));
    assert(codes.has("manifest_artifact_shape"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
