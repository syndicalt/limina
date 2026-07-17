# Staged Building Content Pipeline

Status: **approved and implemented through the R1 proof.** The exact production cottage completed the
staged dependency graph, guarded native-WebGPU review, and human release gate on 2026-07-16.

## Outcome

Build functional, high-fidelity buildings without making one generator simultaneously solve architecture,
furniture, interior composition, materials, runtime effects, and final presentation. Each discipline emits a
versioned artifact, passes local mechanical and engine-rendered checks, and reaches an explicit human gate
before downstream work can depend on it.

The runtime deliverable remains a GLB. The editable authoring deliverable is a Blender file plus its Limina
recipe and provenance. A GLB may be imported for inspection or emergency edits, but it is not the canonical
source because export commonly bakes modifiers, loses authoring organization, and makes semantic round trips
fragile.

## Non-negotiable principles

1. All visual acceptance uses Limina's production engine pipeline. Blender viewport and offline renders are
   diagnostics, never approval evidence.
2. Architecture, interior planning, furniture, materials, and VFX are separate dependency nodes. A failed
   chair does not rebuild a roof.
3. Every generated object is editable. Preserve a structured `.blend`, declarative source recipe, imported
   source references, generated GLB, and exact hashes.
4. Mechanical gates run before pixels. Human review evaluates judgment that mechanical tests cannot prove.
5. No model may self-approve its own visual output. Automated critique may recommend; a human selects,
   rejects, or requests revision for every hero asset and every new integrated Spark artifact.
6. Each revision is append-only evidence. Never overwrite the history that explains a rejection.
7. NVIDIA Xid, stale provenance, missing semantic identities, or bypassed engine capture invalidates the
   review immediately.

## Artifact graph

```text
brief + visual cues
        |
        v
architectural recipe ----> shell.blend ----> shell.glb
        |                       |                 |
        |                       |                 +--> shell engine evidence
        |                       +--> editable handoff
        v
interior plan (zones, sockets, clearances)
        |                 \
        |                  +--> furniture/prop assets: recipe + .blend + .glb + evidence
        |                  +--> fixture assets: recipe + .blend + .glb + evidence
        |                  +--> fire/VFX package: runtime definition + assets + evidence
        v
composition manifest ----> integrated authoring.blend ----> production GLB/LODs/KTX2
                                                        |
                                                        v
                                             guarded engine review set
                                                        |
                                                        v
                                                explicit HITL decision
```

The composition manifest references content hashes. Changing a dependency invalidates only its dependent
evidence. For example, changing roof pitch invalidates roof, exterior, collision, LOD, and integrated views;
it does not invalidate an isolated table asset. Changing a table material invalidates that table's material
evidence and integrated interior evidence, but not the architectural shell.

## Phase 0 — Brief and visual contract

Inputs:

- prompt and intended use;
- regular or hero quality profile;
- locked visual cues and `avoid` cues;
- target scale, biome, period, construction logic, occupancy, and interactions;
- target hardware and performance budgets.

Outputs:

- versioned brief;
- measurable requirements and visual thesis;
- required evidence views;
- initial dependency graph and budget allocation.

### Program-first design synthesis

Before exact coordinates exist, the prompt is translated into a strict `BuildingProgram` containing room
intent, adjacency, storeys, circulation, daylight, site relationship, construction intent, and budgets.
A versioned deterministic rulebook enumerates a bounded candidate set and emits generated
`ArchitectureSpec` documents. The compiler rejects candidates that violate bearing, openings, stair/void
headroom, required per-space daylight, closed gable authority, roof, or functional traversal requirements.
For the first timber-hall typology, a semantic `perceptualTimberFrames` policy lets the compiler derive exact
members from final exterior walls, apertures, and gable closures. It is non-colliding and perceptual-only;
coordinate-authored `interiorStructure` is not reused as exterior construction authority.

Authority is one-way: `BuildingProgram` owns semantic intent, the selected generated `ArchitectureSpec`
owns exact construction, and the synthesis manifest only binds their hashes, rulebook revision, score,
and rejection evidence. Manual edits create an explicit fork and may not retain synthesized provenance.

Reference lookup is optional and targeted to unfamiliar construction details, historical vocabulary, or
style calibration. A small cited board may inform soft visual goals, but it does not authorize spatial
geometry. Downloaded examples are reference-only unless a separate licensed asset-import contract accepts
them. No provider, credential, model download, or network access is required by the engine, compiler,
package installation, or runtime.

HITL Gate B0 — Program and candidate lock:

- Human sees the prompt, semantic program, scored valid massing candidates, intended function, dimensions,
  optional visual cues, and required evidence list.
- Decisions: `select-candidate`, `revise-program`, or `cancel`.
- Approval authorizes generation, not visual acceptance.

Review-state and strategy migration are additive. Immutable candidate manifests describe build-time facts;
an append-only hash-chained ledger binds later central-review and existing building-HITL decision records.
The ledger does not introduce another approval format. A capture without complete producer provenance may
retain a rejection for audit purposes but is ineligible for staging or HITL. Every new FB-4 capture also requires
a V3 site-review envelope proving canopy-aware population clearance, camera terrain line of sight, interior
containment, and projected subject coverage before GPU creation.

## Phase 1 — Architectural shell

Owned here:

- datum, terrain interface, foundations, volumes, rooms, walls, floors, ceilings;
- openings, reveals, doors, windows, hinges, thresholds;
- roof planes, ridges, valleys, dormers, eaves, fascia, flashing, penetrations;
- stairs derived from finished-floor-to-grade rise;
- chimney, firebox, flue, mantel structure, and VFX attachment anchors;
- collision, traversal, navigation portals, LOD-critical silhouette, and semantic IDs.

Explicitly not owned here:

- finished furniture and loose props;
- interior composition;
- animated flames, embers, smoke, or fire lighting behavior;
- decorative clutter chosen only to make a final frame look populated.

Mechanical gates:

- closed supported volumes and wall rings;
- openings genuinely subtract structure;
- roof-plane closure and explicit joint relationships;
- exactly closed compiler-owned gable ends before gable framing;
- required per-space exterior-window counts and allowed-facade ownership;
- perceptual frame aperture clearance, connected member graph, explicit exterior material role, and required
  LOD survival without a structural/load-path claim;
- dormer minimum eave/overhang, fascia continuity, wall clearance, and flashing boundaries;
- stairs use uniform bounded risers/treads, meet the threshold, and terminate at sampled grade;
- door sweep, threshold continuity, capsule traversal, collision decomposition;
- chimney/flue continuity and roof penetration clearance;
- semantic identity, deterministic rebuild, source coverage, and LOD preservation.

Engine evidence:

- massing turntable;
- roof-junction close views;
- dormer/eave close views;
- entrance and bottom-step/grade close view;
- closed/open door pair;
- empty-shell interior traversal;
- 25 m LOD silhouette.

HITL Gate A1 — Shell approval:

- Human reviews construction plausibility, proportions, silhouette, joints, entrance, and traversal.
- Approval pins the shell hash. `revise` must identify a view and architectural facet.
- No furnishing or VFX work begins until this gate passes.

## Phase 2 — Material system

Materials are acquired or authored independently and normalized into Limina material packs. Poly Haven is the
preferred CC0 source where suitable. Every source records URL/API identity, download hash, license, map role,
resolution, color space, and conversion operations.

Gates:

- complete albedo/normal/roughness or ORM roles;
- conventional tangent-space normals;
- physical texel-density bands by role;
- UV orientation and continuity;
- no texture stretch, cross-role aliasing, or unsupported runtime extensions;
- KTX2 mip and residency budgets.

Engine evidence uses material spheres/planes and representative shell crops. Blender material preview is
diagnostic only.

HITL Gate M1 — Palette lock chooses approved material packs and role assignments. Later substitution
invalidates affected object and integrated material evidence.

## Phase 3 — Interior planning

This phase places no finished furniture mesh. It authors a semantic plan:

- activity zones such as entry, dining, hearth, storage, sleeping, and circulation;
- access points and navigable links;
- furniture footprints, facing targets, usable clearances, and scale envelopes;
- wall/floor/ceiling sockets;
- prop support sockets;
- lighting and VFX anchors;
- camera sightline and occlusion constraints.

Mechanical gates prove that every zone is reachable, doors remain usable, hearth clearances are respected,
furniture envelopes do not overlap, storage has standing room, and required activities fit at human scale.

Engine evidence renders colored proxy volumes through Limina, clearly labeled as planning diagnostics and
never as visual candidates.

HITL Gate I1 — Layout approval lets the human move, rotate, remove, or request assets before expensive asset
generation. The review UI should offer top-down and walk-through views without requiring Blender knowledge.

## Phase 4 — Furniture, fixtures, and props

Each visible archetype is its own asset job. It has a typed construction recipe, explicit join graph, local
coordinate frame, support surface, interaction anchors, collision policy, editable Blender file, runtime GLB,
and evidence manifest.

Required gates:

- intended joints, not merely overlapping AABBs;
- bounded contact area and penetration for every joint;
- feet contact the floor and the support polygon contains the center of mass;
- recognizable silhouette at intended distance;
- correct real-world dimensions and material grain direction;
- front, side, rear, and three-quarter engine views;
- close material/detail view;
- interaction proof for doors, drawers, seats, or containers where applicable;
- LOD and runtime budgets.

HITL Gate F1 — Asset approval occurs in an isolated engine gallery. A rejected chair returns only to its own
job. Only approved exact hashes may enter the interior catalog.

## Phase 5 — Fire and other runtime VFX

The shell provides a firebox, flue, hearth clearances, fuel/ember/light sockets, and occlusion volume. The VFX
package owns:

- irregular charred fuel and coal geometry;
- animated layered flame meshes/cards with inner and outer regions;
- temporal deformation and bounded flicker;
- ember variation;
- localized fire light and reflected color;
- soot/heat treatment, smoke, particles, and heat distortion when supported;
- start, burn, extinguish, save/replay, teardown, and performance behavior.

A static emissive cone or uniformly glowing box cannot satisfy the contract.

Gates include runtime animation over multiple sampled frames, flame silhouette variation, per-channel
exposure, light-energy bounds, containment, deterministic authoritative state, lifecycle cleanup, and GPU/CPU
budgets. Visual evidence is an engine-rendered short sequence plus stills, not a single fortunate frame.

HITL Gate V1 — Human reviews motion, fuel, flame shape, reflected light, and exposure. Approval pins both the
VFX package and its runtime parameters.

## Phase 6 — Furnishing and integrated composition

The composition step instantiates approved catalog hashes into approved interior-plan sockets. It may choose
variants and make bounded placement adjustments; it may not regenerate furniture inside the building job.

Gates:

- exact approved dependency hashes;
- zone membership, facing target, support, clearance, and circulation;
- no camera-driven geometry cheating;
- coherent material hierarchy and controlled repetition;
- all interactions remain functional;
- no dependency silently converted to baked anonymous meshes.

HITL Gate C1 — Interior composition review uses engine walk-throughs and targeted room views. The human may
move/remove/substitute catalog assets and save those edits as a new composition-manifest revision.

## Phase 7 — Production packaging and final review

Packaging emits the production GLB, semantic LODs, KTX2 textures, collision/interaction contracts, provenance,
and review authority. CPU gates close before a guarded GPU run.

Final engine evidence includes exterior closed/open states, every important roof/entrance junction, room
walk-throughs, interaction demonstrations, VFX sequence, material crops, and distance/LOD views. The precise
set is derived from the brief rather than fixed globally.

HITL Gate R1 — Release decision:

- `approve-exact-artifact`: pins hashes and permits catalog/release staging;
- `revise(facet, view, instruction)`: creates a downstream invalidation set and new revision;
- `reject(reason)`: closes the candidate without deleting evidence.

There is no `approve-with-notes` state. A note is either non-blocking backlog or a blocking revision.
Every decision records reviewer, timestamp, exact input/evidence hashes, marked image regions, blocking
findings, non-blocking observations, and any accepted deviation from the brief.

Laptop approval never transfers to a new Spark artifact. Automated scores never replace this gate.

### R1 closure — 2026-07-16

The first complete proof is fixed by `art-direction/functional-hall-house-v4-r1-closure.json`. Its
approved-v6 production package retains the exact production GLB content hash while binding the reviewed
candidate, v5 authority, guarded five-view NVIDIA GB10 capture, and user approval decision. The permanent
CPU closure verifier is `tools/architecture/production-r1-final-closure.test.mjs`.

The record produced during the first generic promotion attempt is preserved but superseded because its
nested review fields still said `candidate`/`pending`. Only approved-v6 is canonical. New rendered content
must produce append-only evidence and return to R1; behavior-only FB-3 work uses this package unchanged.

## Editable Blender handoff

Every authoring job exports an `authoring/` package:

```text
<asset-id>/
  brief.json
  recipe.json
  source.blend
  materials.lock.json
  composition.json          # integrated buildings only
  README-editing.md
  preview-reference/        # diagnostic thumbnails, not approval evidence
  export-manifest.json
```

`source.blend` requirements:

- named collections: `00_READ_ME`, protected `10_GENERATED_STRUCTURE`, editable `20_ARTIST_SURFACES`,
  `30_INTERIOR_DRESSING`, protected `40_ARTICULATION`, diagnostic `COLLISION`/`SOCKETS`/`VFX_ANCHORS`,
  and hidden `90_EXPORT`;
- meaningful object names plus immutable custom properties: `limina.id`, `limina.role`,
  `limina.derivedFrom`, `limina.owner`, and `limina.editPolicy`; object names alone are not identity;
- transforms applied only where the contract requires it;
- door and other articulation pivots preserved;
- editable modifiers retained where safe, with export duplicates generated non-destructively;
- materials named by Limina role and linked to locked source packs;
- collision and socket helpers visible in a dedicated overlay but excluded from beauty geometry;
- a `Limina` workspace with Validate, Engine Preview, and Export actions.

### Beginner workflow

A user should not need to understand Blender's full interface for common adjustments:

1. Open `source.blend`; it starts in the Limina workspace.
2. Pick an object from a plain-language list such as `Front Steps`, `Dormer Roof`, or `Hearth Settle`.
3. Use constrained controls for allowed edits: position, dimensions, roof pitch/overhang, material choice,
   furnishing substitution, and approved modifier parameters.
4. Press **Validate**. Errors identify the object and violated architectural or semantic rule.
5. Press **Engine Preview**. Limina rebuilds a private preview and opens the relevant engine evidence views.
6. Press **Submit Revision**. The tool writes a new recipe/composition revision and provenance; it never
   silently replaces an approved artifact.

Direct Edit Mode remains available for experienced Blender users. It marks manually changed objects dirty and
requires semantic, topology, collision, material, and export validation before a new GLB can enter Limina.
The UI labels edits green (safe presentation controls), yellow (requires full validation), or red/protected
(architecture, pivots, portals, collision, semantic properties, and export roots must return to their owner).

### Round-trip policy

- Recipe-driven parameters round-trip from Blender through explicit custom properties into a new recipe
  revision.
- Free mesh edits cannot always be converted back into architectural parameters. They become a versioned
  `authored-mesh` dependency with stable sockets and provenance.
- Importing an existing GLB is supported as `inspect` or `adopt`. `Adopt` must reconstruct semantic IDs,
  pivots, materials, collision, and sockets before export; it cannot overwrite the canonical source blindly.
- Re-export always runs through the Limina adapter and engine package. A generic Blender GLB export is not a
  release artifact.

## HITL review surface

The review UI presents:

- phase, candidate hash, parent revision, and invalidated downstream evidence;
- prompt/cues beside engine evidence;
- synchronized views with filenames, dimensions, timestamps, and hashes;
- mechanical gate results with actionable object-level diagnostics;
- annotations pinned to view coordinates and semantic object IDs;
- approve, revise, reject, compare, and revert-to-prior-recipe actions;
- a revision graph rather than a single mutable “current” result.

Review packets contain no credentials, traces, repository files, or unpublished source assets. The DGX bridge
continues to bind only the private artifact directory to `127.0.0.1` and is reached through SSH forwarding.

## Agent responsibilities

- Orchestrator/Codex: owns dependency graph, central inspection, provenance, gates, and integration decisions.
- Architecture specialist: recipe, joints, shell, stairs, roofs, openings, collision, traversal.
- Interior specialist: zones, circulation, sockets, composition, human scale.
- Asset specialist/Fable: furniture and prop candidates within typed archetypes; never self-approves.
- Visual critic/Opus: structured critique against cues and prior evidence; no authority to release.
- Materials specialist: Poly Haven acquisition, normalization, UV/texel policy, KTX2 closure.
- Runtime/VFX specialist: animated fire/effects, lifecycle, exposure, performance.
- Human owner: locks briefs and palettes, approves layouts/assets/VFX, and exclusively approves release pixels.

All delegated results are centrally inspected. Agent disagreement is preserved as review evidence, not resolved
by majority vote.

## Implementation milestones

1. Freeze the current cottage as rejected diagnostic evidence; do not create Cycle 14.
2. Define artifact schemas and dependency/invalidation graph.
3. Add `.blend` authoring-package output and stable semantic custom properties.
4. Add the beginner Limina Blender workspace and validate/preview/export bridge.
5. Split architectural shell generation from composition and catalog references.
6. Build shell-only gates for dormer overhang and grade-derived entrance stairs.
7. Build isolated furniture jobs and multi-view engine gallery; prove one table, one chair, one backed settle.
8. Build the runtime fire/VFX contract and animated engine evidence sequence.
9. Build interior proxy planning and composition-manifest editing.
10. Integrate approved dependencies into a new cottage revision.
11. Run full CPU/package verification, then guarded Spark evidence.
12. Require explicit exact-artifact human approval before release.

## Exit criteria for the pipeline proof

- A non-Blender expert can open the authoring package, change a bounded parameter or replace a furnishing,
  validate it, and obtain a private engine preview without using the command line.
- An expert can make freeform Blender edits without losing semantic identity or bypassing gates.
- Shell, furniture, VFX, and composition can each revise without rebuilding unrelated approved artifacts.
- The dormer, stairs, doorway, furniture, fire, materials, collision, interactions, LODs, and lifecycle pass
  their local gates and integrated production-engine evidence.
- The final cottage meets the locked Project Gorgon visual floor and is explicitly approved by the human owner.
