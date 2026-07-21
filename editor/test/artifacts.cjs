const { mkdtempSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

let dir;

function artifactPath(name) {
  if (!dir) {
    dir = process.env.ARTIFACT_DIR || mkdtempSync(join(tmpdir(), "limina-editor-artifacts-"));
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, name);
}

function artifactDir() {
  artifactPath(".keep");
  return dir;
}

module.exports = { artifactPath, artifactDir };
