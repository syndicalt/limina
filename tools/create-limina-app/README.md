# create-limina-app

Scaffold a new [Limina](https://github.com/syndicalt/limina) world: zero to a
world running in a browser tab in under a minute.

```sh
npx create-limina-app my-world
cd my-world
npm install
npm run dev      # plays a prebuilt sample instantly — no native toolchain
```

Then author your world in `world.ts` and:

```sh
npm run export   # build dist/ from world.ts (uses the native limina binary)
npm run serve    # play your world
```

## Options

```
create-limina-app <project-directory> [--force] [--help] [--version]
```

- `--force` — scaffold into a non-empty directory (same-named files overwritten).
- The project name is taken from the directory name; it must be a valid npm-style
  name (lowercase letters, digits, `-`, `_`, `.`).

## Publishing

This package bundles the scaffold template via the `files` field. In the limina
repo the template lives at `tools/scaffold/`; before `npm publish`, copy it next
to `index.mjs`:

```sh
cp -r ../scaffold ./scaffold && npm publish
```

`index.mjs` finds the template at `../scaffold` (repo layout) or `./scaffold`
(published layout) automatically.
