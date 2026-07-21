# GLB transform ownership

Keep these transform paths separate by responsibility. Similar matrix loops are not automatically
interchangeable.

| Path | Ownership | Disposition |
| --- | --- | --- |
| `gates/design/asset-qc-gate.mjs` (`measureGlb`) | General, dependency-free active-scene world AABB measurement | Canonical for host QC bounds. It returns min, max, and dimensions. |
| `tools/qc/asset-sanity.mjs` (`glbBbox`) | Legacy `{mn,mx}` host-tool API | Compatibility wrapper over `measureGlb`; do not reintroduce matrix math here. |
| `tools/architecture/glb-runtime-geometry.mjs` | Furniture-contract semantic inventory, per-part bounds, and pivot validation | Retain as a specialized fail-closed inspector. It intentionally reasons about contract parts rather than every active-scene mesh. |
| `tools/asset/batch-composition-production-lod.mjs` | Binary vertex baking, inverse-transpose normal transforms, semantic batching, deterministic output | Retain local validated math. Bounds-only helpers cannot replace its position/normal rewrite kernel without changing byte- and hash-pinned output. |
| `tools/asset/batch-architecture-building.mjs` | Building binary vertex/direction baking and semantic LOD batching | Retain local math for the same binary-rewrite and deterministic-output reason. |
| `tools/asset/batch-hall-house-v4.mjs` | Legacy hall-house binary vertex/direction baking with a pinned source authority | Retain until that legacy artifact pipeline is retired; do not route it through a bounds-only abstraction. |
| `tools/asset/flatten-vegetation-glb.mjs`, `tools/curate.ts` | glTF Transform document mutation and bounds | Retain the library implementation; these are not manual helper duplicates. |

Behavioral parity for nested TRS, explicit node matrices, active-scene reachability, and the furniture
semantic inspector lives in `tools/qc/glb-bounds-parity.test.mjs`.
