const { existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function fail(m) { console.error("FAIL: " + m); process.exit(1); }

const fresh = () => {
  delete require.cache[require.resolve("./artifacts.cjs")];
  return require("./artifacts.cjs");
};

delete process.env.ARTIFACT_DIR;
let artifacts = fresh();
const tempPath = artifacts.artifactPath("probe.png");
if (!tempPath.includes("limina-editor-artifacts-")) fail("default artifact path should use a temp directory, got " + tempPath);
if (!existsSync(artifacts.artifactDir())) fail("default artifact directory should exist");

const explicit = mkdtempSync(join(tmpdir(), "limina-explicit-artifacts-"));
process.env.ARTIFACT_DIR = explicit;
artifacts = fresh();
const explicitPath = artifacts.artifactPath("probe.png");
if (explicitPath !== join(explicit, "probe.png")) fail("ARTIFACT_DIR override not honored: " + explicitPath);
if (!existsSync(artifacts.artifactDir())) fail("explicit artifact directory should exist");

console.log("artifacts.test OK: browser-test artifacts default to temp dirs and honor ARTIFACT_DIR");
