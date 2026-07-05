---
id: characters.medieval.villager.commoner
title: Villager (commoner)
tags: [role:npc, era:medieval, scale:human, style:grounded-stylized, condition:lived-in, archetype:villager, material:wool, material:linen, material:leather, mood:humble]
engine_gaps: [rigged-body-source, outfit-variation-multi-zone]
status: reviewed
---

## What it is
A common villager — a peasant farmer/labourer who works the land around the settlement. Humble,
weathered, unhurried; comfortable stopping to talk. Reads instantly as "ordinary working folk": NOT
armoured (that's the guard), NOT robed (priest/elder), NOT brightly dyed (vendor).

## References to drop
- commoner-0 (painterly): pitchfork farmer by a half-timbered cottage — cream linen undershirt, brown
  sleeveless leather jerkin, black belt, charcoal hose, tall brown boots, brown padded coif.
- commoner-1 (historical plate): peasant couple — russet knee tunic + cross-gartered hose (man); blue-grey
  kirtle over cream underskirt + white wimple (woman).
- commoner-2 (reenactment): grey wool knee-tunic, thin leather belt, mustard wool hood, natural oatmeal
  hose, pointed leather turnshoes. Bearded.

## Visual target (the synthesis)
CANONICAL = commoner-2 (the plain reenactment look) — the humblest, fewest-parts silhouette; commoner-0
(jerkin + shirt) and commoner-1 (russet tunic) are VARIATION on the same base.
- **Silhouette:** a plain knee-length belted wool T-tunic over natural hose, low pointed leather
  turnshoes, and a soft wool hood/coif. Medium build; bearded common.
- **Palette — earthy, MUTED, undyed / naturally-dyed** (never saturated). Per OUTFIT ZONE → palette role:
  - `tunic` -> grey wool (`slate`)
  - `hose`  -> natural oatmeal/undyed (`trim`)
  - `cap`   -> mustard/tan wool (`ground`)
  - `boots`, `belt` -> brown leather (`wood`)
  Variation swaps `tunic` to a muted russet (`accent`, low-sat) or adds a brown `jerkin` (`wood`) over a
  cream `undertunic` (`trim`) for the commoner-0 read.
- **Materials:** coarse wool, linen, leather; hand-made, slightly worn (condition: lived-in, not pristine).
- **Props (later):** a working tool at hand or a sickle/knife at the belt (pitchfork, rake, staff).

## Distinguishing read (vs the other archetypes)
guard = mail + tabard (`metal`); priest = long dark robe (`slate`); elder = plain grey robe + staff;
vendor = brighter dyed cloth (`accent`). Commoner = the earthy, undyed baseline everyone else departs from.

## Likely build path
Rigged humanoid from the Character AssetSource (world/character-body.ts) + shared walk/idle clips.
GAPS: (1) a grounded-stylized medieval rigged body asset (curated pack or generated — the reference bar
is commoner-0's painterly-realist look). (2) outfit variation is MULTI-ZONE (shirt / jerkin / hose /
boots / cap each their own material), so the CharacterBrief `appearance` single `outfitPalette` tint is too
coarse — needs a per-zone material map for a believable commoner.
