#!/usr/bin/env node
// make-alpha.mjs — ALPHA PACKAGING first cut: assemble dist-alpha/, a directory an
// outsider can unpack and run without the repo, a Rust toolchain, or npm install.
//
//   node tools/package/make-alpha.mjs
//
// Pure Node stdlib — no dependencies. What goes in and WHY:
//
//   bin/limina            the host binary (PLATFORM-SPECIFIC — linux x86_64 here;
//                         see QUICKSTART). Reads assets from <cwd>/assets and writes
//                         <cwd>/traces, so every launcher runs with cwd = dist-alpha/.
//   editor/               index.html + styles.css + src/ + vendor/ bundles + server/
//                         (editor_host.ts imports ../../js/src/**, hence js/ below).
//   assets/               GLBs, cards, catalog.json, maps/, qc/ (the editor catalog
//                         thumbnails come from /assets/qc/...).
//   js/src/ + js/build/   the engine TS layer the host binary transpiles + loads at
//                         runtime (editor_host + the serve-design harnesses). The
//                         binary's module loader is file://-only, so no node_modules.
//   runtime/basis/        the exact Basis transcoder paired with the pinned Three
//                         package, so KTX2 assets work without a machine-global tool.
//   tools/serve.mjs       the scaffold static server, COPIED IN because of its quirk:
//                         it resolves /assets/** as a SIBLING of the served dir
//                         (resolve(ROOT, "..", "assets")) — which is exactly why
//                         dist-alpha lays out editor/ and assets/ as siblings.
//   tools/design/ + map/  the design/map tool (serve-design.mjs + frontend) and the
//                         vault -> WorldMap compiler build-world.mjs shells out to.
//                         Their LIMINA_HOME = resolve(__dirname, "..", "..") lands on
//                         dist-alpha/ — the same relative shape as the repo.
//   vault-template/       a starter design vault mirroring eastern-watch/design.
//   start.sh              editor_host (LIMINA_EDITOR_PORT, default 8787; token
//                         LIMINA_EDITOR_TOKEN, default random hex printed loudly)
//                         + the static editor server (LIMINA_STATIC_PORT, 5173).
//   start-design.sh       the map tool on a vault (default vault-template/, port 4321).
//   build-world.sh        compiles the drawn map + builds the world into the live editor.
//   QUICKSTART.md         <= 12 lines to a first world.
//
// NOT copied: node_modules, traces, .parked-combat, art-direction, tools/preview/out,
// dist-alpha itself, js/test, editor/test, repo marketing images.

import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO, "dist-alpha");

function log(msg) { console.log("  " + msg); }
function copy(rel, destRel = rel, filter) {
  const src = join(REPO, rel);
  if (!existsSync(src)) { console.warn("  !! missing, skipped: " + rel); return; }
  cpSync(src, join(OUT, destRel), { recursive: true, filter });
  log(`copied ${rel} -> ${destRel}`);
}

// ── fresh output dir ────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
console.log("\nmake-alpha: assembling " + OUT + "\n");

// ── 1. the host binary (platform-specific) ──────────────────────────────────
mkdirSync(join(OUT, "bin"));
copy("target/release/limina", "bin/limina");
chmodSync(join(OUT, "bin/limina"), 0o755);

// ── 2. the editor (page + src + vendor bundles + server) ────────────────────
mkdirSync(join(OUT, "editor"));
copy("editor/index.html");
copy("editor/styles.css");
copy("editor/src");
copy("editor/vendor");
copy("editor/server");

// ── 3. assets (GLBs, cards, catalog.json, maps/, qc thumbnails) ─────────────
const ASSET_SKIP = new Set(["limina-hero.png", "limina-x-header.png", "make-x-header.py"]);
copy("assets", "assets", (src) => !ASSET_SKIP.has(src.split("/").pop()));

// ── 4. the engine TS layer the binary loads (file:// modules only) ──────────
copy("js/src", "js/src");
copy("js/build", "js/build");
copy("runtime/basis", "runtime/basis");
copy("runtime/basis", "editor/runtime/basis");

// ── 5. tools: static server (the /assets-sibling quirk), design + map tools ─
mkdirSync(join(OUT, "tools/design"), { recursive: true });
mkdirSync(join(OUT, "tools/map"), { recursive: true });
copy("tools/scaffold/scripts/serve.mjs", "tools/serve.mjs");
copy("tools/design/serve-design.mjs");
copy("tools/design/frontend", "tools/design/frontend");
copy("tools/design/build-world.mjs");
copy("tools/design/compile-vault.mjs");
copy("tools/map/compile-designmap.mjs");

// traces/ is where the host binary writes its world log + kernel lock (cwd-relative).
mkdirSync(join(OUT, "traces"), { recursive: true });

// ── 6. the starter vault template (mirrors eastern-watch/design's shape) ────
mkdirSync(join(OUT, "vault-template"));

writeFileSync(join(OUT, "vault-template/world-bible.md"), `---
kind: world-bible
setting:
  name: My First World
  era: Name the moment in time your world sits in.
  premise: One sentence on what this place is and why anyone is here.
zone:
  size_m: 200
  origin: settlement center [0,0]; north = -z (screen-up in the map tool); +x = east
regions:
  - id: the-clearing
    name: The Clearing
    biome: meadow
    note: The settled open ground at the center.
  - id: the-woods
    name: The Woods
    biome: forest
    note: The treeline that rings the clearing.
locations:
  - id: hall
    name: The Hall
    kind: civic
    region: the-clearing
    position: [0, 0]
    build: unbuilt
    note: The settlement's anchor building, at the center.
  - id: homes
    name: Homes
    kind: dwelling
    region: the-clearing
    position: [-18, -8]
    build: unbuilt
    note: A small cluster of cottages west of the hall.
spawn:
  position: [-50, 0]
  facing: east
  note: The player arrives from the west, settlement ahead.
compiles_to: world-bible
---

# World Bible

Author your world here. The frontmatter above is the buildable core: \`regions\`
give the land its biomes, \`locations\` are the pins the builder places real
buildings at (kinds: civic, dwelling, religious, military — markers are skipped),
and \`spawn\` is where the player starts.

Positions are meters from the map origin. North is -z (up on the map tool's
screen), +x is east — the same axes the map in maps.json is drawn in.

Edit this file with any editor, or manage the locations visually from the map
tool (see README.md).
`);

// The vault compiler (vaultToStore) REQUIRES a concept doc (kind: concept) — without
// it the design tool's build panel reports an issue instead of a compiled GDS.
writeFileSync(join(OUT, "vault-template/concept.md"), `---
kind: concept
id: my-first-world
title: My First World
logline: One sentence on who the player is and what this place asks of them.
loop: Arrive, walk the settlement, look around, and reach the far edge of the zone.
genre: atmospheric exploration
perspective: third-person, walking
pillars:
  - id: grounded-looking
    name: Grounded Looking
    note: Walk, look, notice. The world tells its story environmentally.
scope:
  in: [one explorable zone (~200m), a small settlement, the player walking]
  out: [combat, inventory, dialogue trees, quests]
compiles_to: gds
---

# Concept

What the game IS: the pitch, the loop, the pillars, the scope. Keep it short and
readable — the frontmatter above is what compiles; this prose is for you.
`);

writeFileSync(join(OUT, "vault-template/maps.json"), JSON.stringify({
  axes: "north-negz",
  activeMapId: "primary",
  maps: [
    {
      id: "primary",
      name: "my-first-world — Site",
      scope: "site",
      parent: null,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [],
    },
  ],
}, null, 2) + "\n");

writeFileSync(join(OUT, "vault-template/README.md"), `---
kind: home
project: my-first-world
title: My First World — Design
---

# My First World

This folder is your **design vault** — plain markdown you own. limina builds the
world from it.

- **world-bible.md** — the buildable core: regions, locations, spawn.
- **maps.json** — the drawn map (axes: north = -z, i.e. screen-up; units in meters).

## Draw the map

Run \`./start-design.sh\` (serves this vault at http://localhost:4321/) and draw:
an island **outline**, biome areas, and keep the location pins where you want the
buildings. The map is saved back into this folder's maps.json.

## Build it

With the editor running (\`./start.sh\`), run \`./build-world.sh\` — it compiles
the drawn map + world-bible into terrain, water, buildings, and forest in the
live editor viewport.
`);

// ── 7. launch scripts ────────────────────────────────────────────────────────
writeFileSync(join(OUT, "start.sh"), `#!/usr/bin/env bash
# start.sh — boot the limina editor: the authoritative host (editor_host) + the
# static editor page. Ports are configurable:
#   LIMINA_EDITOR_PORT   ws host port      (default 8787)
#   LIMINA_STATIC_PORT   editor page port  (default 5173)
#   LIMINA_EDITOR_TOKEN  auth token        (default: random hex, printed below)
# NOTE: the host only accepts BROWSER connections from the http://localhost:5173
# origin; on a non-default static port the page loads but the live viewport's
# websocket is refused (native/tool clients with the token are unaffected).
set -euo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export LIMINA_EDITOR_PORT="\${LIMINA_EDITOR_PORT:-8787}"
STATIC_PORT="\${LIMINA_STATIC_PORT:-5173}"
if [ -z "\${LIMINA_EDITOR_TOKEN:-}" ]; then
  export LIMINA_EDITOR_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  limina editor"
echo "    editor page   http://localhost:\${STATIC_PORT}/"
echo "    host (ws)     ws://localhost:\${LIMINA_EDITOR_PORT}/"
echo ""
echo "    TOKEN: \${LIMINA_EDITOR_TOKEN}"
echo "    (paste this into the editor page when it asks)"
echo "════════════════════════════════════════════════════════════"
echo ""

cd "$ROOT"   # the host resolves assets/ and traces/ from its cwd
"$ROOT/bin/limina" editor/server/editor_host.ts &
HOST_PID=$!
node "$ROOT/tools/serve.mjs" editor "\${STATIC_PORT}" &
STATIC_PID=$!
trap 'kill "$HOST_PID" "$STATIC_PID" 2>/dev/null; wait 2>/dev/null' INT TERM EXIT
wait
`);

writeFileSync(join(OUT, "start-design.sh"), `#!/usr/bin/env bash
# start-design.sh — serve the design/map tool on a vault.
#   ./start-design.sh [vault-dir] [port]     (defaults: ./vault-template 4321)
set -euo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
VAULT="\${1:-$ROOT/vault-template}"
PORT="\${2:-4321}"
export LIMINA_BIN="$ROOT/bin/limina"
cd "$ROOT"
exec node "$ROOT/tools/design/serve-design.mjs" "$VAULT" "$PORT"
`);

writeFileSync(join(OUT, "build-world.sh"), `#!/usr/bin/env bash
# build-world.sh — compile the vault's drawn map and build the world into the
# LIVE editor (start.sh must be running; use ITS token).
#   LIMINA_EDITOR_TOKEN=<token> ./build-world.sh [vault-dir]
#   ./build-world.sh <token> [vault-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export LIMINA_EDITOR_URL="\${LIMINA_EDITOR_URL:-ws://localhost:\${LIMINA_EDITOR_PORT:-8787}/}"
ARGS=()
for a in "$@"; do ARGS+=("$a"); done
# default vault when no dir-looking arg was given
HAS_DIR=no
for a in "\${ARGS[@]:-}"; do case "$a" in */*|.) HAS_DIR=yes;; esac; done
if [ "$HAS_DIR" = no ]; then ARGS+=("$ROOT/vault-template"); fi
cd "$ROOT"
exec node "$ROOT/tools/design/build-world.mjs" "\${ARGS[@]}"
`);

// ── 8. QUICKSTART ─────────────────────────────────────────────────────────────
writeFileSync(join(OUT, "QUICKSTART.md"), `# limina alpha — quickstart

Needs: Node 22+, a WebGPU/WebGL browser. \`bin/limina\` is a **linux x86_64** build — other platforms must build the host from source.

1. \`./start.sh\` — boots the world host + the editor page. **Copy the TOKEN it prints.**
2. Open **http://localhost:5173/** and paste the token — the editor connects (empty world).
3. \`./start-design.sh\` (second terminal) — opens your design vault's map tool at **http://localhost:4321/**.
4. Draw your world on the map: an island **outline**, biome areas, and drag the location pins (vault-template starts you with a hall + homes).
5. \`LIMINA_EDITOR_TOKEN=<token> ./build-world.sh\` — compiles the drawn map and builds terrain, water, buildings, and forest into the live editor.
6. Watch it appear in the editor viewport. Edit the vault (\`vault-template/\`), redraw, re-run step 5 to rebuild.

Ports: \`LIMINA_EDITOR_PORT\` (host, 8787), \`LIMINA_STATIC_PORT\` (editor page, 5173 — the host only trusts the browser origin :5173), design tool port = 2nd arg to start-design.sh.
Optional: set \`ANTHROPIC_API_KEY\` in the environment to enable the editor's chat agent.
`);

for (const f of ["start.sh", "start-design.sh", "build-world.sh"]) chmodSync(join(OUT, f), 0o755);

// ── summary ──────────────────────────────────────────────────────────────────
function duBytes(p) {
  let total = 0;
  const st = statSync(p);
  if (st.isFile()) return st.size;
  for (const e of readdirSync(p)) total += duBytes(join(p, e));
  return total;
}
const mb = (duBytes(OUT) / 1024 / 1024).toFixed(0);
console.log(`\nmake-alpha: done — dist-alpha/ is ${mb} MB\n`);
