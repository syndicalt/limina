# Quarantined assets

GLBs moved out of `assets/` because they fail the asset-sanity check
(`node tools/qc/asset-sanity.mjs assets`) with a broken authoring scale — placed
raw they swamp any scene (e.g. the giant "grass tuft" that filled a village). Kept
here (git-ignored) rather than deleted, pending a re-bake at real-world scale.

| asset | measured world size | issue |
|---|---|---|
| `prop-camping-tent-1.glb` | ~405 km cubed | OVERSIZE |
| `vegetation-grass-tuft-3.glb` | 239 × 364 × 231 m | OVERSIZE |
| `vegetation-sapling-young-tree-3.glb` | 308 × 509 × 324 m | OVERSIZE |

Re-bake at metre scale (a tuft ≈ 0.3 m, a sapling ≈ 2 m, a tent ≈ 2 m) and run the
checker before returning them to `assets/`.

## Scrapped / superseded (2026-07-08 consolidation)

Moved out of `assets/` because they are experiment residue or explicitly-scrapped
work, referenced by no committed world, catalog, gate, or demo. Kept here
(git-ignored) rather than deleted, so nothing is lost if a body or a building
turns out to be worth reviving.

| asset | why quarantined |
|---|---|
| `commoner-modeled.glb` / `commoner-modeled-rigged.glb` | scrapped one-off character body ("not good enough") |
| `commoner-rigged-1.glb` | scrapped one-off rigged character body |
| `character-medieval-peasant-commoner-grey-wool-tunic-1.glb` | scrapped modular-character spike |
| `cottage-blender-1.glb` | superseded by the catalog's `cottage-authored.glb` |
| `Xbot.glb` / `Soldier.glb` | Mixamo test rigs, never wired to the Character AssetSource |

The character-body pipeline (`tools/rig/rig_contract.py`, `character_assemble.py`)
survives the scrap — only these baked bodies were rejected. See memory
`npc-character-designer` for the stylized-CC0-kit pivot.
