# Architecture Program Synthesis

Status: active functional-building goal slice. The first program-derived candidate passed CPU construction,
packaging, and traversal, was captured privately through the guarded engine path, and was rejected centrally
before HITL. It remains useful regression evidence but is not the current visual candidate.

## Authority chain

```text
prompt
  -> BuildingProgram                 semantic intent; no coordinates
  -> deterministic typology rulebook
  -> synthesis manifest             provenance and score; never edited as design input
  -> generated ArchitectureSpec     sole exact geometric authority
  -> existing compiler / Blender / functional-building v2
  -> engine diagnostic evidence
  -> exact HITL selection and release
```

There is no reverse inference. GLB, Blend, compiler IR, or a manually edited `ArchitectureSpec` may not
silently update the program or retain synthesized provenance. A manual change creates a named fork with a
new manifest and review history.

## Bounded first typology

`timber-hall-house/v1` covers a two-storey rectangular hall, one exterior
entry, one ground-to-upper straight stair, and occupied upper rooms. The program owns:

- room use, target area, occupancy, storey, and adjacency;
- exterior entry intent and grade relationship;
- wall-adjacent circulation, width, headroom, landings, and required daylight for every occupied space;
- footprint, height, wall/floor thickness, gable-roof ranges, site clearance, and LOD budgets;
- timber-hall visual intent and the locked visual-floor identity.

It does not contain XYZ coordinates, opening offsets, volume or primitive IDs, roof-intersection points,
materials, furniture, or free-form geometry instructions. `perceptualTimberFrames` is a semantic expression
policy on the generated `ArchitectureSpec`: the compiler derives exact exterior members from final exterior
walls, openings, and compiler-owned gable closures, rejects aperture intrusion and disconnected member
networks, assigns explicit material/LOD ownership, and emits no colliders. This remains perceptual-only. A
later schema must add structural posts, sills, joints, bearing, and load-path proof before any structural
timber-frame verification claim.

The geometric authority is deliberately not one structural volume per room. One volume owns each storey
shell; `interiorPartitions` own every exact shared room boundary, and functional room bounds form a
non-overlapping exact partition of their shell. The compiler rejects missing/extra partitions, duplicate or
gapped room coverage, portal/aperture drift, and coincident wall solids. This boundary prevents the earlier
overlapping-wall/floor/ceiling failure mode from becoming synthesis debt.

`timber-hall-house/v2` is an additive rulebook and manifest path. It preserves the occupied upper-storey
windows produced by V1 and adds exactly three compiler-owned silhouette elements: a south roof dormer, a
supported/flashed primary-entry canopy, and a fireplace-centerline chimney penetration on the opposite roof
plane with curb, flashing, counterflashing, cricket, cap, and liner. The dormer is explicitly attic
articulation. The current two-storey shell has a solid upper ceiling, so treating that dormer window as
bedroom daylight would be a false claim; a future occupied roof-storey contract must add knee-wall/sloped-
ceiling room authority before making that semantic change.

Reference search remains optional authoring evidence. Selected sources are reduced to source-neutral,
measurable cues before they affect a program or rulebook; URLs, images, pixel coordinates, catalog models,
and `reference-first-modeling/v1` never become compiler inputs. CPU proxy views measure the resulting
silhouette and junctions rather than pixel similarity. The synthesis manifest records those views as later
evidence requirements, not as completed evidence.

The current V2 authority files are append-only inputs:

- `assets/buildings/programs/functional-hall-house-fb4-program-v2.json` — coordinate-free program;
- `art-direction/functional-hall-house-v4-v2-visual-design.json` — pinned source provenance and cues;
- `assets/buildings/programs/functional-hall-house-fb4-cue-profile-v2.json` — source-neutral exact mapping
  from every architecture cue to one program/rulebook/compiler owner.

The production builder validates and hash-binds all three, then invokes the real compiler, staged Blender
adapter, GLB validation, LOD packaging, and functional contract path:

```sh
bun tools/architecture/build-fb4-multi-room-candidate.ts
```

That command is CPU authoring only (`gpuCaptureAtBuild: false`, `cpuProxyEvidenceAtBuild: false`). It may
create a new append-only human-pending candidate, never approval or capture evidence.

## Candidate search and proof

The versioned rulebook enumerates a small stable domain: service-bay side, stair wall and direction, entry
bay, upper window pattern, and permitted roof choices. It uses fixed ordering and quantized dimensions; no
ambient randomness or external solver participates. Each candidate is either rejected with a machine-readable
reason or compiled through the existing architecture compiler.

Ranking uses a lexicographic score rather than opaque floating weights:

1. hard violations;
2. room-area deviation;
3. circulation length and dead space;
4. unsupported area;
5. roof-junction count;
6. daylight deficit;
7. facade asymmetry;
8. visual-floor deviation;
9. canonical decision-vector hash as the final tie-break.

The synthesis set binds the exact program hash, rulebook revision, ordered decisions and scores, rejected
diagnostics hash, generated spec hashes, and compiled IR hashes. Only the top three distinct valid candidates
advance to engine-rendered massing review.

## Strategy-migration debt rules

- Existing R1 and FB-4 candidates remain immutable historical/replay evidence.
- Generic architect-daemon, architect-run, `asset.request`, and `catalog.publish` authoring is prop-only.
  Enterable dwelling/civic/military/religious work must enter through `BuildingProgram`; seed catalog
  buildings remain readable historical/scenery metadata but cannot create a second production lane.
- No production tool may import `js/test` or the legacy coordinate-mutation fixture.
- The legacy fixture remains only as an explicit compiler regression; it is not a generation API.
- `reference-first-modeling/v1` remains an isolated experimental compatibility artifact and is not exported
  by the architecture package.
- Reference-provider tools remain optional authoring utilities with no engine, compiler, package, credential,
  or runtime dependency.
- `visual-design-contract/v1`, existing stage hashes, and exact HITL decisions remain the visual authority;
  the synthesis layer does not duplicate them.
- Architecture, furnishing, materials, and VFX remain separate stages.
- Candidate identity binds both compiler IR and the production tool closure. A packaging or adapter change
  produces a new append-only candidate even when the generated geometry hash is unchanged.
- Candidate and V3 review tool identities use recursive local-module closure plus explicit Python/material/
  reference authorities. A newly imported validator cannot fall outside the candidate suffix.
- Blender subprocesses use a nonzero Python exception exit code, and exported semantic extras—not truncated
  Blender display names—own long compiler IDs.
- Review state is not stored as mutable truth in an immutable build manifest. Candidate discovery resolves an
  append-only, hash-chained review ledger whose entries bind the exact candidate, authority, capture, and
  existing central-review or building-HITL record. The existing stage/HITL schemas remain the sole human
  decision contract; the ledger is only an envelope.
- `gpuCaptureAtBuild` replaces the misleading `gpuCaptureRun` field for new candidate manifests. Historical
  manifests are never rewritten; their later review state comes from the ledger.
- Future captures write a private `capture-provenance.json` sibling binding the raw ephemeral trace hash,
  executable, ARM64 Bun runtime, recursively resolved capture source closure, argv, boot ID, exact outputs,
  and empty timestamp-risk environment-key inventory. Historical captures without this sibling may retain a
  rejection but can never advance to HITL or approval.
- Review-ledger verification parses that provenance through the exact FB-4 schema, binds candidate/authority/
  environment/output identities, and rehashes every PNG. The word `complete` is never accepted as proof by
  itself.
- A V2 FB-4 review authority is historical only. V3 requires a `siteReviewEnvelope`: exact runtime-pack-derived
  maximum vegetation reach, canopy-aware structure and camera-corridor exclusions, CPU terrain line of sight,
  interior-camera containment, and minimum projected subject coverage. These checks finish before engine/GPU
  creation and are revalidated from the native trace.
- V3 also binds a separate CPU articulation proxy, exact envelope artifact, resolved site-review evidence,
  camera-set hash, and review-tool closure hash. The proxy raycasts the exact production GLB and may claim only
  mechanical multi-view legibility. It cannot claim pixels, rendering, site fitness, visual quality, or human
  approval. Site fitness remains a second CPU authority; guarded engine capture and HITL remain later gates.
- V3 recomputes the proxy from the exact production GLB and policy, recomputes camera-set and recursive tool-
  closure hashes from current bytes, and refuses a retired authority before GPU preflight.
- All native building runners share the same complete `limina.rgba-luminance-sanity/v1` implementation. The
  schema always includes Rec.709 basis, pixel count, mean, standard deviation, crush/clip fractions, and a
  64-bin histogram; a runner may impose stricter thresholds but may not emit a weaker v1 payload.

## Acceptance

- Same program and rulebook produce byte-identical ordered candidates.
- Every selected candidate passes the existing compiler and functional-building v2 contract.
- Every generated storey uses one structural shell plus explicit shared partitions; no coincident room
  envelopes, wall solids, floors, or ceilings are accepted.
- The stair is mechanically proven wall-adjacent, joins both floors, owns a valid void, and passes capsule
  traversal and headroom tests.
- Every occupied upper room has compiler-authored exterior windows.
- Every program-required space has its required compiler-authored exterior windows on an allowed facade.
- A gable typology owns exactly two compiler-derived closure slabs before visual framing is permitted.
- Perceptual exterior frames remain aperture-clear, connected, collision-free, explicitly material-bound,
  and legible at the locked LOD2 budget without claiming a structural load path.
- No non-test source imports the legacy test fixture.
- Existing R1, reference, furniture, compiler, Blender, and traversal regressions remain green.
- All visual decisions use guarded Limina engine evidence and exact HITL approval.

## Current CPU candidate

`fb4-multi-room-candidate-1b4470041e01` is immutable rejected V2 regression evidence. It binds the V2 program,
source-neutral cue profile, candidate visual-design contract, deterministic rank-1 synthesis decision,
compiler spec/IR, staged Blender source, production GLB, LOD package, and complete production/material/tool
closure. It preserves four occupied-bedroom windows and adds one attic-articulation window, one supported and
flashed covered entry, and one fireplace-centerline chimney penetration. LOD0, LOD1, and LOD2 are respectively
22,160, 20,632, and 7,948 triangles; LOD2 remains below the locked 8,000-triangle budget. Its rulebook-owned
chimney projection was raised after the bounded CPU raycast correctly rejected the prior short stack. The manifest remains
truthfully `cpu-verified-human-pending` with `gpuCaptureAtBuild: false`, `cpuProxyEvidenceAtBuild: false`, and
no visual approval. Later CPU proxy, site review, capture, and central-review evidence are append-only siblings
and do not rewrite that build-time state. Its exact ledger resolves `rejected-before-hitl`.

The reproducible post-build sequence is:

```sh
bun tools/architecture/build-building-articulation-cpu-proxy.ts \
  --candidate-root assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01 \
  --out assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/articulation-cpu-proxy-v2.json

bun tools/architecture/build-fb4-multi-room-site-review.ts \
  --candidate-root assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01 \
  --out assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/review-v3-r5
```

Both commands are CPU-only. The second command refuses to create V3 authority unless the exact production
GLB passes the bounded articulation proxy and the exact temperate site/camera envelope passes.

The r1 guarded capture remained private and was rejected centrally. Relative to the approved R1 cottage it
regressed to a single rectangular two-storey mass with a blank gable, repetitive dark facade grid, a thin
foundation band, and under-resolved canopy bearing. Several detail/interior cameras also failed their named
claims. `review-v3-r5` exists only to regression-test recomputed proxy and recursive tool closure and carries
an explicit `retired-before-capture` record; the guarded runner refuses it before GPU preflight. The next
candidate must add program-owned volumetric massing and construction constraints rather than adding more
decorative parts to this box.

## Historical candidates

`fb4-multi-room-candidate-a38d89999682` is immutable CPU regression evidence. Its dormer and canopy passed
the semantic-triangle proxy, but its short rear-roof chimney failed the required front-three-quarter
projected height/area and visible-surface gate. The successor changes the V2 rulebook itself—rather than
loosening the evidence threshold—so that the rulebook hash and complete production closure record the fix.

`fb4-multi-room-candidate-d0ca1e327841` is immutable rejected V1 regression evidence, not the current visual
candidate. Its manifest
binds the coordinate-free FB-4 program, deterministic rank-1 decision, rulebook, generated spec and IR,
the 54-file production/material closure, Blender source, GLB, LOD package, and build evidence. It contains
two storey shells, four explicit partitions, two closed gables, eight required exterior windows, 150
compiler-derived perceptual frame members, five rooms, four portals, one stair, and three articulated doors.
The production and LOD GLBs both retain the sole semantic building root; all door roots remain outside static
batches, and long frame identities survive through semantic extras rather than Blender display names. LOD0,
LOD1, and LOD2 are respectively 21,068, 19,636, and 7,060 triangles within the locked budgets. Its front
landing and tread carry compiler-owned grade bearing and ecology-clearance authority.
Its immutable manifest records the truthful build-time state (`cpu-verified-human-pending`, no GPU at build).
The append-only review ledger resolves the current state as `rejected-before-hitl`; it is not visually approved.

The prior `fb4-multi-room-candidate-46c1e971f0f2` remains immutable historical evidence. It is superseded:
its explicit roof planes left both gable ends without compiler-owned closures, and synthesis silently omitted
the program's three hall and one kitchen windows. Those false-green gaps are now permanent regressions.

## First guarded diagnostic

The candidate was subsequently captured privately through the guarded production-engine FB-4 path at eight
1920x1080 views. Timestamp queries remained disabled and the complete pre/live/post Xid guard stayed clear.
The runner no longer writes directly into the browser review directory: it records `staged: false`, and a
separate deliberate staging action is possible only after central visual-floor inspection.

Central review rejected `assets/qc/internal/fb4-multi-room/program-frame-d0ca1e327841-r1` before HITL. The
front/rear and distance cameras were obstructed by canopy, the upper camera intersected vegetation, and the
unobscured views showed that the bounded rectangular typology remains too box-like and under-articulated for
the locked Project Gorgon floor. `CENTRAL-REVIEW.json` binds that decision. The capture is diagnostic evidence,
not a review artifact or approval candidate. Camera/site clearance and architectural articulation are separate
owners; clearing one may not be presented as clearing the other.

## Additive V2 program schema

The richer strategy extends rather than bypasses the proven V1 pipeline. `BuildingProgramV1`, its rulebook,
compiler output, traversal contract, and historical hashes remain regression-locked. `BuildingProgramV2` is
an opt-in schema with coordinate-free architectural articulation requirements and hard visual-floor gates.
Its first bounded slice is:

1. one front gable attic-articulation dormer with its own non-occupancy daylight opening, host cut, cheek/front
   closure, soffit bearing, flashing, and a stable roof bay; it does not consume or claim bedroom daylight;
2. one compiler-owned entrance composition satisfying the already-required weather protection and preserving
   threshold, door sweep, landing, and grade alignment; and
3. one chimney stack with compiler-owned roof penetration, curb/flashing/cricket/cap, fireplace/flue alignment,
   and a roof bay distinct from the dormer.

An attached service bay is deferred until it has a dedicated `AttachedBaySpec` and compiler-owned roof-junction
contract; it will not be faked with coincident volumes or inaccessible bump-out geometry. V2 candidates must
meet minimum articulation counts, asymmetry/silhouette deltas, multi-view CPU proxy checks, the V3 site-review
envelope, and every V1 mechanical regression before a guarded render is eligible.
