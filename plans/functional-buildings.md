# Functional buildings

Status: **FB-2 CLOSED; FB-3 COMPLETE; FB-4 CLOSED; FB-5 R1 MECHANICALLY RELEASED (2026-07-18).** The Blender-authored R1 cottage
passed the functional, production-package, guarded native-WebGPU, and exact human-review gates.
FB-3 added occupant-safe interaction without changing its reviewed pixels. FB-4 is the additive
multi-room authority; it does not reinterpret the approved v1 artifact. The exact
`fb4-multi-room-candidate-v3-1f375ec3abe1` is CPU/native-host closed and supersedes the revised R4
candidate without mutating its audit evidence. It corrects the disconnected fireplace masonry, moves
the stair to a rear U-return landing with a compiler-checked two-flight headroom opening, and terminates
weather-bearing walls below roof planes so wall material does not protrude through the roof. Its guarded
V4 R1 capture completed on ARM64 with timestamp queries disabled and no NVIDIA Xid before, during, or
after capture. Eight exact 1920x1080 engine views passed central review and received explicit owner
approval for candidate `functional-hall-house/fb4/1f375ec3abe1`. The append-only terminal record is
`fb4-1f375ec3abe1-v4-r1-hitl-approved.json` (raw SHA-256
`3856d6a9b03fad5cf82e838b587ff44be1d5465fdfd55fca06b4c3fb6f7a55ac`). The replacement also includes the program-first synthesis migration described in
[`architecture-program-synthesis.md`](./architecture-program-synthesis.md).

The architecture/interior/furniture/VFX workflow and its HITL gates are specified in
[`staged-building-pipeline.md`](./staged-building-pipeline.md). The first complete run of that pipeline is
the approved R1 cottage; rendered changes remain append-only and require a new exact-artifact review.

The active generation authority is one-way: coordinate-free `BuildingProgram` semantic intent,
deterministic bounded synthesis, one selected generated `ArchitectureSpec`, then the existing compiler,
Blender adapter, functional-building contract, and engine review path. Historical coordinate-authored
fixtures remain replay evidence but may not be imported by future production candidate builders.

## Architectural compiler migration

The production cottage was moved from independently positioned Blender solids to the offline
engine-owned compiler in `js/src/architecture`. The compiler is the sole construction authority;
Blender realizes its immutable IR and may add authored surface detail, but may not recompute walls,
openings, stairs, roof intersections, or penetrations. Runtime placement remains asset-only.

The approved specification derives the supported main hall and service-bay volumes, eight
ordered wall edges, floor/ceiling slabs, true exterior and internal passage voids, five complete
ground-floor window assemblies, an articulated front door, a unified entrance, four roof planes,
and two dual-substrate valley seams. Dormer/gable closure, chimney penetration/flashing, semantic
functional/visual contracts, pinned Poly Haven material and UV authority, LOD production closure,
and the five guarded engine views all closed in R1. Commands and the pinned Blender boundary are
documented in `tools/architecture/README.md`.

## Definition of functional

A building is not functional because its mesh resembles architecture. It must carry the versioned
`limina.functional-building/v1` contract in its GLB, use stable semantic string identities, expose a
walkable room and exterior portal, use decomposed shell collision that leaves the doorway clear, and
carry a separate door leaf with a hinge, closed/open poses, collider dimensions, and canonical
`door/<id>/open` clip. The pure-byte parser runs in the authoritative simulation worker without
GLTFLoader or texture decoding and rejects decorative fakes before placement mutates the world.

Generic `asset.place` remains correct for inert props but must not place enterable buildings: its one
whole-asset AABB intentionally fills every interior and doorway. Functional assets use
`building.placeFunctional`; they must never pass through `building/glb-part.ts`, which flattens the
hierarchy and destroys articulated pivots.

## Reproduce the first slice

```sh
blender --background --factory-startup --python tools/blender/functional-cottage.py -- \
  --out assets/buildings/functional-cottage-v1.glb
node js/test/p_functional_building_contract.ts
./target/release/limina js/test/p_functional_building_door.ts
./target/release/limina js/test/p_functional_building_replay.ts
(cd js && ./node_modules/.bin/tsc -p tsconfig.check.json --noEmit)
```

The Blender build is byte-reproducible. The accepted mechanical artifact is pinned in
`art-direction/functional-cottage-v1-closure.json`. It is not a Project Gorgon visual candidate and
must not be shown for visual approval until an art pass reaches the locked floor.

## Roadmap

1. **FB-1 — one-room mechanical slice (complete).** Strict embedded contract, Blender generator,
   decomposed collision, absolute/idempotent door state, arbitrary-yaw placement, native character
   closed-block/open-enter proof, replay, snapshot toggle, and leak-free teardown.
2. **FB-2 — production cottage art pass (complete).** Replace prototype surfaces/form with a Gorgon-floor
   authored exterior and interior while preserving the exact semantic contract. Add threshold,
   interior ceiling/roof collision, windows that do not admit the capsule, baked PBR maps, lightmap
   policy, and guarded DGX Spark capture for explicit human review.
3. **FB-3 — occupancy and interaction (complete).** Deterministic occupied-close rule (block and remain open),
   player interaction affordance, door sounds, optional lock/key state, nav portal state, and AI path
   invalidation. Keep the first door kinematic; add revolute joints only for intentionally pushable
   doors.
4. **FB-4 — multi-room semantics (complete).** Multiple rooms/portals, stairs and upper floors, room-aware audio,
   visibility/streaming cells, interior spawn anchors, and traversal tests across every portal.
5. **FB-5 — generated settlements (R1 mechanically released).** Contract-aware building library, variants/LODs that preserve
   semantic identities, Atlas placement, terrain foundations, road/door alignment, furnishing sockets,
   and bounded settlement streaming. Only contract-passing assets enter the catalog.

FB-5 publication authority and the first exact settlement release are closed by the approved FB-4 review
ledger. A normal `CoreSkills` host now loads and brands the exact release itself, samples only resident
engine-owned terrain, drives bounded whole-building residency, and dynamically enrolls release identity,
budgets, interest, byte accounting, and ownership in snapshot/replay. The strict catalog
binds exact v2 asset bytes, complete contract hashes, semantic fingerprints, exterior portal inventories,
variant identity, static LOD roots, the isolated articulated-door root, and optional exact composition and
production closures; inert props cannot masquerade as enterable buildings. A strict settlement plan binds
one exact catalog revision, deterministic placements, full Atlas transforms, exterior-entry connectors,
site/foundation references, and whole-building residency units; furnishing arrangements live in their
separately branded dormant sidecar. Atlas resolution retains
authored anchor yaw and stable route IDs/geometry and measures each transformed entry contact against its
route. Canonical site artifacts reproduce arbitrary-yaw terrain grade, foundation bearing, entrance support,
and route elevation from live resident terrain before mutation. The bounded residency manager treats every
building and its complete visibility-cell inventory as one transactional load/unload unit. Runtime placement
and settlement lifecycle are mechanically closed through `building.placeFunctional`; an independently
reverified approved publication is exercised end-to-end through exact Atlas transform, live-site
reproduction, topology ownership, bounded whole-building residency, rollback, and atomic unload. The dormant
furnishing adapter attaches only logical socket recipes and is prohibited from creating render or collision
state. No authority in this path permits
legacy `asset.place` to publish a functional building.

The first FB-5 boundary is `js/src/assets/functional-building-publication.mjs`. It does not trust a
mechanically valid caller-authored catalog: it re-reads the immutable candidate manifest and its
manifest-pinned semantic LOD GLB, verifies the complete append-only FB-4 review ledger, requires the
resolved latest state to be an exact HITL `approved` decision, then derives the single catalog entry and
retains that exact ledger outcome as its production closure. The in-process result is branded; a
deserialized lookalike or substituted catalog fails before Atlas/site/runtime work. Persisted publication
bytes restore that brand only by independently replaying the exact manifest/ledger/LOD derivation. The
terminal release boundary is `js/src/assets/functional-settlement-release.mjs`: it independently closes the
publication, recipe, WorldMap, plan, every site/foundation artifact, exact terrain authority, Atlas road
contact, inventory, and residency budgets. `FunctionalSettlementReleaseHost` and
`createReleasedFunctionalSettlementRuntimeResidency` are the production paths; the publication-only and
mechanical constructors remain lower-level test adapters and cannot substitute caller-authored plans into a
released settlement. Editable terrain overrides its generated substrate, while uncovered, non-finite, or
same-tier ambiguous terrain fails before mutation. Session close unloads every whole building and unregisters
its exact dynamic snapshot participant.

The distributed runtime closure is pinned as well: `bundle:player` writes both the canonical scaffold
player and the site example from current engine sources, and the aggregate host gate rejects either copy
when it differs from a fresh lock-pinned esbuild output. The tree runtime has an explicit hash-less-host
sentinel regression while retaining real-hash mismatch rejection; durable replay behaviorally proves the
bounded first-divergence record window. These coordinated seams must remain green before FB-5 release.

The approved candidate is published as
`assets/buildings/catalog/functional-hall-house-fb4-v3-r1.json` (raw SHA-256
`8f9b6816a23639bc4dd3941b574ec422c53715ec00051788d2e291c249c956b0`). Reproduce its append-only catalog
authority by supplying the candidate and every ledger record in the chain (central pass first, HITL approval
last) plus explicit catalog identities:

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

The command is CPU-only and append-only (`wx`): pending, rejected, incomplete, drifted, or unrelated review
authority writes nothing. The R1 settlement is likewise an append-only CPU artifact:

```sh
bun tools/architecture/build-fb5-functional-settlement.ts \
  --recipe assets/buildings/authoring/functional-hall-house-v4/fb5-functional-hall-settlement-r1-recipe.json \
  --out-root assets/settlements/functional-hall-r1
```

Its release record is `assets/settlements/functional-hall-r1/release.json` (raw SHA-256
`6af4b3cf25a38a79af60d9516ed7b7eb1808ea7fa5277e12bb586a71f379c636`; closure
`sha256:e6cb4277226c55b8ae66d70f4768ea06bc3eba22d3bcb3e16fc23a424fa8220a`). It places three complete
six-cell buildings at large coordinates and arbitrary yaw, derives exact road/door contacts and live-grade
foundations, and caps residency at two buildings / 44,317,376 bytes. No new settlement pixels were rendered,
so the FB-4 house approval does not transfer to a future settlement capture; any such capture remains a new
artifact requiring guarded engine rendering and explicit HITL. The normal host now proves live resident
terrain, bounded streaming, snapshot restore, identical continuation, and atomic teardown without a test-only
skill rebind.

R1 also publishes a CPU-reproducible dormant furnishing authority at
`assets/settlements/functional-hall-r1/furnishing-authority-r1.json`. It binds four previously approved
functional furniture assets, seven room-contained sockets, and three deterministic arrangement variants to
the exact release. Dormant means exactly that: it creates zero meshes, colliders, or ECS entities, so players
cannot hit invisible furniture and the approved house pixels remain unchanged. Visible/physical activation
requires a new `visual=true` authority, an engine-pipeline capture, and fresh HITL. These are furnishing
arrangement variants, not plural building variants. R1 deliberately ships one exact approved building variant
with three semantic-preserving LODs; the next distinct building GLB is new rendered content and must receive
its own guarded review rather than borrowing this approval.

Cross-cutting gates remain exact content closure, worker parity, replay/snapshot durability,
transactional rollback, lifecycle cleanup, arbitrary-yaw/large-coordinate parity, and explicit human
review for every new rendered artifact.

## FB-4 additive multi-room authority

`limina.functional-building/v1` remains the exact authority for R1 and all legacy one-room assets.
Its plural ID lists are inventories, not an adjacency graph, and must never be presented as multi-room
support. FB-4 uses the additive `limina.functional-building/v2` authority. A v2 building must carry:

- bounded rooms with exact finished-floor/ceiling elevations, storeys, acoustic properties, and one
  visibility-cell owner;
- door or passage portals with two explicit room/exterior endpoints, apertures, and acoustic
  transmission; articulated doors and door portals bind bidirectionally;
- bounded cardinal stair links whose endpoints meet the two finished floors and whose width, headroom,
  rise, run, riser count, tread depth, landings, and explicit upper-floor opening form a usable
  construction; the compiler partitions both rendered floor and collision around that opening;
- contained typed spawn anchors with horizontal facing and capsule/item clearance; and
- bounded visibility cells whose semantic render nodes have one owner.

The pure-byte parser rejects disconnected rooms, orphan endpoints, decorative stair labels, unsafe
spawn clearances, duplicate ownership, and topology with no exterior root before placement mutates the
world. Runtime navigation is a layered room graph: the flat XZ nav grid remains a local movement layer
and is not allowed to impersonate upper-floor connectivity. Portal state drives room reachability,
acoustic propagation, visibility residency, and path invalidation atomically. The architecture compiler
must emit the same immutable v2 graph; it may not infer room adjacency later from meshes.

FB-4 CPU closure requires exhaustive traversal of every portal and stair in both directions, stacked-floor
room queries, arbitrary-yaw and large-coordinate transforms, deterministic replay/snapshot reconciliation,
transactional rollback, and leak-free teardown. A real multi-room review building is new rendered content:
after mechanical closure it must be captured through the guarded engine pipeline and stopped at a fresh
exact HITL gate. R1 approval does not transfer.

The CPU closure passed on 2026-07-16. The architecture compiler emits bounded storey shells and partitions, twenty
visible stair/landing solids, thin top-aligned traversal colliders, and a four-piece upper floor around a
capsule-swept opening. The program-first replacement uses one structural shell per storey plus four explicit
shared-room partitions; exact room coverage and portal apertures are compiler gates, so adjacent rooms no
longer create coincident walls, floors, or ceilings. A real Blender 4.0.2 round trip preserves the strict v2
authority, the sole semantic root, every stair/landing, three articulated doors, and the prohibited-full-slab
absence while producing an editable `.blend` and bound handoff. The first program-derived artifact,
`fb4-multi-room-candidate-d0ca1e327841`, closes both compiler-owned gable ends, fulfills all eight
program-required windows, and derives 150 aperture-clear, connected, perceptual-only exterior frame members
from final shell authority. Its manifest binds the full production and material-source closure so
synthesis, compiler, adapter, validation, material, or LOD changes cannot silently reuse a candidate identity.
Its guarded eight-view diagnostic was rejected centrally before HITL for invalid vegetation/camera evidence
and insufficient architectural articulation. Candidate discovery now resolves that exact rejection through an
append-only hash-chained review ledger; the immutable build-time `human-pending` field is not treated as current
review truth. Future captures require a V3 site-review envelope and complete capture producer/runtime provenance.

The additive successor `fb4-multi-room-candidate-1b4470041e01` uses `BuildingProgramV2` and
the V2 typology rulebook to preserve all occupied upper-storey windows while adding a separate attic dormer,
a compiler-owned supported/flashed entry canopy, and an exact fireplace-centerline chimney penetration. It
passes the same compiler, Blender, strict functional-contract, LOD, bidirectional traversal, arbitrary-yaw,
large-coordinate, replay, snapshot, and teardown gates. Its immutable build manifest remains truthfully
CPU-verified and human-pending, while its append-only review ledger resolves the current state as
`rejected-before-hitl`. A separate
production-GLB raycast proxy must prove only mechanical multi-view articulation; a separate V3 site authority
must prove terrain/camera/population safety; guarded engine images and a new exact human decision remain the
only visual release gate. Its predecessor `a38d89999682` remains immutable regression evidence: the CPU
raycast rejected its short chimney, and the successor records the corrected ridge projection in a new
rulebook hash and build closure instead of weakening the visual-legibility thresholds. Neither later evidence
layer mutates the immutable candidate manifest. The central rejection is architectural: its one-box massing,
blank gable, repetitive facade grid, foundation/grade treatment, and canopy construction remain below the
approved R1 floor. It is regression evidence, not the current visual candidate, and every authority under it
is retired from further GPU capture.
The native default capsule then
traverses the closed/open exterior door, internal passage, complete stair, and upper-floor opening in both
directions at large world coordinates and arbitrary yaw. The additive rendered V4 R1 review artifact received
its own exact owner approval; no earlier approval was transferred. Its approval is scoped to those eight bound
engine captures and does not approve later renders.

The earlier `fb4-multi-room-candidate-46c1e971f0f2` remains append-only audit evidence but is superseded: it
used explicit roof planes without gable closure authority and emitted only the four upper windows while the
program required eight. It must not be rendered, promoted, or used as the visual-frame base.

## FB-2 R1 regression authority

`art-direction/functional-hall-house-v4-r1-closure.json` is the canonical closeout pointer. It binds
the corrected approved-v6 production package, reviewed candidate, user decision, v5 camera authority,
guarded five-view Spark capture, and unchanged production GLB by exact SHA-256. The permanent verifier
is `tools/architecture/production-r1-final-closure.test.mjs`.

This exact R1 package is the FB-3 fixture. Behavior-only work may reuse it without another render;
any change to rendered content or review evidence creates a new append-only candidate and requires
fresh human approval. The superseded approved-v5 promotion record remains audit evidence only.

## Native functional review set

The guarded DGX Spark review is one engine run over one functional placement in the approved
temperate production environment. It emits five exact, independently hashed PNG artifacts:
`exterior-closed` (`articulation-before`), `exterior-open` (`primary`), `threshold-detail`,
`interior-open` (`interior-traversal`), and `lod-25m` (`lod-proof`). The first two share the 18 metre
hero camera and differ only by authoritative `door.setOpen`; the detail and interior cameras prove
the hinge, portal, threshold, and traversal sightline; the final camera explicitly selects LOD1 at
25 metres. Every state is followed by the normal ECS-to-render projection before capture.

```sh
node tools/preview/run-native-functional-cottage-capture.mjs
```

The runner delegates to the shared boot-bound native-capture Xid guard for preflight, live follower,
redundant bounded polling, process teardown, and postflight; it removes timestamp-risk environment
variables, validates the complete labeled set and per-frame telemetry, and writes internal QC files
only. It never stages or presents them. The exterior-open image retains the canonical internal candidate
filename; companion filenames carry their evidence-view ID. A missing state, mismatched hash, Xid,
or incomplete teardown fails the entire review run.

Central inspection must first establish that every frame meets the locked Project Gorgon floor. Only
then may an operator deliberately stage an exact approved file with the separate command documented
in `plans/handoffs/dgx-spark-visual-review-bridge.md`. The v4 production asset is selected only for
internal engine review and must not be staged, presented, or marked approved before that review.

## Visual-cue iteration authority

`art-direction/functional-cottage-v4-iteration.json` is the machine-readable design loop. It records
the locked reference cues without redistributing reference images, the complete generation prompt and
constraints, construction responses, exact raw/engine artifact hashes for every cycle, view-scoped
critique, decisions, and status. Start a new iteration by copying that briefing document; append a
cycle instead of overwriting history. A cycle is selectable only after both hashes are known.

Optional project-bound concept references carry a project-relative source path, exact raw SHA-256,
and the fixed role `modeling-cue-only`. Generated references additionally record the exact prompt,
tool identity, and an honest `not-exposed` model version when the generator does not report one. The
source image hash is re-read and verified before selection; concept pixels and prompts are provenance
and modeling cues, never acceptance evidence.

Set the manifest to `engine-review` and set `selectedCycle` only when its artifact is ready for the
internal production-engine evidence set. The capture authority pins the iteration manifest hash, and
both the native demo and guarded runner require the selected cycle's asset ID and hashes to match the
capture asset exactly. A briefing, rejected cycle, stale prompt manifest, or hash mismatch fails before
GPU work. `approved` remains reserved for explicit human approval of production-engine images.

```sh
LIMINA_ASSET_ROOT=. ./target/release/limina js/test/p_functional_building_iteration.ts
node --test tools/preview/native-functional-cottage-capture-static.test.mjs
```

## KTX2 runtime and authoring boundary

KTX2 consumption is an engine package dependency pinned to Three `0.184.0`. `npm install` and
`bundle:three` copy that package's exact `basis_transcoder.js` and `basis_transcoder.wasm` into the
web, editor, and scaffold runtime roots. `GltfSceneCache` is renderer-bound before prewarm, owns and
disposes its `KTX2Loader`, and rejects `KHR_texture_basisu` assets when no project transcoder was
configured. No global Basis/KTX installation participates in runtime loading.

Producing new KTX2 files requires Khronos `toktx`. The engine package installs the pinned authoring
binary inside `js/.tools/` during `npm install` on its pinned Linux ARM64 and x64 targets; checksum,
version, and executable verification fail the install closed. `npm run deps:ktx` is the explicit,
idempotent repair command. Runtime startup and acceptance capture never consult a global KTX install.
Existing production KTX2 assets are consumed through the Basis runtime shipped with the engine.
