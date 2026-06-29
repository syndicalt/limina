# Reference Library — schema (spike)

The library is the **art-knowledge layer**: it turns an agent's intent ("a medieval monastery", "a
willow by the river") into limina skill calls **at the OOB-quality bar**, and surfaces what the engine
must build to get there. It is consumed by an agent, so it optimizes for *retrieval + buildability*,
not just inspiration.

## Organizing principle

**Flexible-depth taxonomy tree + cross-cutting tags + a recipe card at each leaf.**

- **Tree** (`type > genre > detail`, depth as needed): the primary path, e.g.
  `buildings/medieval/religious/monastery`, `vegetation/trees/willow`.
- **Tags** (multi-axis, on every card): `era`, `biome`, `material`, `scale`, `mood`, **`condition`**
  (pristine / weathered / ruined / **blighted**), `style`. These answer queries the tree can't —
  "all stone things", "everything for a temperate forest", "the blighted variant of X".
- **Leaf = a folder** holding `card.md` + the reference images. The agent reads the images (visual
  target + fidelity judge) and the card (how to build it + what's missing).

```
art-direction/library/
  buildings/medieval/religious/monastery/
    card.md            # the recipe
    ref-01.jpg ...     # reference images (you drop these)
  vegetation/trees/willow/
    card.md
    ref-01.jpg ...
```

## Card schema (`card.md` = YAML frontmatter + prose body)

Frontmatter (structured / queryable):

| Field | Meaning |
|---|---|
| `id` | dotted path, e.g. `buildings.medieval.religious.monastery` |
| `title` | human name |
| `tags` | cross-cutting: `[era, biome, material, scale, mood, condition, style]` |
| `scale` | rough metres (footprint + height) — drives params |
| `palette` | named hex roles: `{ wall, roof, trim, accent }` |
| `materials` | role → limina material recipe: `{ wall: "stone pbr", roof: "timber shingle" }` |
| `features` | the silhouette-defining parts: `[bell-tower, cloister, arched-windows, gabled-roof]` |
| `variations` | siblings within the type: `[chapel, abbey, ruined]` |
| `engine_gaps` | **what the engine can't do yet** to hit this: `[gabled-roof, arched-window]` |
| `status` | `stub` (await refs) / `recipe` (buildable) / `verified` (captured ≈ ref) |

Body (prose, for the agent to reason from):

- **Silhouette & proportions** — the read-from-300m shape; the ratios that matter.
- **Buildability** — a numbered recipe that maps to *actual* limina skills + params (the heart of the
  card; this is what I execute).
- **Composition / placement** — how instances sit + cluster; what they pair with; biome fit.
- **References** — list the image files + a one-line note on what to take from each.

## Why this shape (agent's view)

- I need the **image** to set the target and to judge "is my capture close?" — but I can't *act* on an
  image alone.
- I need the **buildability recipe** to translate the look into `architecture.building` / `world.*` /
  `scene.*` / material calls — this is the part neither "just images" nor "asset links" gives me.
- I need **engine_gaps** so the library doubles as the content-capability backlog: cards I can't yet
  build to the bar name exactly what skill work unlocks them.
- I need **tags** because scenes are multi-axis (a *blighted temperate ruined* monastery is a real
  query the tree can't express).

A card is **`verified`** only when a native-window capture of the built scene reads like its reference.
