import assert from "node:assert/strict";

import { editorLaunchConfigFromEnvironment } from "./editor-launch.mjs";

assert.equal(editorLaunchConfigFromEnvironment({}), undefined);
assert.deepEqual(editorLaunchConfigFromEnvironment({
  LIMINA_EDITOR_HANDOFF_URL: "http://localhost:5180/atlas-handoff.html",
  LIMINA_ATLAS_PUBLIC_ORIGIN: "http://127.0.0.1:4321",
}), {
  handoffUrl: "http://localhost:5180/atlas-handoff.html",
  editorOrigin: "http://localhost:5180",
  atlasOrigin: "http://127.0.0.1:4321",
});
for (const value of [
  "https://localhost:5180/atlas-handoff.html",
  "http://evil.test:5180/atlas-handoff.html",
  "http://localhost/atlas-handoff.html",
  "http://localhost:5180/atlas-handoff.html?token=x",
  "http://user@localhost:5180/atlas-handoff.html",
]) assert.throws(() => editorLaunchConfigFromEnvironment({
  LIMINA_EDITOR_HANDOFF_URL: value,
  LIMINA_ATLAS_PUBLIC_ORIGIN: "http://127.0.0.1:4321",
}), /exact loopback/);
assert.throws(() => editorLaunchConfigFromEnvironment({
  LIMINA_EDITOR_HANDOFF_URL: "http://localhost:5180/atlas-handoff.html",
}), /configured together/);
assert.throws(() => editorLaunchConfigFromEnvironment({
  LIMINA_EDITOR_HANDOFF_URL: "http://localhost:5180/atlas-handoff.html",
  LIMINA_ATLAS_PUBLIC_ORIGIN: "http://evil.test:4321",
}), /exact loopback/);

console.log("editor-launch.test OK: exact non-secret standalone Atlas handoff configuration");
