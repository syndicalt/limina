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
