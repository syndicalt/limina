import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const inspector = source("take-control.js");
const viewport = source("viewport.js");

assert.match(inspector, /input\.addEventListener\("input", \(\) => \{[\s\S]*state\.transformEdited =/,
  "transform input must mark its draft dirty synchronously");
assert.match(inspector, /slider\.addEventListener\("input", \(\) => \{[\s\S]*state\.materialEdited =/,
  "material slider must mark its draft dirty synchronously");
assert.match(inspector, /color\.addEventListener\("input", \(\) => \{[\s\S]*state\.materialEdited =/,
  "material color must mark its draft dirty synchronously");
assert.match(inspector, /await commitSceneOperations\(operations\)/,
  "Inspector must submit its grouped operations through one gateway call");
assert.doesNotMatch(inspector, /\b(?:writeUpdate|writeMaterial|addTag|removeTag)\b/,
  "Inspector must not retain direct legacy field writes");

assert.match(viewport, /commitSceneOperations\(\[sceneTransformOperation\(selected\.id, \{[\s\S]*position:[\s\S]*rotation:[\s\S]*scale:/,
  "one gizmo release must group all transform fields in one scene operation");
assert.match(viewport, /finally \{\s*if \(typeof running\?\.setSyncSuppressed === "function"\) running\.setSyncSuppressed\(selected\.eid, false\);\s*\}/,
  "gizmo sync suppression must always be released");
assert.doesNotMatch(viewport, /\b(?:undoStroke|redoStroke|recordStrokeBoundary)\b/,
  "terrain scrub must not masquerade as authoritative undo");

console.log("authoring_editor_wiring.test OK: synchronous drafts, grouped writes, sync release, and no pseudo-undo");
