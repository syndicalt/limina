# World Builder → AAA Terrain, Biomes & World

Turn the Design Space map painter into a full agent-native world editor — the World Machine / Gaea /
Unreal Landscape bar — whose every stroke compiles into a walkable, swimmable 3D world across surface,
underground, and sky.

- **Integrated implementation plan:** `plan-6c5cbc419f824a8d` (agent-native Plans). This file is the
  authoritative, source-controlled execution copy.
- **Status:** APPROVED 2026-07-09. The pre-Studio baseline is preserved and fully gated at tag
  `studio-foundation-m0-baseline-20260709`; WB-F0 implementation is underway. See §Status & outcomes.

---

## Orientation

**Two authoring workspaces, one project.** The **Atlas** (2D top-down painter) owns what reads top-down:
terrain shape at map scale, water bodies, rivers, coastlines, biome + climate painting, road/POI layout.
The **3D editor** owns local terrain detail, entities, prefabs, materials, lighting, and true-volume
work. Their durable source is `MapDoc + non-destructive 3D edit layers + Scene + Assets`, committed
through one authoritative transaction protocol. `WorldMap`, render meshes, collision, navigation,
scatter, and exports are immutable content-addressed derived artifacts. Neither workspace writes a
compiled `WorldMap` directly. Rule of thumb: height/mask/polygon field → Atlas; true-volume or
sub-metre detail → 3D. Resolution/topology and other base changes use explicit conflict-preserving
layer rebase; silent destructive resampling is forbidden.

**Current foundation already reused.** Limina already has a serial tick-boundary authoritative server,
success-only world-log finalization, deterministic replay/snapshots, content-addressed assets, a pure
MapDoc compiler, 3D terrain sculpt/paint, hierarchy operations, browser/native export, PBR/IBL, water,
scatter, and LOD. WB-F0 extends these systems. It does not create a second command processor, terrain
renderer, history model, asset registry, or erosion implementation.

**Systems vs. content.** The engine gains a small set of SYSTEMS (heightfield, multi-layer terrain,
water/hydrology, a biome-definition registry, splat, scatter, POI stamps, streaming). The vast taxonomy
ships as a CONTENT LIBRARY on those systems — a biome is a DATA def (climate band, material, veg
palette, resource/spawn tables, water tint, ambient audio) in a content-addressed registry, the same
pack pattern already shipping. So "do we cover Tundra → Nether" is a content question, not an engine
rewrite. Cardinal-rule aligned (extend the system).

**Grounded diagnosis** (five source audits + one adversarial review, all confirmed file:line):

| Symptom | Root cause | Reality |
|---|---|---|
| Mountains cap at +48m | `tools/design/frontend/map-elevation.js:12` u8 raster `ELEV_MAX_Y=48` | 64m span; nothing downstream caps height. |
| Lakes won't fill | `js/src/world/worldmap.ts:148` scalar `seaLevel`; `map-raster.mjs:402` clamps depressions up | No water-body concept anywhere. |
| Rivers don't flow | `js/src/water.ts:345` `buildRiverRibbon` static material | Sea water is animated TSL; rivers are a draped static ribbon. |
| Crude river carving | `map-raster.mjs:506` relative 3m gully; `projectWaterways:234` drops `class` | Depth/width don't vary by stream order; no meander/valley/floodplain. |
| Not swimmable | 0 gameplay hits for swim/buoyant/submerged; `player.ts` capsule ignores water | No water volume, submerged test, or swim state. |
| Biomes are flat | `map-paint.js:295` 8 winner-take-all classes; `climate.mjs` exists but is a DEAD global scalar | No taxonomy, blending, or per-biome material/veg. |
| No erosion | `js/src/world/pipeline/erosion.mjs` used by the procedural gen only; never called in `map-raster.mjs` | Biggest gap vs Gaea — and the module already exists (the free win). |

---

## Chunks (the eight pillars)

Each pillar is a system the engine gains; content it enables is authored on top. "Authored in" = Atlas /
3D editor / engine.

### P1 — Terrain shape  (Atlas + 3D)
u16 heightfield (−500…+9,000m), sculpt/erode brushes, a landform-stamp system, an erosion pass. Enables
mountains, hills, plateaus, mesas, canyons, dunes, badlands, volcanoes, hoodoos, arches, pillars.

### P2 — Multi-layer world  (3D, mostly)
An **SDF + sparse-voxel** underground layer (true volume) + overhang/undercut + an aerial layer. Enables
caves, tunnels, dripstone, magma chambers, natural arches, sea stacks, floating islands.

### P3 — Water & hydrology  (Atlas)
Per-basin water bodies + depth zones, rivers (stream order / flow / waterfalls), coastal features,
swimmable volume. Enables ocean, reef, kelp, estuary, lake, marsh/swamp/bog, glacier, beach, fjord,
atoll; and swim.

### P4 — Biome system + full library  (Atlas)
A data-driven biome registry, spatial climate (extend the dead `climate.mjs`), blended borders,
auto-rules (snow-by-height, rock-by-slope), influence overlays. Ships the **full ~40** up front: WWF
core (tundra → mangrove) + aquatic + fantasy (volcanic/crystal/fungal/enchanted/blighted/nether).

### P5 — Surface detail  (Atlas + 3D)
Slope/height/biome splat materials + flora scatter packs. Enables grass/moss/rock/snow/ash;
trees/cacti/reeds/kelp/coral/giant-fungi/bioluminescent flora.

### P6 — World content  (Atlas layout + 3D precise)
POI/settlement/road/resource stamps + procedural layers. Enables villages, ruins, roads, bridges,
dungeons, shrines, ore/herb nodes, spawn zones. (Roads-to-3D is the project's own tracked #1 P6 gap.)

### P7 — Gameplay overlays  (Atlas)
Climate/wind + biodiversity/danger + wildlife spawn tables + seasonal/weather. Enables corruption
spread, pollution/radiation, protected/hostile zones, seasons.

### P8 — Scale & streaming  (engine)
Paged fixed-size tiles + LOD rings around the camera (beyond the current ~1.5km master-field ceiling at
`js/src/terrain/map-source.ts:53`).

**Taxonomy coverage** (the direct check that nothing on the requested list is dropped):

| Category | Pillar(s) | Authored in |
|---|---|---|
| Core terrestrial biomes (tundra, taiga, temperate/tropical forests, savanna, prairie, desert, mangrove…) | P4 + P5 | Atlas |
| Aquatic & wetland (ocean/reef/kelp/estuary/river/lake/marsh/swamp/bog/glacier/coastal) | P3 + P4 | Atlas |
| Geological (ranges/volcano/mesa/canyon/cliff/badlands + caves/underground/arches) | P1 surface + P2 underground | Atlas + 3D |
| Fantasy/sci-fi/special (lava/crystal/fungal/enchanted/blighted/floating/wasteland/alien/nether) | P4 defs + P7 overlays + P2 floating | Atlas + 3D |
| Vegetation/flora/ground cover | P5 | Atlas + 3D |
| Man-made / POI / infrastructure / resources | P6 | Atlas + 3D |
| Overlays/modifiers/gameplay (climate, wildlife, seasonal, multi-layer) | P7 + P2 | Atlas |

---

## Data-model bets (lock in the foundation phase)

Expensive-to-undo IR shapes. Additive-optional + `migrateWorldMap` keep old maps loading.

- **ReliefGrid** — `encoding: 'u8'|'u16'` (absent = u8 discriminator) + real range; resolution scales with map size.
- **WaterBody[]** (new) — per-basin `level` / `depthZones` / `footprint` / `kind`.
- **BiomeDef** (new, registry) — `climate {tempC,moisture}`, material, vegPalette, resource/spawn tables, waterTint, audio.
- **UndergroundLayer** (new) — `repr: voxel|SDF`, region, biome ref. Authored in the 3D editor.
- **Waterway** (modified) — `class`/`order` (was dropped) drives depth/width; per-vertex `widths`.
- **WorldProject** (new) — content refs for MapDoc, ordered terrain edit layers, Scene, Assets,
  LookProfile, and the authoritative head revision.
- **AuthoringTransaction** (new) — idempotent project/transaction id, exact base revision+hash,
  bounded adapter-backed operations, guarded compensations, and a server-filled committed receipt.
- **DerivedRevisionManifest** (new) — one dependency-consistent chunk set for one source revision;
  atomically published after staged compilation, with stale-job rejection and last-known-good fallback.

**HASH DISCIPLINE (load-bearing).** `js/src/world/worldmap-hash.mjs` hand-builds the canonical form
field-by-field. Every new field above needs a matching serializer entry, emitted only-when-present, in
the SAME commit — or it parses fine but ships UNHASHED (silently excluded from `contentHash`, breaking
provenance/content-addressing). Established in Slice 0.1.

---

## Sequencing (landable, gated slices)

- **M0 · Baseline & measurement** — preserve/classify the repair wave, verify each commit, run the clean
  release suite, tag the accepted baseline, and add a record-only Grey Field benchmark manifest.
- **WB-F0 · Studio + terrain foundation** — authoritative project transactions and conflict-safe undo;
  Atlas u16 painter (0.2), adaptive/local resolution and stable chunk ids (0.3), canonical erosion reuse
  (0.4), compiler-owned invalidation, atomic derived-manifest publication, Atlas↔3D live updates and
  edit-layer rebase; then Outliner/Inspector/Content Browser/build tasks/isolated Play and shared render
  quality telemetry. Each numbered slice lands independently.
- **WB-W1 · Water & swim** — minimal deterministic precipitation/drainage inputs, `WaterBody[]`, basin
  fill, `WaterField`, ordered rivers, visible flow/waterfalls/shorelines, editing, and functional swim.
- **WB-B2 · Biomes & surface** — `BiomeDef`, spatial climate, blends and rules, splat/PBR layers, existing
  scatter/grass/LOD integration, representative biome proof, then the approved ~40-biome library.
- **WB-U3 · Underground** — SDF + sparse-voxel caves, tunnels, arches, and overhangs.
- **WB-A4 · Aerial worlds** — floating terrain and traversal.
- **WB-S5 · Runtime scale** — paged tiles and camera-centred LOD rings using WB-F0 chunk identities.
- **WB-C6 · Content & overlays** — roads-to-3D, POI/settlement/resource stamps, climate/wind, danger,
  corruption, seasons/weather, and spawn tables.

Ordering is explicit: erosion shapes the surface before hydrology; a minimal precipitation/drainage
field lands before WB-W1 when climate drives flow. Hydrologic topology is recomputed only through an
explicit deterministic transaction that rebases dependents. WB-B2 later finalizes biome-aware bank
materials and vegetation; it does not silently recarve rivers.

---

## Verification

- Each slice ships a `pNN`/`p_*` gate (compile determinism / replay-equivalence where state is produced).
- P1: real-GPU Everest-scale render + a physics/nav check that it's genuinely impassable (impassable ≠ tall).
- P3: a carved mountain basin renders a lake at its own level, above sea, on the real GPU; a river visibly flows.
- P3 swim: playtest — enter, float, swim, surface; replay-deterministic (no clock/RNG in buoyancy).
- P4: a climate gradient renders distinct blended biomes; auto-rules place snow/rock correctly.
- Every IR change migrates — existing maps still load + hash byte-identically (only-when-present serializers).
- Transactions gate atomic failure, stale bases, duplicate ids, permissions, crash-before-ack durability,
  guarded compensation, reconnect/restart replay, and two-client races.
- Incremental compilation gates omitted client dirty hints, stale-job discard, dependency-complete
  invalidation, atomic manifest publication, and last-known-good recovery.
- Grey Field fixed-camera evidence records editor/browser/native images, CPU/GPU p50/p95, hitches,
  draw calls, triangles, texture memory, shader warm-up, startup, and editor latency. M0 records the
  baseline; numeric visual budgets lock only after the first controlled capture is reviewed.

---

## Risks / open questions

**Locked decisions (2026-07-09):**
- Heightfield encoding = **u16** (~0.14m steps at 9km).
- Underground representation = **SDF + sparse-voxel hybrid** (true caves/arches/overhangs; heaviest, most capable).
- Streaming = **paged fixed-size tiles + LOD rings**.
- Biome library v1 = **the full ~40** up front (slower to first playable, complete).
- Atlas ↔ 3D split confirmed (height/mask/polygon → Atlas; true-volume/sub-metre → 3D).
- Transaction authority = one server sequencer per project branch; exact-base commits, idempotent ids,
  explicit branch/merge, no automatic semantic rebase in the first implementation.
- Authoring source = `MapDoc + non-destructive 3D edit layers + Scene + Assets`; `WorldMap` is derived.
- Swim scope = **functional** (buoyancy + swim-speed + submerged + underwater tint).
- Streaming past ~1.5km and caves/underground are IN scope (upgraded from the initial recommended defer).

**Deferred even so** (later, if ever): dynamic ecological simulation (wildlife AI / food webs beyond
spawn tables); true CFD fluid simulation (vs. flow-painted rivers); full dynamic weather sim.

**Recurring tradeoff:** a fixed-resolution raster over a km-scale map ramps steep walls into slopes —
tall terrain needs higher resolution or locally-scoped feature rects, and (once P2 lands) true 3D volume
for genuine verticality. Interim stopgap: a slope clamp so the u16 range doesn't produce unsupported
near-vertical cliffs before the SDF layer exists.

---

## Status & outcomes

- **2026-07-09 — Plan approved.** All decisions locked. `plan-1afde76922e149e5`.
- **2026-07-09 — Slice 0.1 shipped (`7819bdc`).** u16 heightfield encoding: `ReliefGrid.encoding`
  (`u8`|`u16`, absent = u8 discriminator); hash emits `encoding` only-when-present (u8 maps hash
  identically); `reliefGridSampler` decodes u8 vs u16 (explicit little-endian, host-independent). Gate
  `p_reliefgrid_u16` (Everest-scale peak reachable, u8 back-compat, mis-tag throws, hash discipline).
  Gates green: p_reliefgrid_u16, p_worldmap_compile, check:determinism, check:portability. Painter still
  writes u8 — Slice 0.2 flips it.
- **2026-07-09 — Integrated Studio plan approved.** `plan-6c5cbc419f824a8d` unifies World Builder,
  Atlas↔3D, production editor workflow, and measured fidelity.
- **2026-07-09 — M0 code baseline accepted (`69c2931`).** Repair work preserved externally, partitioned
  into coherent commits, contaminated root assets excluded, clean release suite green (266 JS tests,
  all Rust tests, all headless host gates), and tagged `studio-foundation-m0-baseline-20260709`.
- **2026-07-09 — M1 transaction authority shipped (`719d8d9`..`f71ed9e`).** One WorldLog-backed
  project transaction kernel now provides exact-base commits, idempotent transaction IDs, compact
  replay proofs, guarded compensation, version-pinned scene adapters, linearizable reads, strict
  project identity, crash-before-ack durability, and server-wide fail-stop behavior after persistence
  or rollback failure. Editor chat tools now cross the same authoritative FIFO and fsync boundary.
  Adversarial gates cover restart replay, two-writer conflicts, wrong-project isolation, adapter drift,
  partial-operation visibility, poisoned batches, and durable publication order.
- **2026-07-09 — Slice 0.2 shipped (`386b3cd`, `b7012c6`).** Atlas authors explicit little-endian u16
  elevation over -500..9000m. Legacy u8 documents expand exactly and remain byte-identical until an
  actual edit migrates them. Brush/undo/growth/import/compiler paths retain u16 precision; malformed,
  oversized, non-canonical, and out-of-range payloads fail closed. Map Studio, u16, WorldMap compile,
  type, project-identity, and scaffold gates are green.
- **2026-07-09 — Terrain topology shipped (`efa7028`).** A shared fixed-grid contract provides
  revision-independent chunk IDs, versioned topology hashes, power-of-two-plus-one sampling,
  cross-LOD shared edges, exact negative coordinates, and bounded 8km-domain coverage. Legacy cache
  keys/hashes remain compatible; a complete v2 artifact hash now covers height, paint, climate, and
  blight channels without pretending its current JSON codec is the future high-throughput compiler codec.
- **2026-07-09 — Slice 0.4 erosion shipped (`d15b417`).** The existing erosion implementation now runs
  once over the complete bounded master field before hydrology and chunk slicing. Recipes are strict,
  versioned, recorded, cancellable, replay-identical across one-shot and streamed terrain, and have an
  exact disabled compatibility mode. Measured canonical bakes: 257x257 p50 95.1ms / 55.6MiB peak RSS;
  513x513 p50 399.1ms / 64.4MiB. Actual worker orchestration and controlled visual tuning remain open.
- **2026-07-09 — Compiler invalidation foundation shipped (`27bbbb3`).** A bounded immutable stage DAG
  computes canonical dependency keys, multigrid-aware halo propagation, local/global/version
  invalidation, cache hits, removals, and strict retained snapshots. Omitted or dishonest client dirty
  hints cannot narrow compiler-owned work and are retained only as diagnostic telemetry.
- **2026-07-09 — Authoritative project source state shipped (`4ef67e1`).** `WorldProjectState/v1`
  binds strict content-addressed refs for MapDoc, ordered topology-guarded terrain edit layers, Scene,
  Assets, and LookProfile to the same WorldLog transaction authority. Replace/patch operations are
  atomic, compensable, replayable, project-isolated, resource-bounded, and exposed through a
  permissioned linearizable read skill shared by server and browser replay.
- **2026-07-09 — Derived revision publication shipped (`bed500b`).** Immutable canonical manifests now
  bind the exact source head and assets to compiler/grid/chunk dependencies and typed artifacts.
  Publication stages and fsyncs content-addressed outputs, rejects stale heads, serializes the final
  pointer swap with a live-owner-aware cross-process lock and CAS, and validates current or previous
  artifacts for last-known-good recovery. Crash, corruption, traversal, lock-steal, and race gates are
  green; the lock is intentionally a local-host filesystem contract, not a distributed NFS lease.
- **2026-07-09 — Authoritative editor scene workflow shipped (`498970d`).** Inspector and gizmo edits
  submit grouped exact-head scene transactions; stale heads fail explicitly; undo records a guarded
  compensation and redo records a new reapply transaction. History scrubbing is view-only, browser and
  simulation replay register the same scene plus project-state allowlist, and the scaffold launcher
  rebuilds missing or stale ignored editor bundles on a clean source checkout.
- **2026-07-09 — Non-destructive terrain edit layers shipped (`d906e0b`).** Versioned, self-hashed base
  grids and domain topology now compose ordered sparse metre deltas without rewriting the base. Exact
  refinement/coarsening rebases preserve shared samples and report structured conflicts rather than
  silently losing detail; a prepared spatial index keeps chunk composition proportional to local
  deltas. Gates cover negative chunks, seams, tampering, bounds, cancellation, and distant-chunk work.
- **2026-07-09 — Production Outliner and shared selection shipped (`0dfc394`).** A single selection store
  now drives Outliner, viewport, and Inspector. The Outliner pages a version-guarded snapshot up to an
  explicit 20,000-entity cap, repairs cycles/orphans for display, filters with ancestor preservation,
  and virtualizes fixed-height rows. External selection expands and reveals ancestors without fighting
  Outliner-origin scrolling; real Chromium desktop/mobile gates rendered 33 rows for 251 entities.
- **2026-07-09 — Atlas source bridge shipped (`8cfa64b`).** Atlas saves canonical content-addressed
  MapDoc sources, commits one exact-head `project-state` ref patch, validates the complete durable
  receipt/head/commit-record chain, and publishes the mutable `maps.json` mirror only afterward.
  Cross-process locking, stale-workspace CAS, at-most-once transport defaults, bounded frontend retry,
  and committed-mirror repair are adversarially gated without duplicate commits or revision churn.
- **2026-07-09 — Atomic derived runtime shipped (`3045fa1`).** Exact-head manifests stage changed
  chunks offscreen, retain unchanged runtime identity, activate one dependency-complete set atomically,
  and retire replaced resources only after visibility commits. One-active/one-latest-pending scheduling,
  independent caller cancellation, native `AbortSignal` callbacks, bounded diagnostics, reverse cleanup,
  authority TOCTOU checks, and explicit rollback are gated. The shared pure-JS SHA-256 byte path now
  hashes large artifacts directly in 64-byte blocks instead of cloning them into boxed-number arrays;
  browser/simulation adapters still need to keep maximum-size synchronous hashing off the UI thread.
- **2026-07-09 — Authoritative build coordination shipped (`879eb92`).** Trusted compiler identity and
  exact source heads produce deterministic build IDs; identical work coalesces, per-branch queues keep
  only active plus latest pending intent, and a fair global scheduler caps concurrent compiles at two by
  default. Authority is checked before compile, before publication, and by the publisher at its atomic
  commit boundary. Strict manifest/artifact verification, last-known-good metadata, bounded O(1)
  diagnostics, stale cancellation, and late-abort-after-commit semantics are covered by 44 combined
  coordinator/publisher tests. Concrete terrain artifact compilation and service wiring remain open.
- **2026-07-09 — Production Content Browser shipped (`3eac2e1`).** The editor now owns one docked,
  keyboard-accessible catalog surface with strict payload validation, deterministic search/category/type
  filtering, fixed-row virtualization, bounded refresh coalescing, recoverable error states, metadata and
  thumbnail inspection, and one shared placement/yaw authority used by the viewport. A 5,000-asset real
  Chromium gate renders only 9 desktop and 8 mobile rows, verifies refresh/error recovery and placement
  handoff, and asserts the terrain HUD and viewport controls never overlap while placement is armed or
  restored. The server catalog remains intentionally capped at 20,000 entries until its API supports
  pagination.
- **2026-07-09 — Portable terrain chunk artifact codec shipped (`ceb8c89`).** Versioned little-endian
  binary artifacts now carry exact dimensions, world origin/scale, normalized heights, and independently
  optional paint, climate, and blight channels with canonical padding and strict numeric/resource bounds.
  Decoding rejects malformed/trailing/aliased data and returns owned channel storage. All 16 channel
  combinations, shared-edge equality, mutation-sensitive hashes, corrupt headers/payloads, misaligned
  subarrays, and 2x2 through 257x257 limits are gated in both Node and the Limina host against the same
  fixed content-hash vector. The central 257x257 full-channel measurement was 1,651,308 bytes, 31.7 ms
  encode, and 24.0 ms decode in Node; concrete source-to-artifact compilation remains the next slice.
- **2026-07-09 — Deterministic WorldMap terrain compiler shipped (`838e265`).** One globally rasterized
  and eroded master field now feeds stable 33x33 LOD0 chunks, ordered metre edit layers, fixed
  `[-500, 9000]`-compatible vertical normalization, portable artifacts, compiler snapshots,
  invalidation diagnostics, and dependency-complete derived manifests. The production DAG now models
  WorldMap, base height, and erosion as genuinely global stages before chunk-scoped edits, collision,
  and rendering. Exact scanline indexes, segment BVHs, AABB pruning, and prepared edit-layer buckets
  removed both cell-by-all-vector and chunk-by-all-delta scans without changing legacy raster bytes.
  The external Grey Field benchmark builds the 1,050,625-sample master in 1.833 seconds and all 6,400
  chunks/174,771,200 artifact bytes in 8.942 seconds on the central host (405,456 KiB peak RSS).
  Content-addressed reuse is deliberately not faked: this compiler still emits every artifact, so the
  authoritative build-service/cache slice must make local iteration proportional to changed chunks.
- **2026-07-09 — Canonical basin water IR shipped (`75957bb`).** Optional, additive `WaterBody[]` now
  represents bounded standing-water basins with stable ids, typed kinds, explicit levels, simple polygon
  footprints and holes, and contiguous shore-to-interior depth bands. Waterways retain legacy bytes while
  optionally carrying Strahler order and exact per-vertex widths. One shared validator governs the
  TypeScript WorldMap boundary and dependency-free MapDoc compiler, rejects accessors/prototype pollution,
  and caps all topology work at 2,000,000 metered units; hostile 16x512-ring input stops at cap+1. Every new
  field participates in the canonical hash while legacy committed map bytes/hashes remain exact. Basin
  filling, `WaterField`, animated flow/waterfalls/shorelines, authoring tools, and functional swim remain
  open WB-W1 runtime slices.
- **2026-07-09 — Indexed basin/ocean WaterField shipped (`8af0498`).** The runtime now verifies the
  complete WorldMap identity before building immutable, capped body and shoreline BVHs. Queries expose
  dry, ocean-candidate, and basin results with explicit outer-wet/hole-dry boundaries, half-open depth
  bands, final-band clamping, actual terrain submersion depth, and deterministic overlap rules. A proven
  submerged ocean competes by surface level without turning an unknown ocean into a false wet claim.
  Bounded 257x257 sampling emits fixed 48-byte little-endian records with cooperative cancellation. The
  central hostile gates cover 4,096 bodies/16,384 edges (100,000 queries in 89 ms) and a legal near-budget
  1,952-edge basin at 1,967,086 topology units (257x257 sample in 288 ms). Rendering, collision, hydrology,
  authoring tools, and functional swim remain open WB-W1 slices.
- **2026-07-09 — Isolated editor Play shipped (`2d76f7d`).** Play captures an immutable, validated
  authoritative project head plus command prefix, locks every editor write surface, pauses and
  render-suspends the retained Edit runtime, and runs simulation on a disposable canvas. New authoritative
  edits mark the session stale without mutating it; Stop applies the buffered delta or performs a guarded
  reboot, retains recovery state across failures, and unlocks authoring only after Edit is restored. Worker
  pause/resume is acknowledged and halts both timer and manual stepping. Unit, type, composition,
  desktop/mobile layout, pixel-bearing viewport, and a real repeated Play/pause/external-edit/Stop browser
  workflow are green. Packaged builds and derived-terrain runtime activation remain part of the open
  Atlas-to-3D build-service bridge.
- **2026-07-09 — Sparse authoritative compiler and publisher shipped (`845d867`, `44bd6da`).** The
  WorldProject source snapshot now compiles through compiler-owned sparse planning, independently
  verifies reused artifacts, stages dependency-complete manifests plus compiler snapshots, and atomically
  publishes a v2 pointer with cancellation, stale-head rejection, corruption recovery, and v1 migration.
  Repeated identical builds retain artifact identity instead of rewriting unchanged chunks.
- **2026-07-09 — Derived build service and scaffold bootstrap shipped (`00b2d74`).** A worker-thread
  service consumes one atomic, hash-bound `authoring.sourceSnapshot`, compiles with cooperative
  cancellation, and publishes through the real coordinator. The generated-app launcher owns the editor,
  sidecar, and build-service lifecycle; a least-privilege system profile can perform only the guarded
  revision-zero MapDoc bootstrap. A fresh packed scaffold UAT survives restart without source, pointer,
  WorldLog, or CAS churn.
- **2026-07-09 — Persistent renderer lifecycle shipped (`80859b5`, `8055115`, `e8f1274`).** Edit reuses
  one exclusive lazy renderer host while each world receives reset scene/camera/renderer state, bounded
  telemetry, tiered DPR/shadow/post budgets, and exhaustive teardown. Content-addressed per-host GLTF
  caches reject active-world misses, rotate changed bytes under the same asset id, deduplicate concurrent
  parses, enforce entry/byte limits, isolate hosts, and release shared geometry/textures at host disposal.
  Terrain materials are world-pooled and bounded; authored light ids reset per logical world; dormant
  entities and streamed terrain reattach/unmount exhaustively. Real Chromium gates cover 21 world
  replacements with one renderer, bounded GPU counters, responsive DPR backing, cleanup fault injection,
  worker-fatal recovery, pixel-bearing output, and repeated isolated Play/Stop restoration.
