# __APP_NAME__

A [Limina](https://github.com/syndicalt/limina) world. You author the world in
**one file** — `world.ts` — through typed, permissioned skills, then export it to
a portable bundle that plays in a browser tab.

## Zero to a running world

```sh
# 1. Scaffold (you already did this)
npx create-limina-app __APP_NAME__

# 2. Install
cd __APP_NAME__
npm install

# 3. Play the sample instantly — NO native toolchain needed.
npm run dev
#    → http://localhost:5173  (a prebuilt sample world, in your browser)
```

`npm run dev` serves a **prebuilt sample** using the bundled browser player, so you
get instant gratification with nothing to compile.

## Author your own world

```sh
# 4. Edit the world.
$EDITOR world.ts

# 5. Export world.ts → dist/  (this step uses the native `limina` binary).
npm run export

# 6. Play YOUR world.
npm run serve
#    → http://localhost:4173
```

`world.ts` exports an async `buildWorld({ registry, base, world, core })`. Everything
is authored through `registry.invoke("world.generateRegion", …)` and friends — no
hand-rolled geometry. The starter builds a textured island with depth-aware water,
biome-correct scatter, and one interactive treasure. Change the `SEED`, the terrain
`type`, or add NPCs / quests / triggers.

## The native binary (only `export` needs it)

`npm run dev` is browser-only. `npm run export` runs your `world.ts` through the
real deterministic engine — the native `limina` runtime — so it needs the binary:

- **`LIMINA_BIN`** — path to the `limina` binary, e.g.
  `LIMINA_BIN=/path/to/limina/target/release/limina npm run export`
- **`LIMINA_HOME`** — the limina checkout (the dir holding `js/` + `assets/`). If
  you set `LIMINA_BIN` inside a checkout (`…/target/release/limina`), this is
  derived automatically.

Don't have it yet? Clone limina and build it once:

```sh
git clone https://github.com/syndicalt/limina && cd limina && cargo build --release
# then, from your world project:
LIMINA_HOME=/path/to/limina npm run export
```

If the binary or source tree can't be found, `npm run export` prints exactly what
to set.

## What `npm run export` produces

`dist/` — a self-contained, browser-playable bundle:

| file | what |
|---|---|
| `manifest.json` | world id, versions, counts, content-addressed asset refs |
| `log.jsonl` | the authoritative command stream (seed + skills) |
| `keyframes.jsonl` | body transforms for replay (empty for a static world) |
| `tiles.jsonl` | baked terrain tiles |
| `assets.jsonl` | the model bytes (so the bundle is self-contained) |
| `view.json` | camera framing |
| `index.html` + `limina-player.js` | the page + player that replay it |

You can host `dist/` anywhere static.

## Layout

```
__APP_NAME__/
├─ world.ts            ← the world you author (edit this)
├─ limina.d.ts         ← editor types for buildWorld (erased at runtime)
├─ tsconfig.json
├─ package.json
├─ scripts/
│  ├─ export.mjs       ← world.ts → dist/  (drives the native limina binary)
│  └─ serve.mjs        ← a zero-dependency static server
└─ public/
   ├─ index.html       ← the player page (WebGL2 gate + poster fallback)
   ├─ limina-player.js ← the prebuilt browser player
   └─ island/          ← the prebuilt sample world for `npm run dev`
```
