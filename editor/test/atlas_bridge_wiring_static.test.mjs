import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, viewport, map, app, net, util, atlasHtml, relay, editorApp, serve, launcher] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/viewport.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/map.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/net.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/util.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/atlas-handoff-relay.js", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/scaffold/scripts/serve.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../tools/scaffold/scripts/editor.mjs", import.meta.url), "utf8"),
]);

test("the editor exposes one persisted resizable and maximizable Atlas workspace", () => {
  for (const id of ["viewport-atlas-toggle", "viewport-atlas", "viewport-atlas-frame", "viewport-atlas-status", "viewport-atlas-reveal", "viewport-atlas-maximize", "viewport-atlas-splitter", "viewport-atlas-close"]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) ?? []).length, 1, id);
  }
  assert.match(html, /id="viewport-atlas"[^>]*aria-labelledby="viewport-atlas-title"[^>]*hidden/);
  assert.match(html, /id="viewport-atlas-splitter"[^>]*role="separator"[^>]*tabindex="0"[^>]*aria-orientation="vertical"/s);
  assert.match(css, /\.viewport\s*\{[^}]*--atlas-dock-width:\s*560px/s);
  assert.match(css, /\.atlas-overview\s*\{[^}]*width:\s*var\(--atlas-dock-width\)/s);
  assert.match(css, /body\.atlas-workspace-maximized \.atlas-overview[\s\S]*position:\s*absolute/);
  assert.match(css, /body\.atlas-workspace-compact \.atlas-overview/);
  assert.match(viewport, /setPointerCapture/);
  assert.match(viewport, /ResizeObserver/);
  assert.match(viewport, /insertBefore\(playCanvas, viewportUi\.atlasPanel \?\? null\)/);
  assert.match(viewport, /writeAtlasWorkspaceState/);
  assert.match(css, /body\.atlas-overview-open #inspector\s*\{\s*display:\s*none !important/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.atlas-overview\s*\{[^}]*position:\s*absolute/s);
});

test("Atlas focus is source-fenced, residency-coordinated, and terrain-grounded", () => {
  assert.match(viewport, /parseTrustedAtlasEditorMessageEvent\(event, source, window\.location\.origin\)/);
  assert.match(viewport, /active\?\.revision === source\.revision && active\?\.headHash === source\.headHash/);
  assert.match(viewport, /await waitForAtlasDerivedSource\(message\.source, generation, requireAtlasOpen\)/);
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
  const flush = map.indexOf("const [saved,launch]=await Promise.all([flushMapSave()");
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

test("standalone Atlas launches through a non-secret one-shot relay", () => {
  assert.equal((atlasHtml.match(/id="open-editor"/g) ?? []).length, 1);
  assert.match(map, /window\.open\("about:blank","_blank"\)/);
  assert.match(map, /if\(!activeMapId\) activeMapId=S\.state\.activeMapId\|\|primaryMapId\(\)/);
  assert.match(map, /const \[saved,launch\]=await Promise\.all\(\[flushMapSave\(\),standalone\?getEditorLaunchConfig\(\)/);
  assert.match(map, /event\.source!==popup\|\|event\.origin!==config\.editorOrigin/);
  assert.match(map, /popup\.postMessage\(message,config\.editorOrigin\)/);
  assert.match(relay, /event\.source !== opener \|\| event\.origin !== atlasOrigin/);
  assert.match(relay, /storeAtlasEditorHandoff\(sessionStorage, handoff\)/);
  assert.match(relay, /window\.opener = null/);
  assert.match(editorApp, /atlasEditorHandoff/);
  assert.match(viewport, /focusAtlasRequest\(focus, \{ requireAtlasOpen: false \}\)/);
  assert.match(map, /launch\.atlasOrigin!==window\.location\.origin/);
  assert.match(serve, /"referrer-policy": "no-referrer"/);
  assert.match(serve, /"cache-control": "no-store"/);
  assert.match(launcher, /LIMINA_EDITOR_HANDOFF_URL/);
  assert.match(launcher, /LIMINA_ATLAS_PUBLIC_ORIGIN/);
  assert.match(launcher, /LIMINA_EDITOR_PUBLIC_URL/);
  assert.doesNotMatch(launcher, /atlas-handoff\.html\?[^"`]*token/i);
});
