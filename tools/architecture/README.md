# Limina architectural compiler

This offline, engine-owned authoring pipeline compiles a typed building specification into resolved structural geometry, then asks Blender to realize that immutable IR as one GLB. Blender must not solve joints, openings, stairs, or roof relationships.

Blender 4.0.2 is an explicit authoring dependency. Limina resolves `BLENDER_BIN`, then a package-local tool, then `PATH`, and fails closed on any other version. It is never loaded by the runtime/player.

```sh
bun run --cwd tools architecture:deps
bun run --cwd tools architecture:build -- \
  --spec ../assets/buildings/functional-hall-house-architecture-v1.json \
  --out /tmp/hall-house-architecture-v1.glb \
  --evidence /tmp/hall-house-architecture-v1.evidence.json \
  --blend-out /tmp/hall-house-architecture-v1.source.blend \
  --handoff /tmp/hall-house-architecture-v1.authoring-handoff.json
```

The build now preserves the exact pre-export Blender scene as `*.source.blend` and emits a
`limina.blender-authoring-handoff/v1` manifest binding that source, recipe, compiler IR, Blender/adapter
identity, semantic inventory, source GLB, and semantic LOD package. A fresh background Blender process
reopens and validates the saved file before the handoff is emitted. The GLB is a derived engine artifact;
using Blender's generic **File → Export → glTF** command does not produce a Limina release artifact.

The first handoff slice is deliberately honest about editability: generated semantic objects carry stable
`limina.*` custom properties and are organized into named authoring collections, while applied edge easing is
recorded as only partially modifier-preserving. The beginner Limina workspace, bounded edit controls, and
round-trip override/rebase workflow remain subsequent milestones in
[`plans/staged-building-pipeline.md`](../../plans/staged-building-pipeline.md).

Every build records the spec and IR hashes, exact Blender/platform identity, adapter hash, source asset hash, semantic LOD asset hash and measured LOD budgets, plus the ordered review gates (including the conditional construction-expression gate). By default it writes the production package beside `name.glb` as `name-lod.glb`; `--lod-out` can choose an explicit private build path. The packager preserves compiler primitives whole, batches only static geometry, and keeps the articulated door outside every LOD batch. A stage may only be reviewed after its prerequisite hash matches. The generated `.architecture.json` is private intermediate authoring data; only the packaged GLB enters the engine asset pipeline.

The packaged-byte contract is independently reproducible with `bun run js/test/p_architecture_lod_package.ts /path/to/name-lod.glb`. It recomputes encoded triangle/draw totals, proves semantic-source coverage, and fails if the authored door appears in any static batch.

The hall-house compiler now owns the supported volumes, ordered wall/opening topology, floors and ceilings, articulated exterior door, deep window assemblies, paired gable and dormer roof systems, valleys, open chimney/flue, cricket, hearth, furnishings, PBR material authority, and compiler-selected whole-primitive LOD membership. Engine capture and human visual review remain separate mandatory gates.

FB-4 multi-room builds use the same one-way adapter and editable handoff. For a v2 functional contract,
the serialized Blender input carries an explicit `limina.blender-multi-room-realization/v1` inventory. The
adapter fails closed unless every stair has its compiler-owned treads and both landings, and every partitioned
upper floor contains all fragments while excluding the prohibited full slab. The exported GLB retains typed
room, portal, vertical-link, spawn-anchor, and visibility-cell nodes under the sole semantic root; collider and
door runtime authority is read from those semantic nodes rather than duplicated asset metadata. Reproduce the
CPU-only compiler → Blender → strict-parser proof (it does not render) with:

```sh
bun js/test/p_architecture_blender_multi_room.ts
```

The program-first FB-4 candidate builder is also CPU-only. It resolves the coordinate-free program through
the bounded typology rulebook, closes gables through `GableRoofSystemSpec`, fulfills required per-space
daylight, derives non-colliding perceptual exterior frames in the compiler, runs Blender validation and LOD
packaging, and publishes a new append-only candidate only if every step succeeds:

```sh
bun tools/architecture/build-fb4-multi-room-candidate.ts
bun js/test/p_fb4_v2_cpu_candidate.ts
LIMINA_ASSET_ROOT=assets ./target/release/limina js/test/p_fb4_program_candidate_native_traversal.ts
```

Candidate identity includes the program, decision/spec/IR, recursively resolved production modules, explicit
Python/toolchain files, every pinned visual-reference byte, and every material manifest/image consumed by the
adapter. The d0ca and 1b447 candidates are immutable central rejections; neither is a current visual candidate.
These commands do not initialize a renderer or transfer visual approval. Proxy and site-review commands require
explicit append-only candidate/output paths; there is no manually synchronized default candidate.

The exact FB-4 V4 R1 candidate `functional-hall-house/fb4/1f375ec3abe1` is the approved multi-room
authority. Its owner approval is append-only and candidate-specific; it does not authorize a later render.
FB-5 publishes only after independently replaying that complete ledger:

```sh
bun tools/architecture/build-fb5-functional-building-publication.ts \
  --candidate-manifest assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/candidate-manifest.json \
  --review-outcome assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-central-passed.json \
  --review-outcome assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-hitl-approved.json \
  --approved-outcome assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-hitl-approved.json \
  --publication-id publication/functional-hall-house/fb4-v3-r1 \
  --catalog-id settlement/functional-buildings --catalog-revision 1 \
  --entry-id building/functional-hall-house-fb4 \
  --family-id house/functional-hall --variant-id fb4-v3-cross-gable \
  --out assets/buildings/catalog/functional-hall-house-fb4-v3-r1.json
```

The settlement builder consumes only that independently verified publication and a bounded recipe. It emits
one atomic directory containing canonical WorldMap, strict plan, per-placement site artifacts, and the
terminal release record:

```sh
bun tools/architecture/build-fb5-functional-settlement.ts \
  --recipe assets/buildings/authoring/functional-hall-house-v4/fb5-functional-hall-settlement-r1-recipe.json \
  --out-root assets/settlements/functional-hall-r1
bun js/test/p_fb5_functional_settlement_release.ts
LIMINA_ASSET_ROOT=. LIMINA_AUDIO=null ./target/release/limina \
  js/test/p_fb5_functional_settlement_release_native.ts
```

These commands are CPU-only and do not initialize a renderer. The native proof mounts the real approved LOD
GLB through `building.placeFunctional`, checks exact large-coordinate Atlas/site transforms, enforces
whole-building residency bounds, and unloads atomically. Normal `CoreSkills` exposes
`functionalSettlements.releaseHost`; it independently loads the exact release, samples resident editable or
generated terrain, drives the released residency manager, enrolls snapshot ownership, and unregisters it on
atomic close. The exact live-host and restore/continuation proofs are:

```sh
LIMINA_ASSET_ROOT=. LIMINA_AUDIO=null ./target/release/limina \
  js/test/p_functional_settlement_live_host_native.ts
LIMINA_ASSET_ROOT=. LIMINA_AUDIO=null ./target/release/limina \
  js/test/p_fb5_functional_settlement_snapshot_replay.ts
```

The separate furnishing-sidecar builder binds previously approved functional furniture to room-contained
sockets without changing reviewed pixels:

```sh
bun tools/architecture/build-fb5-functional-settlement-furnishing.ts \
  --recipe assets/settlements/functional-hall-r1/furnishing-recipe-r1.json \
  --out assets/settlements/functional-hall-r1/furnishing-authority-r1.json
bun js/test/p_fb5_functional_settlement_furnishing.ts
```

R1's sidecar is deliberately dormant: zero furniture meshes, colliders, or ECS entities. Its three variants
are arrangement authorities, not plural building variants. Visible/physical furnishing or a distinct building
GLB is new rendered content and still requires the guarded capture path plus explicit HITL.

The staged migration additionally supports `architecture:build-shell`, which emits a functional shell GLB and
editable source blend while excluding independently owned furniture, props, fire visuals, and practical
lights. The current migration artifact and editing notes live under
`assets/buildings/authoring/functional-hall-house-v4/`.

Shell review revisions are append-only. The artifact builder retains its r1 defaults; a later revision must
declare a matching artifact id and revision, then receive its own review authority:

```sh
bun tools/architecture/build-shell-stage-artifact.mjs \
  --evidence assets/buildings/authoring/functional-hall-house-v4-r2/shell.evidence.json \
  --out assets/buildings/authoring/functional-hall-house-v4-r2/shell-artifact-draft.json \
  --artifact-id shell/functional-hall-house-v4/r2 --revision 2
bun tools/architecture/build-shell-review-authority.mjs \
  --artifact assets/buildings/authoring/functional-hall-house-v4-r2/shell-artifact-draft.json \
  --evidence assets/buildings/authoring/functional-hall-house-v4-r2/shell.evidence.json \
  --out assets/buildings/authoring/functional-hall-house-v4-r2/shell-review-authority.json
```

Revision 2 and later outputs use exclusive creation and fail if their target already exists. The r1 artifact
id, revision, output behavior, environment closure, and canonical eight-view review composition are unchanged.

Before a furniture pack can enter an approved interior composition, run the CPU-only functional verifier
against its exact GLB bytes and the approved I1 plan closure:

```sh
bun tools/architecture/verify-furniture-function.ts \
  --contract assets/buildings/authoring/furniture/<pack>/design-contract.json \
  --evidence assets/buildings/authoring/furniture/<pack>/build-evidence.json \
  --glb assets/buildings/authoring/furniture/<pack>/<pack>.glb \
  --i1-artifact assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-approved.json \
  --i1-plan assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json \
  --proxy proxy/<archetype> \
  --out assets/qc/private/furniture-functional/<pack>-evidence.json
```

The output is deterministic, private (`0600`), and append-only. The command exits with status 2 after writing
failure evidence when any gate fails. It independently inspects the GLB scene graph and fails closed on byte
or bound drift, missing per-part geometry, an ungrounded pivot, disconnected or implausible joints, unstable
support, unusable interaction sockets, implausible compound collision, I1 envelope overflow, and unproven LOD
claims. It does not render and does not modify review candidates, authorities, or captures.

Storage furniture has an additional typed functional facet. A service-storage contract must identify exactly
four usable tier parts, its grounded vertical supports, one exact approach socket, a rated load per tier, and
local `-X` as its canonical front. The verifier proves tier dimensions and spacing from exported GLB bounds,
requires every tier to join at least two declared supports, checks that the central open-front apertures are not
occluded, applies the rated payload at the front edge for stability, and binds the transformed approach socket,
floor capacity, and runtime envelope to the exact approved I1 placement. For the cottage service rack, the
approved envelope is `X=.4 m` depth, `Y=1.8 m` height, and `Z=1.0 m` frontage; treating `.4 m` as the façade
width is an axis error and fails the review-camera contract.

The furnished C1 composition is produced from exact approved bytes only. Manifest v2 preserves the bounded
v1 contract unchanged while adding the approved M1 runtime/lock and role-aware furniture bindings: tables do
not invent occupancy or facing sockets, chairs do not invent approach sockets, storage does not invent a
facing target, and the hearth settle binds two occupancies plus its front approach. The producer is CPU-only
and writes append-only:

```sh
node tools/architecture/build-furnished-c1-composition.mjs \
  --out assets/buildings/authoring/functional-hall-house-v4/composition-r2/composition-manifest.json
```

It fails closed unless shell r4, M1 r2, I1 r3, and the exact approved table, chair, service-storage, and
hearth-settle r6 artifacts, decisions, source blends, runtime GLBs, contracts, build evidence, and functional
evidence all match their pinned hashes. Producing this manifest does not render and does not pass C1; the
integrated CPU verifier and guarded production-engine review remain mandatory downstream gates.

Composition r1 is preserved as deterministic failure evidence: its universal one-degree per-socket facing
threshold rejected the approved settle because the two seats view one shared hearth point from opposite
offsets. Composition r2 supersedes r1 without changing geometry or placement. Chairs retain the one-degree
threshold; the settle uses a bounded seven-degree per-seat threshold, just above the measured 6.649-degree
shared-target parallax.

The CPU-only R1 package assembler accepts the final LOD result and KTX2 production manifests as explicit
inputs. It independently hashes their referenced GLBs, validates the exact approved C1 r3 and V1 r15
authorities, proves the 654 semantic nodes, 123 colliders, 12 sockets, seven composition instances, three LOD
measurements, Basis-only textures, and artifact/residency budgets, then emits three append-only records:

```sh
node tools/architecture/build-production-package-candidate.mjs \
  --lod-manifest .limina/<final-run>/lod-result.json \
  --ktx2-manifest .limina/<final-run>/production.ktx2.json \
  --mount-evidence traces/<native-production-mount-evidence>.json \
  --manifest-out assets/buildings/authoring/functional-hall-house-v4/production-r1/package-manifest-draft.json \
  --evidence-out assets/buildings/authoring/functional-hall-house-v4/production-r1/cpu-evidence.json \
  --candidate-out assets/buildings/authoring/functional-hall-house-v4/production-r1/package-artifact-candidate.json
```

The editable C1 Blend remains bound as authoring authority. The two exact integrated engine mount modules
(`building-production-package.ts` and `building-fire-production-facet.ts`) are pinned byte-hashed inputs;
approved V1 source closure alone is not treated as proof that final assembly can
mount. V1 is deliberately not baked into the production
GLB: its approved contract, fuel Blend/GLB, recipe, and procedural runtime/render-binding/volumetric sources
remain a separately mounted runtime facet. Successful CPU closure records `humanDecision: pending`, never
claims R1 visual approval, and performs no rendering or GPU work.

Before final candidate assembly, `--assembly-only` may write an explicitly mount-pending preliminary package
for the native CPU lifecycle test. The final builder requires that append-only trace to bind the exact
production GLB and engine hash, LOD/KTX manifests, C1/V1 approvals, both mount modules, frozen verifier source,
arbitrary transform, single visual mount, semantic inventories, three deterministic mount/dispose cycles, and
snapshot/fire restore. The mount trace is evidence only and does not enter the package contract hash, avoiding
a package/evidence self-reference.
