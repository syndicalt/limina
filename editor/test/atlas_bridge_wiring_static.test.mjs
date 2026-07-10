import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, viewport, map, app, net, util] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/viewport.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/map.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/net.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/util.js", import.meta.url), "utf8"),
]);

test("the editor exposes one docked Atlas workspace with bounded responsive dimensions", () => {
  for (const id of ["viewport-atlas-toggle", "viewport-atlas", "viewport-atlas-frame", "viewport-atlas-status", "viewport-atlas-reveal", "viewport-atlas-close"]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) ?? []).length, 1, id);
  }
  assert.match(html, /id="viewport-atlas"[^>]*aria-labelledby="viewport-atlas-title"[^>]*hidden/);
  assert.match(css, /\.atlas-overview\s*\{[^}]*width:\s*clamp\(440px, 48%, 720px\)/s);
  assert.match(css, /body\.atlas-overview-open #inspector\s*\{\s*display:\s*none !important/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.atlas-overview\s*\{[^}]*position:\s*absolute/s);
});

test("Atlas focus is source-fenced, residency-coordinated, and terrain-grounded", () => {
  assert.match(viewport, /parseTrustedAtlasEditorMessageEvent\(event, source, window\.location\.origin\)/);
  assert.match(viewport, /active\?\.revision === source\.revision && active\?\.headHash === source\.headHash/);
  assert.match(viewport, /await waitForAtlasDerivedSource\(message\.source, generation\)/);
  assert.match(viewport, /navigation\.destinationPose\(target, message\.radiusM\)/);
  assert.match(viewport, /derivedTerrainHeightAt\(message\.world\[0\], message\.world\[1\]\)/);
  assert.match(viewport, /resolvePose:\s*\(\{ context \}\)/);
});

test("reverse reveal uses exact selected world coordinates without POI inference", () => {
  assert.match(viewport, /selected\.mesh\.getWorldPosition\(atlasWorldPosition\)/);
  assert.match(viewport, /\[atlasWorldPosition\.x, atlasWorldPosition\.z\]/);
  assert.match(viewport, /target\.postMessage\(message, window\.location\.origin\)/);
  assert.doesNotMatch(viewport, /nearest.*(?:place|marker)|distanceTo.*(?:place|marker)/i);
});

test("Atlas flushes its authoritative CAS save before emitting a canonical focus", () => {
  const flush = map.indexOf("const saved=await flushMapSave()");
  const post = map.indexOf("window.parent.postMessage(message,window.location.origin)");
  assert.ok(flush >= 0 && post > flush);
  assert.match(map, /const map=activeMap\(\);[\s\S]*atlasLocalToCanonicalWorld\(map\.units/);
  assert.match(map, /source:\{revision:head&&head\.revision,headHash:head&&head\.headHash\}/);
  assert.match(net, /export async function flushMapSave\(\)[\s\S]*return doSave\(\);/);
});

test("embedded Atlas opens directly to the map and attribute escaping covers quotes", () => {
  assert.match(app, /get\("embed"\) === "editor"/);
  assert.match(app, /S\.activeView = "map"/);
  assert.match(util, /&quot;/);
  assert.match(util, /&#39;/);
});
