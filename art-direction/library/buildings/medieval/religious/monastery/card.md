---
id: buildings.medieval.religious.monastery
title: Medieval Monastery
tags: [era:medieval, biome:temperate, material:stone, scale:large, mood:solemn, condition:pristine, style:grounded-stylized]
scale: { footprint: "40x40 m courtyard + wings", height: "wings ~8 m, bell tower ~18 m" }
palette: { wall: "#9a8f7e", roof: "#5a4a3a", trim: "#c8bda6", accent: "#3a4a6a (stained glass)" }
materials: { wall: "stone pbr (triplanar limestone)", roof: "timber-shingle pbr", floor: "flagstone pbr", trim: "pale dressed stone" }
features: [cloister-arcade, bell-tower, gabled-roof, arched-windows, buttresses, courtyard-well, walled-precinct]
variations: [chapel (1 wing + small tower), abbey (+ scriptorium + refectory wings), priory (smaller), ruined (broken walls, no roof, ivy)]
engine_gaps: [gabled-roof, arched-window-opening, arcade/colonnade-helper, buttress-prop]
status: stub
---

## Silhouette & proportions
Long, low, horizontal stone wings forming a square **cloister around an open courtyard**, broken by
one **tall vertical accent** — the bell tower at a corner (~2.2× the wing height). Steep **gabled**
roofs (≈45°) — never flat slabs. The read from distance is *horizontal calm + one vertical punctuation*.

## Buildability (maps to limina skills)
1. `world.generateRegion` flat `plains` ground (PBR grass), or place on existing terrain.
2. **Four wings** via `architecture.building` — long + narrow (e.g. 16×6, h≈8), arranged as a square
   ring; **rotate each to face the courtyard** (door + arcade on the inner side). *(rotation isn't a
   building param yet — see engine_gaps; today they'd all face +Z.)*
3. **Bell tower**: one tall narrow `architecture.building` (6×6, h≈18) at a corner.
4. **Gabled roofs**: two angled roof slabs per wing meeting at a ridge — **engine_gap** (architecture.ts
   only does a flat roof slab today). This is the single biggest fidelity lever.
5. **Arched windows + a cloister arcade** along the courtyard walls — **engine_gap** (only a single
   rectangular doorway today).
6. **Dressing**: a central **well** (`scene.createEntity` cylinder + ring), flagstone **path**, a low
   **precinct wall** (`architecture.building` with h≈1.5, no roof), sparse cypress/yew (`asset.scatter`).
7. **Materials**: `createMaterial('stone',{pbr:true})` walls + a darker timber roof material — *not* the
   current flat tint.

## Composition / placement
Sits on flat ground, often walled; courtyard-facing and inward-looking. Pairs with a graveyard, an
orchard, and a path to a village. Temperate/highland biome; reads well under low warm light.

## References
*(drop images here — e.g. `ref-01.jpg` cloister courtyard, `ref-02.jpg` bell tower + gabled roofline,
`ref-03.jpg` the stylized low-poly target. Note per image what to take from it.)*
