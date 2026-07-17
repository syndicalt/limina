# Hero Asset Build Pipeline

**Status:** PLANNED — specialized profile over the native asset-generation pipeline.  
**Parent:** [`native-asset-generation-pipeline.md`](./native-asset-generation-pipeline.md)  
**Uses:** [`modeling-loop-spike.md`](./modeling-loop-spike.md),
[`visual-fidelity-release-contract.md`](./visual-fidelity-release-contract.md)

## Goal

Give focal-point assets—castles, sacred trees, monoliths, temples, major gates, monumental ruins,
and comparable landmarks—a dedicated build and review lane without creating a second incompatible
asset ecosystem.

Regular assets optimize for throughput, modular reuse, consistency, and predictable fleet budgets.
Hero assets optimize for unique silhouette, narrative construction, bespoke interaction, site
integration, and authored detail across landmark, approach, human, and interior scales. Both lanes
use the same content identities, Blender/export tooling, semantic contracts, KTX2 material path,
engine loaders, lifecycle rules, and production-render acceptance boundary.

## Architecture: one compiler, two profiles

```text
shared asset compiler
├── regular profile
│   ├── reusable archetype or kit brief
│   ├── standardized geometry/material/texture budgets
│   ├── automated canonical review views
│   └── fleet-level regression and publication
└── hero profile
    ├── asset-specific visual thesis and reference board
    ├── bespoke geometry/material/interactions budget envelope
    ├── site, approach, traversal, and state contract
    ├── asset-class review profile
    └── mandatory exact-artifact human approval
```

The hero profile is an authority layer over the shared pipeline, not a runtime exception. It may
authorize larger measured budgets and custom offline authoring stages. It may not bypass import QC,
content hashing, deterministic rebuild evidence, LODs, compression, lifecycle ownership, engine-only
review, or human approval.

## Shared foundation

Both profiles require:

- a machine-readable prompt/reference iteration manifest;
- Blender-authored source and deterministic export evidence;
- stable semantic IDs and content-addressed artifacts;
- structural, material, collision, traversal, animation, and replay gates appropriate to the asset;
- production GLBs with discrete LODs and compressed PBR textures;
- bounded geometry, draws, decoded/compressed texture residency, collision, and streaming;
- engine-pipeline captures only—Blender viewport/Cycles and generated concept images are modeling
  cues, never acceptance evidence;
- central inspection before private review staging; and
- human approval bound to the exact engine artifact hashes.

## Additional hero authority

Every hero asset carries a `heroAssetProfile` alongside the shared asset manifest:

1. **Visual thesis.** The one-sentence identity of the asset and the silhouette features that make it
   recognizable without materials.
2. **Narrative construction.** Builder/culture, age, purpose, construction sequence, maintenance,
   repairs, damage, ritual use, and weathering logic.
3. **Scale reads.** Required landmark-distance, approach, human-scale, detail, interaction, and
   interior/canopy views.
4. **Site contract.** Terrain grading, foundation/root contact, roads or paths, entrances, vegetation
   exclusion, sightlines, approach sequence, background separation, and lighting intent.
5. **Interaction contract.** Gates, doors, climbing, traversal, destruction, ritual states,
   emissive changes, animation, interiors, or other asset-specific state.
6. **Budget envelope.** Explicit per-LOD triangles, draws, materials, texture residency, collision,
   animation, streaming, and target-hardware thresholds. A larger budget is valid only when measured
   and justified by the visual thesis.
7. **Review authority.** Canonical engine cameras, states, distances, time/lighting constraints,
   regression hashes, and required human comparisons.

## Prompt and visual-cue cycle

```text
art thesis + references + site brief
                │
                ▼
       concept / construction sheet
                │ modeling cue only
                ▼
       Blender source authoring
                │
                ▼
 structural + semantic + budget gates ──fail──► targeted source correction
                │ pass
                ▼
 production export → LOD/KTX2/package gates
                │
                ▼
 canonical production-engine review set
                │
                ▼
 structured critique by scale read and feature
                │
                ├── revise prompt/brief
                ├── revise Blender source
                ├── revise site integration
                └── revise budget authority with evidence
                │
                ▼
 exact-artifact human approval
```

Each cycle records the source prompt, reference hashes and roles, construction response, exported
artifact identities, engine-view identities, observed gaps, accepted/rejected decisions, and next
revision. Subjective visual judgment remains human-owned; automated gates falsify structural and
budget claims rather than inventing a proxy beauty score.

## Hero asset-class profiles

### Castle / monumental architecture

- Preserve compound silhouette across keep, towers, curtain walls, gatehouse, roofs, and skyline.
- Require modular-kit seam coherence while retaining bespoke focal geometry.
- Author entrances, gates, stairs, battlements, wall walks, interiors, navigation, and traversal.
- Define destructible or state-changing sections explicitly; never infer them from render meshes.
- Review from landmark distance, primary approach, gate interaction, courtyard, interior, skyline,
  and every active destruction/state variant.

### Sacred tree / monumental organic

- Preserve trunk gesture, primary branch hierarchy, canopy massing, crown negative space, and root
  silhouette through every LOD.
- Author bark, scars, hollows, growth layers, epiphytes, ritual attachments, and biologically placed
  weathering rather than uniform noise.
- Bind roots to terrain and reserve a site exclusion/clearing volume; define climb, hollow, harvest,
  wind, emissive, or ritual states where present.
- Review from skyline distance, approach, trunk scale, canopy interior, root contact, wind, and
  every active state.

### Monolith / shrine / sculptural landmark

- Preserve primary sculptural planes, negative space, lean, fracture, inscriptions, and profile at
  distance.
- Require authored material strata, erosion, contact, carvings/inlays, and readable state surfaces.
- Define ritual, emissive, moving, destructible, or puzzle states as semantic subtrees and engine
  state—not baked presentation tricks.
- Review from distant silhouette, processional approach, human-scale inscription, contact/base,
  reverse silhouette, and every active state.

New classes add profiles beneath this lane; they do not fork the shared compiler.

## LOD and streaming rules

- Hero LODs are custom-authored or independently reviewed. Generic decimation cannot erase the visual
  thesis, entrances, active state geometry, or dominant negative spaces.
- Every LOD carries a shared semantic-set identity and measurable silhouette/material parity.
- Site-critical collision and interaction authority are independent of visual LOD.
- Large compounds may stream by authored sectors, but sector boundaries, portal visibility, and state
  ownership must be deterministic and artifact-bound.
- Distant proxies/impostors are allowed only after fixed-camera transition review proves no identity
  loss, popping, missing state, or lighting discontinuity.

## Acceptance evidence

A hero asset is not approved because its isolated turntable looks good. Required evidence includes:

- deterministic Blender rebuild and exact source→production hash chain;
- structural/semantic/interaction/LOD/material/compression gates;
- target-hardware performance, memory, streaming, and repeated lifecycle return;
- fixed-authority engine captures for every declared scale read and state;
- site-integrated regression with terrain, vegetation, lighting, and approach composition;
- no below-floor view in the review set; and
- explicit human approval of the exact production-engine artifact set.

## Delivery slices

| Slice | Deliverable | Exit evidence |
|---|---|---|
| **H0 — profile contract** | `heroAssetProfile` schema, class registry, budget/review authority | malformed, incomplete, and unbounded profiles fail closed |
| **H1 — iteration packet** | reference/prompt/site manifest and critique-cycle template | exact cue and cycle provenance round-trips |
| **H2 — modeling integration** | Blender authoring template plus semantic/site/interaction hooks | deterministic source rebuild and structural gates |
| **H3 — production compiler** | custom LOD, batching, KTX2, collision, and streaming policies | real per-LOD/resource accounting and parity gates |
| **H4 — engine review set** | distance/approach/detail/interaction/site capture harness | internal-only guarded captures with exact hashes |
| **H5 — class proofs** | one castle, one sacred tree, one monolith | each passes its class profile and target-hardware gates |
| **H6 — publication** | approved hero catalog entries and reusable templates | exact-artifact human approval and regression closure |

The first proof should use a single site and one asset class. Generalize only after the full
prompt→Blender→production-engine→critique→approval loop succeeds without asset-specific pipeline
patches.

