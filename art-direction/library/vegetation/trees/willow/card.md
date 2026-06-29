---
id: vegetation.trees.willow
title: Willow (weeping)
tags: [biome:riparian, biome:temperate, material:foliage, scale:medium, mood:tranquil, condition:pristine, style:grounded-stylized]
scale: { footprint: "6-9 m canopy", height: "8-12 m" }
palette: { foliage: "#8fa86a (pale yellow-green)", bark: "#6b5e4a (grey-brown)", accent: "#b7c98a (sunlit fronds)" }
materials: { foliage: "soft translucent leaf", bark: "rough bark pbr" }
features: [short-thick-trunk, broad-low-fork, weeping-trailing-fronds, dome-then-curtain-canopy]
variations: [weeping-willow, pollarded-willow, white-willow (more upright), dead/blighted (bare trailing whips)]
engine_gaps: [deciduous/weeping-tree-asset-or-generator, translucent-leaf-shading]
status: stub
---

## Silhouette & proportions
A **short thick trunk** that forks low into a **broad dome**, from which long **trailing fronds hang
almost to the ground** — the defining read is the *curtain* of drooping branches, not an upright cone.
Wider than tall-feeling despite the height. This is the opposite silhouette to a conifer.

## Buildability (maps to limina skills)
- The engine's tree content is **upright conifers/palms/cacti/rocks** (`biome-content.ts`:
  `PINE_ASSET`, `PALM_ASSET`, `CACTUS_ASSET`, `ROCK_ASSET`) — **there is no deciduous or weeping tree**.
  So a willow is an **engine_gap**, not a param tweak.
- Two paths: (a) author/commission a **weeping-willow asset** registered like the others and add a
  `willow` layer to the riparian biome; or (b) a **procedural weeping tree** generator (trunk cylinder
  → low fork → drooping branch ribbons / billboard fronds) the way terrain is procedural — preferred,
  matches the engine's "agent sets config, generator builds" philosophy.
- Translucent **sub-surface leaf shading** (light through fronds) is what sells it — a shading gap.
- Placement via `asset.scatter` / `world.populateBiome` once the asset/layer exists, **gated to
  water margins** (riverbanks, pond edges) rather than uniform scatter.

## Composition / placement
Clusters at **water's edge** — riverbanks, pond/lake margins, a well or millrace in a village. A few
willows + reeds + a still water plane = an instant tranquil set. Rare on dry high ground.

## References
*(drop images here — `ref-01.jpg` the weeping-curtain silhouette, `ref-02.jpg` a stylized low-poly
willow target, `ref-03.jpg` willows along water for composition.)*
