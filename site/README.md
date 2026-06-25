# Limina — showcase & documentation site

The marketing showcase, documentation, and SDK reference for [Limina](https://github.com/syndicalt/limina),
the agent-native real-time 3D engine. Built with [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build).

- **Landing page** (`/`) — bespoke showcase with a live in-browser Three.js agent demo.
- **Docs** (`/introduction`, `/getting-started`, …) — Starlight, with search.
- **Agent reference** (`/agents`) — machine-first: MCP quickstart + structured endpoints.

## Develop

```bash
npm install
npm run dev        # http://localhost:4321
```

## Build & preview

```bash
npm run build      # static output in dist/
npm run preview
```

`prebuild` runs automatically and regenerates two artifacts so they never drift from source:

- `node scripts/gen-skills-doc.mjs` — writes `src/content/docs/skills.md` from `src/data/skills.json`.
- `node scripts/gen-llms.mjs` — writes `public/llms.txt` and `public/llms-full.txt` from the docs.

Run them by hand with `npm run gen`.

## Agent-facing artifacts

| URL | What |
|-----|------|
| `/agents` | Human hub: machine endpoints + MCP connect quickstart |
| `/agents/skills.json` | All 45 skills as JSON (names, permissions, JSON-Schema inputs) |
| `/llms.txt` | Concise, LLM-readable site index |
| `/llms-full.txt` | Every doc page as one plain-text file |
| `/sitemap-index.xml` | Standard sitemap |

`src/data/skills.json` is the source of truth for the skill catalog (also served at
`public/agents/skills.json`). Regenerate it from the engine source if the skill surface changes.

## Deploying

Static output (`dist/`) deploys to any static host (Vercel, Netlify, GitHub Pages, Cloudflare).

1. Set your real origin in `astro.config.mjs` → `site` (used for canonical URLs, OG tags, sitemap).
2. **GitHub Pages project site only** (e.g. `syndicalt.github.io/limina`): also set `base: '/limina'`
   in `astro.config.mjs`. Not needed for a custom domain or a user/org page.

## Structure

```
src/
  pages/            index.astro (landing) · agents.astro (agent hub)
  layouts/          Landing.astro (marketing shell: head/OG, nav, footer)
  components/       Nav · Footer · Logo + sections/* (Hero, Stats, …)
  content/docs/     Starlight docs (Markdown)
  scripts/          agent-demo.ts (live Three.js hero)
  styles/           global.css (design system) · starlight.css (docs theme)
  data/             skills.json (catalog source of truth)
scripts/            gen-skills-doc.mjs · gen-llms.mjs
public/             favicon.svg · media/og.png · agents/skills.json · llms*.txt
```
