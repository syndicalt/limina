# Art Direction — reference set

This folder stores visual-direction evidence for the limina demo suite + the Aethon halo. For production
building architecture, images are inspiration and cue provenance only: agents extract measurable
relationships, construction logic, silhouette intent, and avoid cues, then BuildingProgram + compiler
constraints own geometry. Pixel matching and image-to-3D output cannot satisfy architecture authority.

## How to use it

Drop image files (`.png` / `.jpg`) into the category folders below. A one-line note in this README
(or a sibling `.md`) about *what you like* in each ref is gold ("the chunky pitched roofs", "the warm
dusk light", "the way props cluster around a well"). The agent reads the images + your notes and
builds/iterates the scenes toward them, capturing the native window to compare against the ref.

## Categories (make the subfolders as you add refs)

- `architecture/` — buildings & settlements: rooflines, materials, windows, doors, how a village
  clusters (paths, fences, wells, market stalls). **Most needed first** — the current procedural
  buildings are bare cubes; refs here drive pitched roofs, rotation/variation, openings, and props.
- `terrain/` — landscapes, biomes, water, the overall nature vibe (the eroded-island showcase is
  close; refs sharpen the palette + composition).
- `characters/` — the hero, NPCs (Torvald), creatures (the Blighted Shambler): proportions, rig,
  silhouette, material/shading style.
- `lighting-mood/` — time of day, fog/atmosphere, colour story; for Aethon, the healthy→Blight
  gradient (warm life → drained decay).
- `vibe/` — anything that captures the overall feel (a game, a film, an illustration) even if it
  doesn't fit a category.

## What good refs unlock right now (settlement_showcase, then the halo)

| Gap today | What a ref fixes |
|---|---|
| Flat slab roofs | Pitched/gabled roofs (architecture.ts roof enhancement) |
| All buildings same orientation | Per-building rotation; doors facing a commons/path |
| One door, no windows | Window openings, chimneys, trim |
| Flat untextured boxes | Triplanar masonry/timber PBR tinted by colour |
| Scattered, no focal point | A well/square/path layout; fences, carts, lanterns |

The locked Project Gorgon floor and exact engine/HITL evidence remain the release bar. References help a
reviewer explain why a result succeeds or fails; they are not acceptance evidence by themselves. See
`plans/architecture-program-synthesis.md` and `plans/staged-building-pipeline.md` for the active workflow.
