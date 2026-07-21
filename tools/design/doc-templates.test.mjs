// doc-templates: every "New document" kind must produce frontmatter its hard
// consumers accept. The falsifiability leg proves the harness catches the exact
// template bug that shipped (scalar `zone: temperate` -> peek failed on
// "missing 'zone.size_m'").
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_KINDS, docTemplate, zoneSizeMFromMap } from "./doc-templates.mjs";
import { compileDesignMap } from "../../js/src/world/design-map-compile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapsJsonText = readFileSync(join(__dirname, "../scaffold/design/maps.json"), "utf8");

test("every dialog kind yields a frontmatter document", () => {
  for (const kind of DOC_KINDS) {
    const doc = docTemplate(kind, "Fixture Title");
    assert.match(doc, /^---\n/, `${kind}: template must open a frontmatter block`);
    assert.match(doc, new RegExp(`\\nkind: ${kind}\\n`), `${kind}: template must carry its kind`);
    assert.match(doc, /\ntitle: Fixture Title\n/, `${kind}: template must carry the title`);
  }
});

test("world-bible template satisfies the map compiler's zone contract", () => {
  const worldBibleText = docTemplate("world-bible", "World Bible", { zoneSizeM: 1500 });
  const { worldMap } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: "primary" });
  assert.ok(worldMap, "template world-bible must compile");
});

test("FALSIFIABILITY: the shipped scalar-zone template fails the compiler", () => {
  const broken = "---\nkind: world-bible\ntitle: World Bible\nzone: temperate\n---\n\n# World Bible\n";
  assert.throws(
    () => compileDesignMap({ mapsJsonText, worldBibleText: broken, mapId: "primary" }),
    /zone\.size_m/,
    "a scalar zone must still be rejected by the compiler — else this suite proves nothing",
  );
});

test("zone size derives from the paintable rect so the 2x scale contract always holds", () => {
  assert.equal(zoneSizeMFromMap({ rasters: { landmass: { rect: { w: 3000, h: 3000 } } } }), 1500);
  assert.equal(zoneSizeMFromMap({ rasters: { landmass: { rect: { w: 1000, h: 2400 } } } }), 1200);
  assert.equal(zoneSizeMFromMap({}), 200, "no paint rect -> fixture default (scale check cannot trip)");
  const map = { rasters: { landmass: { rect: { w: 2731, h: 977 } } } };
  assert.ok(zoneSizeMFromMap(map) * 2 >= 2731, "derived size must always admit the full rect");
});
