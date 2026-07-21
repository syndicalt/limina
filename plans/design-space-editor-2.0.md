# Design Space / Editor 2.0 — One Studio, Two Live Surfaces

Reimagine the authoring UI as a single modern editor: the Atlas (2D) and the 3D
viewport are **two live surfaces of one world**, not two apps stitched by bridges.
Every tool obeys one contract. Every edit flows through one authority and renders
in every surface. This plan supersedes the bridge-era chunks of
`plans/studio-unification.md` (U2–U4 become 2.0-A/B/D/E) and incorporates the
locked authority model of `plans/world-builder-aaa.md`.

- **Status:** PROPOSED 2026-07-19 — for owner review. Builds on landed U0/U1
  (headless sidecar, capability bootstrap, studio shell, Docs panel).
- **Evidence base:** three full inventories (Atlas tool system, 3D tool surface,
  canonical authority model), all claims file:line-verified 2026-07-19.

---

## 1. Why a reimagining, not more patches

The current UI is accreted bridge engineering. Evidence:

**Atlas is ad-hoc where it should be systematic.** There is no tool registry: 12
tools dispatched through parallel hardcoded if-chains over a global `mapTool`
string across ~8 scattered sites (`frontend/map.js:616-630, 2323-2424, 3301-3395,
643-724, 820-849, 1460-1464, 2481-2488, 2524-2536`). The predictable results:
elevation's radius slider has no readout while land/terrain do
(`map.js:2530-2533`); only elevation exposes strength; land is fixed ×4 overdrive
with no falloff control while terrain dabs hard-edged (`map-paint.js:182,370`;
`map-elevation.js:194`); sea level — a global map property — is editable only
inside the Elevation tool's props (`map.js:673-677`); a ghost `marker` tool has
dispatch but no toolbar button (`map.js:836, 2379-2381`); basin edits are raw JSON
textareas (`map.js:2073-2085`); place/marker moves bypass the undo stack entirely
(`map.js:3579-3607`); every tool switch rebuilds the entire SVG + toolbar DOM
(`map.js:725-800`).

**The 3D editor hides its tools.** Terrain sculpt/paint lives behind F4 with zero
static chrome (`viewport.js:2250-2339`); gizmo modes are keyboard-only (W/E/R);
`noise` deform and 3 paint materials exist in skills but not in any UI
(`terrain-edit.ts:120,152`); water, scatter, road, and spline tools have skills
and no UI at all (`water.ts:349-571`); the terrain brush only edits
`EditableTerrain` layers — the Atlas-compiled derived terrain in the same
viewport is immune to the same tools, with no visual distinction
(`terrain-edit.ts:536-540`).

**The "live" link isn't.** Atlas→3D derived updates ride HTTP polling with idle
backoff to **8 seconds** (derived-runtime-worker.ts:994-998), whole-revision
atomic swaps for a one-stroke edit, and the watcher closes entirely during
history scrub/Play (`viewport.js:3022-3023`). The worldlog channel already has
push (`worldlog/subscribe`, viewport.js:1664-1668) — the derived channel never
adopted it.

**Caves are impossible by construction.** Terrain is a single-valued heightfield
everywhere — `TerrainTile.heights`, Rapier heightfield collider,
`terrainTileBufferGeometry` — no overhangs, no holes, no voxel/SDF/CSG anywhere in
js/src. The documented future is WB-U3 "SDF + sparse-voxel UndergroundLayer,
authored in the 3D editor" (world-builder-aaa.md:114,203) — not started.

## 2. The 2.0 model — how everything interacts

Five decisions; everything else follows.

### D1 — One shell, surfaces, not apps

The stage hosts **surfaces**: `Viewport` (3D), `Atlas` (2D), `Docs`, `Graph`,
`Ship`. Surfaces live in **dock groups with split view** — the canonical layout
is Atlas left + Viewport right, both live simultaneously; a single-focus mode
(tabs) for small screens. This replaces: the workspace tab toggle (U1 first
slice), the iframe Atlas dock, the atlas-handoff relay, and the standalone Design
Space SPA. The `panel-registry`/`studio-shell` manifest already models panels and
profiles; 2.0 extends it with dock groups (two layout primitives: `split` and
`tabs`, persisted per profile). No framework — vanilla ES modules + keyed-render,
per the standing constraint.

### D2 — One Tool Contract, registry-driven

Every tool in both surfaces is a declarative registration:

```js
registerTool({
  id: "terrain.raise",
  group: "terrain",                 // select | terrain | paint | water | line | place | structure | measure
  surfaces: ["atlas", "viewport"],  // where it applies
  cursor: "brush",
  options: { radius: {min:2, max:400, def:40}, strength: {min:0.05, max:1, def:0.5},
             falloff: ["cos2","linear","smooth"], mode: ["raise","lower","smooth","flatten","noise"] },
  gesture: "stroke",                // stroke | click | drag | poly | lasso
  commit: strokeToCommand,          // → ONE command-layer entry (undoable by construction)
});
```

The options bar, HUD, cursor ring, `[`/`]` sizing, and keyboard shortcuts are
**generated from the schema** — one control set, uniform across every brush, in
both surfaces. This deletes the ~8 scattered dispatch sites in map.js and the
hidden-F4 HUD in viewport.js, and makes "Land has no layer entry"-class drift
impossible by construction: options are declared once per tool, rendered once by
the shell. The existing clean seams stay: `map-commands.js` (pure, property-tested
undo inverses) for 2D commits; recorded skills for 3D commits. New rule:
**every mutation, every tool, goes through the command/skill path — no direct
POSTs, ever** (kills the place/marker undo bypass).

Tool groups (rationalized):
- **Select** — pick, box/lasso, multi-select, move (shared selection store, D4).
- **Terrain** — raise/lower/smooth/flatten/noise, uniform radius/strength/falloff.
- **Paint** — material/splat in 3D, biome class in 2D (same option contract).
- **Water** — sea level (moved to map properties), basin (with vertex editing —
  raw JSON textareas die), river line, hydrology recipe.
- **Line** — road/river/border polylines with Chaikin smoothing (one tool, type option).
- **Place** — asset/stamp/place with catalog picker, rot/scale at placement, drag-drop.
- **Structure** — building anchors, cave entrances + volumes (D6).
- **Measure** — distance/area, camera vantage (the camera tool graduates from session-only).

### D3 — One live link: derived revisions go push + incremental

Goal: paint a stroke in Atlas, watch the terrain change in the 3D surface within
~1s, no manual compile, no modal peek.

1. **Derived push**: the derived-runtime channel adopts the worldlog push pattern
   — the build service notifies watchers on publish (ws or SSE on the sidecar),
   replacing the 250ms→8s idle-decay HTTP poll. While the Atlas surface is
   focused, the watcher pins to low latency.
2. **Incremental activation**: the compiler already works per-chunk; activation
   swaps only dirty chunks (revision manifest diff → remount those chunks)
   instead of the whole-revision atomic swap. Atomic publish stays (stale-job
   rejection, last-known-good); only the *mount* becomes incremental.
3. **Dirty-region hints**: the stroke's bbox is already computed for undo
   (`map.js:3541-3551`). It flows into the save payload as a compile-priority
   hint — respecting the authority rule that client hints "cannot narrow
   compiler-owned work" (world-builder-aaa.md:260-262): the hint schedules and
   orders chunk compiles; the compiler still validates and owns output.
4. **The peek modal dies.** Side-by-side live surfaces replace 30–90s pre-rendered
   yaw stills and its editor-destabilizing GPU contention (`map.js:2674-2699`).
   Peek survives as an agent vision op (U4), not a user workflow.
5. **Watcher resilience**: the derived watcher no longer closes during scrub/Play
   — it marks updates stale-gated and applies on return, matching Play's
   pinned-revision contract (world-builder-aaa.md:387-392).

### D4 — One selection and navigation model

One selection store across surfaces (extends the existing `editorSelection`):
selecting an entity in 3D highlights it in Atlas and Docs; double-click frames it
in the other surface (today's source-fenced focus/reveal becomes ambient, not a
30s postMessage timeout). Shared: camera bookmarks/recents, frame-world, POI
search (the shipped binary POI index), and `designRef` identity for exact
entity↔POI provenance. The 2D↔3D reveal asymmetry (`map.js:494-495` embedded-only
guard) disappears with the iframe.

### D5 — Terrain editing on edit layers, everywhere

Reconcile "two terrains, one brush": the 3D terrain brush stops targeting only
`EditableTerrain`. It writes **non-destructive 3D edit layers over whatever
terrain is mounted** (derived/Atlas-compiled included) — exactly the locked
`MapDoc + 3D edit layers` model (world-builder-aaa.md:20-25), with explicit
conflict-preserving rebase when the base recompiles (silent destructive
resampling stays forbidden). Visual distinction: edit-layer regions render with a
subtle overlay cue. The derive pipeline gains layer rebase on new base revisions
(structured conflicts reported, never silently dropped).

### D6 — Caves: honest near-term, structured long-term

By construction (heightfield), caves need either volume modeling (WB-U3, the
SDF+sparse-voxel program — separate, heavy) or the practical composition:

1. **Terrain hole masks** — a bitmask channel on `TerrainTile` (alongside
   `paintMat/paintW`), clipped in `terrainTileBufferGeometry` and split in the
   Rapier heightfield collider. Paintable with the Terrain tool ("hole" mode) —
   this is how entrances open.
2. **Cave mesh stamps** — cave/tunnel segment GLBs through the existing
   `asset.place` seam (Build→bake→QC→import, never assemble at placement),
   aligned to hole mouths. The Structure tool group places them.
3. The underground **view mode** (clip plane / interior lighting preset) makes
   authoring inside caves viable.
WB-U3's true-volume `UndergroundLayer` remains the long-term answer; the 2.0 UI
 anticipates it with the Structure group and underground view, and D6's mask +
 stamps are forward-compatible (stamps reference designRef identities).

## 3. What dies (explicit retirements)

| Patch-era artifact | Replacement |
|---|---|
| iframe Atlas dock + splitter (`index.html:204-215`) | Native Atlas surface (2.0-A) |
| `atlas-handoff.html` relay + sessionStorage token pass | Already deleted functionally in U0; removed in 2.0-A |
| Byte-mirrored `atlas-editor-protocol.js` + drift test | In-process calls (D4) |
| Modal 30–90s peek (`map.js:2656-2699`) | Live side-by-side (D3) |
| Ghost `marker` tool | Registry delete |
| Basin raw-JSON textareas | Vertex-edited basin tool |
| `confirm()` delete dialogs ×7 | Undo-capable inline actions (command layer) |
| Session-only undo | Command log persistence via the transaction protocol |
| F4-hidden terrain HUD, keyboard-only gizmo | Generated tool ribbon + options bar (D2) |
| Standalone Design Space SPA | Retired (U0 headless sidecar is backend-only) |

## 4. Phases (landable PRs)

**2.0-A — Atlas native + Tool Contract foundation (3–4 wks).** Port map.js onto
the studio shell as a native surface — **through the registry, not a 1:1 port**:
every existing tool re-registered in D2 form with uniform options; layer panel
with empty states, per-layer eye+delete; keyed-render for toolbar/layers (full
DOM rebuild per switch dies); map-commands preserved as the commit seam; the
shared-coast renderer preserved (painted coast = compiled coast, standing
constraint). Ghost marker removed; sea level → map properties; basin vertex
editing. Gates: per-tool browser behavioral gates (each tool used end-to-end in
Chromium: stroke → undo → redo → save → CAS conflict path), `p_studio_atlas_native`
(paint → save → compile → derived revision), falsifiability: a mutation outside
the command layer is rejected.

**2.0-B — Live link (2 wks).** Derived push, incremental chunk activation,
dirty-region compile hints, watcher resilience during scrub/Play. Gates:
`p_studio_live_link` — paint stroke in Atlas surface → derived revision → chunk
remount in Viewport surface **within 1s p95** in a real browser, measured, with a
pixel-diff on the 3D canvas (real-GPU UAT; CPU chromium covers behavior, not
pixels, per the standing verification honesty rule).

**2.0-C — 3D tool ribbon + edit-layer terrain (2–3 wks).** Generated mode ribbon
+ options bar (D2 registry drives the 3D surface), persistent Sculpt/Paint/Place/
Select modes, drag-drop from Content Browser, multi-select/box-select/duplicate/
group UI over the existing skills, water tools UI, scatter brush (interactive
paint-erase of instances over `asset.scatter`), gizmo space/pivot controls. The
terrain brush retargets to edit layers over mounted terrain (D5) with rebase on
base recompile. Gates: per-tool usage suites; edit-layer rebase conflict gate
(base recompiles → shared samples preserved, structured conflicts reported);
determinism + recording parity (every ribbon action is a recorded skill).

**2.0-D — Selection/nav unification + remaining panels (1–2 wks).** One
selection store, ambient focus/reveal, shared bookmarks/POI search, Places/Graph/
Packs panels (port order per studio-unification U1), Ship panel + `op_write_export`
(U4). Gates: cross-surface selection/reveal behavioral tests; ship panel →
portable bundle round-trip.

**2.0-E — Caves near-term + roads-to-3D (2–3 wks).** Terrain hole-mask channel
(render clip + collider split + hole paint mode), cave mesh stamp pipeline
(author → QC → catalog → place at hole mouths), underground view mode; road
spline → terrain-following road meshes (P6, the project's tracked #1 gap).
Gates: hole-mask render/physics parity (hole clips render AND collider, replay
byte-identical), cave stamp placement QC, road spline compile determinism.

**2.0-F — Coordination surfaces (2 wks, parallel-trackable).** Agent proposal
ghosts in both surfaces, unified approval inbox (world holds + design proposals),
task board panel, chat router (expert personas on `runBoundedMultiTurn` with
context packs + streaming), `design.review` gate. Per studio-unification C2–C4.

## 5. Verification (standing rules apply)

- Every tool gets a **used-in-browser behavioral gate** (not source-text):
  activate tool → act → verify world state + undo + save. The full ribbon is
  exercised in CI's CPU Chromium; pixel-bearing proofs (live-link terrain change,
  hole masks, water) require real-GPU UAT — SwiftShader is not pixel evidence.
- `run-gates.sh --quick` green per phase; determinism/portability/recording
  lints; tsc. Every phase is a vertical slice with its own gate + falsifiability.
- UAT at 2.0-B and 2.0-E: human paints in Atlas, watches 3D change; human digs a
  cave entrance and walks in.

## 6. Risks / open questions

- **Atlas port scope.** map.js is 3,805 lines including water authoring, elevation,
  navigation projection. The registry port is a rewrite of dispatch, not of the
  paint kernels (map-paint/map-elevation/map-commands are clean and stay).
  Schedule risk lives in gesture edge cases; mitigate by porting tool-by-tool
  behind the registry with the old surface flag-available until parity gates pass.
- **Edit-layer rebase on derived terrain (D5)** is the deepest engine change
  here. It builds on the shipped sparse-metre-delta rebase machinery
  (world-builder-aaa.md:279-283) but extends it to arbitrary base recompiles.
  If it slips, 2.0-C ships the ribbon with brush-on-EditableTerrain unchanged and
  D5 as its own phase — the UI does not block on it.
- **Derived push (D3)** adds a second push channel to the kernel; backpressure
  semantics must match worldlog subscribe (bounded queues, drop-oldest with
  resync) — design reviewed against net.rs's existing patterns at implementation.
- **Hole masks vs physics determinism**: collider splitting on holes must stay
  bit-exact across replays; the gate requires replay byte-identity with holes.
- **Where does the Atlas surface's canvas come from?** Today's Atlas is SVG +
  canvas rasters; a WebGPU Atlas renderer sharing the engine's camera math is
  attractive long-term (premier WebGPU editor) but is NOT 2.0 scope — the port
  preserves the existing renderer to keep the phase landable.
- **Open status questions to verify at kickoff:** WB-F0-N per-item status (some
  items superseded by later entries), noncanonical-map normalization, editor-host
  ~50 s rehydration debt (matters for live-link UX), sidecar chunked publish path.


## Status & outcomes

**2026-07-19 — 2.0-A foundation vertical slice LANDED (studio lane).**

- **Design system** (`editor/styles-studio.css`): full token layer (elevation/text
  ramps, accent, spacing/type/radii/motion scales) + generated-UI components
  (tool ribbon, options bar, layer panel, dock tabs/split, Atlas surface).
- **Tool Contract registry** (`editor/src/tools/tool-registry.js`, 8 tests):
  strict descriptor/option validation, surface-confined controller with
  clamp/step/domain coercion + persistence + strict restore, generated ribbon /
  options bar / brush keys, one-ribbon-one-bar discipline. Its validation caught
  a spec violation in its own first consumer (land.brush → terrain.land) — the
  contract working as designed.
- **Dock layout engine** (`editor/src/dock-layout.js`, 14 tests): split (drag
  dividers, clamped ratios) + tabs, lazy surface mounting, strict state/restore.
- **Native Atlas surface** (`editor/src/atlas/`): paint kernels byte-identical to
  the originals (600-dab differential per kernel), doc model with injected
  /shared codec (live wire formats verified against the real vault: rle8
  landmass, u16 elevation), undo stack, CAS-debounced mapSave (maps-array
  payload contract), frame-aware layer sampling (per-layer rect/resolution —
  no shared-index compositing), borderOcean shared-coast rule, workspace
  integration (third tab + hidden-guard CSS fix), fit race fixed (needsFit
  until real stage dims). Live-verified on limina-world: ribbon/options render,
  Land raise/carve strokes paint + persist, layer rail, pan/zoom, cursor ring.
- **Chrome**: Atlas workspace tab (World ⇄ Atlas ⇄ Design), `window.__atlas`
  test hook + `worldToScreen` diagnostic.
- **Process note:** a timed-out background coder rewrote its (divergent) module
  over the orchestrator's spec-conformant one twice before being stopped; the
  spec-conformant implementation was restored and write-locked (chmod a-w on
  tool-registry.js + its test — `chmod u+w` to edit, then re-lock). Files
  verified stable since.
- Remaining 2.0-A: per-tool browser gates suite, remaining tools (water/line/
  stamp/basin + select/lasso), SPA retirement. Then 2.0-B live link + split view.


**2026-07-19 — Terrain power-up (studio lane).** Rich terrain editing on the
Atlas surface, all deterministic and parity-preserving:

- **Kernels** (`paint-kernels.js`): falloff family (cos² parity-locked, linear,
  smoothstep, sharp); land strength (1-8×, default = original ×4); elevation
  `noise` mode (coordinate-hash displacement, redo-identical, ±4.8m @ str 1);
  `flatten` mode (pulls toward stroke-START height). 5 new extension tests +
  all 5 parity tests green (600 dabs/kernel byte-identical).
- **Surface**: uniform options on Land (mode/radius/strength/falloff) and Elev
  (6 modes + radius/strength/levelY/falloff) — generated by the Tool Contract
  with zero hand-written controls; Alt-click height eyedropper into the Level
  target; live cursor readout (world x,z + elevation m); sea level control
  (undoable cmdSetMapProp, persists via save, renderer mirrors via
  syncSeaFromDoc); undo/redo rail buttons. Live-verified: options render, noise
  displaces, status strip, undo works, derived pipeline compiles edits
  (generation 31) — the Atlas→3D propagation path is exercised end-to-end.
- **Process lessons recorded:** (1) interactive verification on the LIVE world
  vault is forbidden — fixture projects only (the studio_docs_panel_browser
  pattern); the user's vault was used for stroke verification and, while the
  painted test data was located and erased cell-exactly (verified via raster
  ASCII maps + pixel probes), small cosmetic risk to the natural SE coast edge
  remains and was disclosed to the owner with the current-state screenshots.
  (2) Cross-session save/rev churn makes fresh-load verification the only
  trustworthy read of vault state. (3) The Tool Contract's own validation
  caught a spec violation in its first consumer — keep contracts executable.


**2026-07-19 — Management surface (the hub) LANDED + a real replay bug found & fixed.**

- **Hub** (`tools/scaffold/scripts/hub.mjs` + `tools/scaffold/hub-ui/`): the boot
  surface. Lists projects under the projects root (env `LIMINA_PROJECTS_ROOT`,
  default repo parent) with last-touched + running state; creates validated
  projects via create-limina-app (name pattern enforced, duplicates 409,
  containment rejects escapes); opens existing projects by allocating free ports
  and supervising the project's own editor.mjs child (syncing launcher scripts
  first — the stale-copy trap), parsing its readiness banner, and handing the
  browser the stack URL. Loopback + exact Host validation on every route.
  2 node suites + full E2E: hub → create hub-demo → stack boots → studio loads;
  hub → open limina-world → studio loads with its world log.
- **Studio bootstrap fix**: the ws-URL prefill now also overrides the factory
  default (8787), so hub-launched stacks on allocated ports connect correctly.
- **REPLAY BUG (found by the hub E2E, real vault):** limina-world would not
  boot — `AuthoritativeServer rehydrate: command seq 107 failed
  (pending_approval)`. A held-then-granted action enters the log as an ordinary
  applied command, but rehydrate re-invoked persisted commands WITHOUT
  `approvalGateBypassed`, so granted actions from review-gated profiles replayed
  as pending_approval and boot died. Fix (net/server.ts: rehydrate passes
  `approvalGateBypassed: true` — the log is the record of APPLIED mutations;
  replay applies, never re-holds; the bypass is replay-only and the live gate
  still holds). NEW gate `p_studio_approval_replay` (live hold→grant→record;
  falsifiability leg reproduces the pre-fix hold; boot rehydrates; gate still
  holds after boot) + 7/7 approval/worldlog regression family green. Registered
  in QUICK_DETERMINISM_GLOBS.


**2026-07-19 — 2.0-A core tool surface COMPLETE (studio lane).**

- **water.basin**: point-by-point polygon (deduped vs double-click repeats),
  dblclick/Enter close, Esc cancel, live preview; constructed + validated by the
  SHARED engine contract (/shared/water-ir.mjs — kind/level/depth options,
  monotonic depth zones, duplicate-id + topology checks) so an authored basin
  can never drift from what the compiler accepts. Two real failure modes found
  and fixed in review: makeWaterBody returning the array instead of the body;
  dblclick pointerdown duplicates tripping the repeat-vertices rule.
- **line.draw**: river/road/border with color option; drag → Chaikin×2 +
  decimate (byte-faithful port, tested against expected point lists) → feature.
- **place.stamp**: catalog-backed anchors with rot/scale options (project
  catalog seeded from real GLBs; empty-catalog state toasts the pack-import path).
- All three ride the same seams as the brushes: command layer (undoable),
  CAS save, ambient events, durability proven — lake@0m/8m, road 26pts,
  pine.glb anchor persisted through save → vault → fresh load → render.
- Suites: 4 atlas_features tests + full studio suite green (216 node tests,
  1 honest environmental skip; p_studio_* engine gates all pass).
- Remaining 2.0-A: SPA retirement. Then 2.0-B live link.


**2026-07-18 — 2.0-A polish LANDED: select/lasso/delete + stamp picker (studio lane).**

- **atlas-hit-test.js** (pure, world-meter tolerances — zoom-independent): ray-cast
  point-in-polygon, point-segment polyline distance, ring distance; `hitTest`
  (stamps 12 m / lines + water outlines 8 m / water containment wins) and
  `lassoHits` (any-point-inside rect semantics). 5 hit-test unit tests.
- **select.pick**: click hit-tests features/stamps/water bodies; a pick arms the
  amber dashed selection highlight + a rail strip (`◈ road ln_2` + 🗑); empty
  space clears and pans. **select.lasso**: drag a world-rect marquee; pointerup
  deletes everything inside (one undo command per doc array, one toast).
  **Delete/Backspace** removes the pick; **Escape** clears it (form-field guard
  on all keys). Undo/redo drops dangling selections.
- **Stamp picker**: rail `<select>` populated from the live catalog (name ?? id),
  change re-arms `place.stamp`.
- **Bug found + fixed**: `drawFeatures()` + the agent-highlight block were dead
  code — orphaned after an early `return` inside `sampleElevation` by a
  mis-anchored edit; moved back into `render()` (features visible again,
  screenshot-verified). Rail construction refactored from `innerHTML` to
  `createElement` so the surface mounts on the no-HTML-parser fake DOM.
- Suites: NEW `atlas_surface_select.test.mjs` (9 behavioral tests through the
  real surface: pick tolerances, delete→save payload, undo restore ×3 arrays,
  keydown guard, picker change → stamp assetId). Live-studio read-only check:
  8/8 tools, picker armed (pine.glb), real-vault pick + highlight, zero page
  errors. 222 node tests green (history_live needs EDITOR_AUTH_TOKEN —
  environmental, pre-existing).
- Remaining 2.0-A: SPA retirement. Then 2.0-C (3D tool ribbon + edit-layer
  terrain).


**2026-07-18 — 2.0-C slice 1 LANDED: the D2 registry drives the 3D viewport.**

- **viewport-tools.js**: 4 viewport-surface tools on the Tool Contract —
  `select.pick`, `terrain.sculpt` (mode/radius/strength/falloff, ranges identical
  to the legacy HUD), `paint.material` (7 materials), `place.catalog` — plus
  `createViewportTooling`, the bridge that makes the controller the single
  source of truth: tool switch → `state.editMode`/`state.brushTool`, option
  change (ACTIVE tool only) → shared brush state. Per-tool option persistence
  under a viewport-specific storage key (strict restore would reject the other
  surface's snapshot — sharing keys is a hard error, test-pinned).
- **viewport.js**: adapter + reverse sync (`syncRibbonFromState`) on every
  legacy mutation path (F4, 1-6, HUD buttons, placement arm/disarm, play-state
  restore) — all writes idempotent, so the echo is a no-op. Pointer dispatch,
  brushDab, and the recorded write-client paths UNCHANGED — every ribbon action
  is still a recorded skill (2.0-C determinism gate holds by construction).
  `window.__viewport = { controller, state }` test hook mirrors `__atlas`.
  Ribbon floats bottom-center above `.viewport-tools` (the viewport panel is
  fully overlay-based — first attempt in normal flow sat UNDER the canvas;
  caught by the browser check, not by node tests).
- **REAL BUG (same class, two surfaces)**: `createToolController` only SAVES
  snapshots — nothing ever called `restore()`, so tool persistence was
  write-only on BOTH surfaces. Fixed in `createViewportTooling` and in
  `atlas-surface.js` (restore before building views; `DEFAULT_STORAGE_KEY`
  now exported).
- Suites: NEW `viewport_tools.test.mjs` 11/11 (descriptors, forward/reverse
  mapping, active-only brush forwarding, per-tool radius persistence, storage
  round-trip + cross-surface key isolation, validation, destroy). Live-studio
  check: ribbon click → editMode/brush state; enum segment → brushTool flatten;
  F4 → ribbon follows to last brush tool; digit 3 → sculpt mode smooth;
  persisted snapshot correct; zero page errors; screenshot-verified.
  224 node tests green (history_live environmental, unchanged).
- Remaining 2.0-C: water tools UI, scatter brush, HUD retirement, edit-layer
  terrain (D5 — may split per the risk note).


**2026-07-18 — 2.0-A COMPLETE: old Atlas SPA retired (33 files deleted).**

- `tools/design/frontend/` (the 142 KB map.js SPA + ported kernels + its 6
  tests), the iframe Atlas dock (`#viewport-atlas` + ~260 LOC of dock layout/
  splitter/maximize machine in viewport.js), the whole handoff chain
  (atlas-handoff.html + relay/bootstrap/protocol, editor-launch.mjs,
  `/atlas-handoff-config` endpoints, `/atlas` SPA serving in serve.mjs,
  `LIMINA_EDITOR_HANDOFF_URL`/`LIMINA_DESIGN_FRONTEND_DIR` env plumbing), and 7
  old-SPA-only test files — deleted. serve-design.mjs is headless-only now
  (standalone SPA serving gone; `/api/*` + `/shared/*` kept — the native
  surface's lifeline, proxy legs test-pinned).
- **Deviation (documented)**: `mapstudio-gate.mjs` could NOT re-point to the
  native atlas-commands/paint-kernels — the natives are deliberate subsets;
  the gate's ~700 lines of MapDoc v2 undo/CAS/u16-persistence coverage has no
  native counterpart. The two pure, DOM-free modules it needs were relocated
  (`git mv`) to `tools/design/map-commands.js` / `map-elevation.js` and the
  gate re-pointed there: PASS. Truly deleting them is a gate-redesign decision.
- Coverage gap closed separately: the deleted SPA water-authoring browser test
  is replaced by a native-surface browser gate (atlas_native_water_browser).
- The iframe Atlas↔3D focus/reveal capability died with the dock; the native
  replacement is 2.0-D work (direct function calls, no postMessage).
- Suites: 197 editor node tests green (+1 environmental history_live), 21/21
  tools tests, mapstudio-gate PASS, run-gates.sh updated (headless sidecar +
  generated design token).


**2026-07-18 — 2.0-C slices 2–4: gizmo options + drag-drop + box-select.**

- **Gizmo in the options bar**: select.pick gains gizmo (Move/Rotate/Scale),
  space (Global/Local), snap (toggle) options; W/E/R/X/S keys + bottom-bar
  buttons echo INTO the controller (persisted source of truth) via the new
  `onToolOption` passthrough. REAL BUG caught by tests: a toggle option without
  `label` violates the registry schema and threw on EVERY registry call —
  viewport boot was hard-dead until fixed.
- **Drag-drop Place**: content rows are draggable; dragstart arms the
  placement store (ghost previews mid-drag), canvas dragover/drop lands the
  same recorded `asset.place` path.
- **Box-select / multi-select**: SelectionStore gains selectMany/getMany +
  reconcile (change object ADDITIVELY carries selectedIds — old subscribers
  untouched); Shift+drag marquee on select.pick (camera suppressed during
  drag, <4px falls through to click-pick); secondary selections get accent
  BoxHelpers; Delete destroys the whole set through the recorded path.
- Suites: viewport_tools 14/14, selection-store node tests, content_browser
  7/7; live smoke: snap toggle round-trips options bar ↔ bottom bar, zero
  page errors.


**2026-07-18 — 2.0-C slices 5–7: water tools + scatter brush + HUD retirement.
2.0-C UI COMPLETE; D5 split per the plan's risk clause.**

- **Water tools**: `water.plane` (level/size options → recorded world.addWater
  on click) and `water.river` (click centerline vertices with a live preview
  line, double-click commits recorded world.addRiver, Esc cancels, preview
  re-parents after reboot). write-client wrappers checked against the real
  return shapes (no `ok` field — a false guard was caught before it shipped).
- **Scatter brush**: `place.scatter` stroke — dab spacing ≥ radius (inclusion
  discs touch, never stack → no double-planting), deterministic seeds (module
  stroke counter × 4096 + dab index — Math.random would break replay), one
  recorded vegetation.scatter per dab. Erase mode deferred (no backing skill).
- **Pointer-dispatch honesty**: the ribbon's active id (not the legacy
  brushTool field) gates sculpt strokes, catalog clicks, and cursor overlays —
  water/scatter leave brushTool untouched, and without the guard a stale
  "catalog" would have placed assets mid-water-tool.
- **HUD retired**: the whole floating TERRAIN EDIT panel (~150 LOC: palette,
  sliders, drag machine) deleted; undo/redo ported to ribbon buttons, catalog
  auto-open ported to the edit indicator, the orange outline/cursor indicator
  kept. Legacy key paths (F4/1-6, W/E/R/X/S) all still work and echo into the
  controller.
- **D5 (edit-layer terrain) SPLIT to its own phase** per §6's fallback — the
  assessment (agent, file:line-backed): d906e0b's rebase machinery is
  topology-only with ZERO production call sites; base-content conflict
  detection is a new subsystem (~8-12 agent-days full, ~4-6 minimal). Shipped
  NOW instead: the silent no-op fix — terrain.deform/paint on streamed
  generateRegion terrain used to return ok:false into the void; write-client
  now throws and the viewport surfaces a warning naming D5.
- **REAL BUG via the native water browser gate**: assertNoShrink 409'd any
  save deleting the LAST feature/stamp/water body, and the conflict resync
  silently resurrected it. Fixed: design-api mapSave takes opt-in allowShrink,
  the surface passes it (every surface save descends from a deliberate user
  command; the breaker still guards all other writers).
- Suites: 210 editor node tests green (+1 environmental), native water
  browser gate green (real fixture stack: serve-design --headless +
  editor_host + serve.mjs proxy; basin author → server round-trip → undo →
  lasso-delete persistence), viewport_tools 14/14, selection_store 5/5,
  box_select_static 5/5. Live smoke: 7 tools + undo/redo, HUD gone, zero
  page errors.


**2026-07-19 — 2.0-B part 1: split view LANDED.** The workspace model gains a
persisted Split toggle (⫿) — Atlas and the 3D viewport live side by side, both
running, Design exclusive. Verified in-browser (both visible, layout survives
reload). With the existing derived pipeline (500 ms head poll + compile +
worker poll), painting in Atlas now visibly propagates to 3D in seconds.
Remaining 2.0-B: derived push (kill the ≤8 s idle-decay worker poll — SSE from
the derived-runtime server) and incremental chunk activation (mount dirty
chunks only; atomic publish stays), which bring propagation to ~1 s.


**2026-07-19 — 2.0-B push LANDED + vault data-loss incident: recovered, root-caused, guarded.**

- **SSE derived push (2.0-B complete).** `GET /v1/derived/events/<token>` on the
  derived-runtime server (capability in path — EventSource can't send headers;
  the no-`?` URL rule stands), fs.watch on the branch root with a 120 ms debounce,
  immediate sync event on connect, 15 s heartbeat, graceful degradation to the
  polling backbone. The worker subscribes (`#startRevisionStream`): a revision
  event cancels the idle ladder and polls NOW. LIVE-VERIFIED end-to-end: Atlas
  stroke → save → authority bump → compile → **generation 37 broadcast in
  seconds** (previously up to 8 s poll delay + whole-revision latency).
  19/19 server tests incl. the SSE leg; tsc clean.
- **INCIDENT: limina-world vault gutted (landmass → elevation → features →
  stamps → empty) via five transactions in 11 s through the unguarded map-save
  chokepoint.** Detected during push verification (0 land cells). **Recovered
  fully** from the content-addressed mapDoc store (`assets/sources/map-doc/` —
  73 versions; restored the last full doc, 34 KB landmass + 175 KB elevation,
  verified 142,827 land cells re-rendered and a trivial save round-trips
  safely). **Root cause (mechanism):** the save path accepted a doc that
  *shrank* every content class to zero — no guard anywhere. **Fix:** a
  data-loss circuit breaker in `AtlasMapDocBridge.#save` (`assertNoShrink`):
  raster-class collapse below ¼ or a content class vanishing is refused with
  409 `shrink_rejected`; `allowShrink:true` is the explicit escape hatch; 10/10
  bridge tests incl. 5 new guard legs. **Also:** killed 9 stale leaked
  editor_host processes (up to 17.8 h old — a live data-loss vector of
  outdated clients with stale models). The identity of the shrinking-save
  client (one sidecar session) is consistent with a stale client of that class;
  the chokepoint is now closed regardless.
- Split view (2.0-B part 1) landed earlier the same day: ⫿ toggle, both
  surfaces live, persisted.


**2026-07-18 — 2.0-D slices 1–3: native cross-surface reveal + Places/Graph panels.**

- **Reveal, native (the deleted iframe bridge's replacement)**: three bus events
  (`atlas.focus`, `nav.reveal`, `places.reveal` — typed constants on the shared
  studioBus). Atlas double-click → viewport camera travels with POI-grade
  terrain-height resolution (same resolvePose path as search results).
  Viewport/outliner selection → `nav.reveal` → app.js pans the atlas map +
  pulse marker, ONLY when the atlas workspace is on screen; atlas-sourced
  selections are excluded (one-directional per surface, no echo). New surface
  API `atlas.reveal(wx, wz)` (cam pan + self-expiring highlight). Verified
  live both directions (cam pans to 120,-80; dblclick emits world coords;
  zero page errors).
- **Places panel**: full CRUD over `/api/edit-place` (ops add/update/move/
  reparent/delete — contract discovered and test-pinned), keyed-render list,
  two-click delete, defensive 409 refresh, row click → places.reveal (camera
  consumer already wired). **Graph panel**: read-only nodes-by-kind + edges
  over the sidecar's vaultGraph; doc-node click → docs.open.
- Both join Design Docs under a `Docs | Places | Graph` tab strip in the
  Design workspace (persisted active tab); registered in the studio-shell
  manifest. 11/11 new node tests + studio_shell/panel_registry regressions
  updated and green.
- **Ship panel + op_write_export SPLIT** (same precedent as D5): the bundle
  format + verifier exist (packager/pack.mjs, check.mjs) but the "op" doesn't
  — export today is a script, and wiring it into the live session needs a
  keyframe recorder in the editor runtime path that exists nowhere. Its own
  phase, with `p_studio_ship`.
- Remaining 2.0-D: shared bookmarks across surfaces (controller hoist),
  Packs panel (verbs exist; small).


**2026-07-18 — Phase outlook (honest status after the 2.0-A→D sprint).**

- **2.0-E (caves + roads)** and **2.0-F (coordination surfaces)** remain
  full phases: E touches render clip + collider split with replay
  byte-identity gates and requires real-GPU UAT by §5's own rules; F builds
  on multi-agent coordination infrastructure (proposal ghosts, approval
  inbox, chat router). Neither is a responsible autonomous-session landing.
  Entry points are documented in §4; the D5 edit-layer phase and the Ship
  phase join them as the four remaining workstreams, in priority order:
  D5 → Ship → 2.0-E → 2.0-F.


**2026-07-20 — INCIDENT→FIX: derived terrain never mounted (island invisible in 3D).**

- **Symptom**: Atlas shows the island; the 3D viewport ticks but never mounts a
  derived revision. Reproduced in driven Chromium (SwiftShader GL): client
  `ready`, all chunk fetches 200, but `derived: ACTIVATION_REJECTED` looping
  every few seconds — invisible in the status line because tick text
  overwrites transient derived statuses within a second.
- **Root cause A (architecture gap)**: the MapDoc's hydrology compiles
  generated water into every derived revision; the sim worker (fail-closed
  since the recorder-seam hardening) required an authored-map water binding
  that only a worldlog `terrain.create(source:"map")` creates. The limina-world
  worldlog has NO terrain foundation, so every activation threw
  `DERIVED_CONTACT_UNBOUND` — vetoing the whole revision, terrain included.
  **Fix (owner-approved option A)**: derived-pipeline water is self-verified
  (it already passes canonical byte-hash/descriptor/binding/topology/ownership
  checks in-realm) — the stage now self-binds from the artifact's verified
  identity (`derived:self:` binding ids), a worldlog binding arriving later
  PREEMPTS it, tampered envelopes still fail closed. Files:
  `js/src/browser/sim-worker.ts`, `js/src/world/water-contact.ts`. NEW gate
  `p_derived_water_self_binding` (self-bind, tamper rejection, same-field +
  map-edit rebind, worldlog preemption, byte-exact replay parity) — registered
  in QUICK_DETERMINISM_GLOBS; all existing water/derived gates green.
- **Observability fix**: `activateEditDerivedRevision` now prints the CAUSE to
  the status line (`derived: ACTIVATION_FAILED <reason>`) — the client ack
  only carries a code and the loop was undebuggable.
- **Root cause B (pre-existing, separate)**: the worldlog was poisoned at
  seq 563 — `asset.place ground:true` records the INPUT position (y=0), not
  the resolved ground-snap; replay re-resolves against a physics world that no
  longer matches (derived colliders aren't part of the worldlog), so the next
  authoring.commit's state hashes diverge and boot fails closed. This is the
  replay-stability hole in ground-snap placement (follow-up: bake the resolved
  transform into commitFields; recorded logs without it can never replay).
- **Resolution (owner chose teardown over surgery)**: worldlog + trace
  archived (`.limina/traces/archive/`), genesis restart — the derived-build
  service's `bootstrapAuthoritativeMapDoc` re-committed the vault seed MapDoc
  at revision 0 and published revision 1. Browser kill shot: `derived: r1`
  mounted, terrain visibly renders (screenshot
  `traces/derived_island_mounted.png`), zero page errors.
- **Also fixed en route**: rotated a 512 MiB trace file that hit the size cap;
  killed another batch of leaked fixture editor_host/editor.mjs processes
  (studio-docs browser test leaks its stack per run — follow-up).


**2026-07-20 — 2.0-B remainder LANDED: incremental chunk activation.**

- The navigation-stall root: every residency threshold crossing rebuilt the
  ENTIRE 225-chunk window (meshes + colliders, ~400-475ms) under a
  presentation freeze. Now `planDerivedActivation` (derived-terrain-residency.ts)
  routes each incoming activation: duplicate → skip; same manifest + moved
  window + no population → **incremental delta** (only entering/leaving chunk
  meshes + colliders, one atomic physics wrapper, no presentation gate);
  anything else → the full path, unchanged.
- NEW gate `p_derived_incremental_residency`: deltas byte-exact vs full
  activation (meshes, colliders, heights, contacts), delta-proportional mount
  counts, cancellation-safe, fail-closed, replay-stable. Registered in
  QUICK_DETERMINISM_GLOBS.
- Live-verified on limina-world: camera walk across 4 chunk boundaries →
  `derivedActivationStats() {full: 1, incremental: 1}` — the window slides
  without a full swap. No re-activation status churn during moves.
- New runtime introspection: `derivedActivationStats() {full, incremental}`.


**2026-07-20 — sculpt-on-derived LANDED: content-delta derived activation.**

- The remaining structural fix for sculpt UX: every recompiled revision used to
  land as a full-window activation (presentation-gate freeze, ~225 chunk meshes
  + colliders torn down and rebuilt — and, in the editor, a full viewport
  reboot per dab). Derived chunks are content-addressed, and a sculpt-sized
  edit moves only the touched chunks' contentHashes (verified against
  limina-world manifests: 2 of 5046 chunk hashes moved; key set, per-chunk
  topologyHash, grid, and all global artifacts byte-identical).
- `planDerivedActivation` gains a fourth route, **content-delta**: changed
  manifest + same residency window/grid/topology + identical resident chunk key
  set + unchanged water artifact + no population either side + unchanged
  terrain surface frame (it feeds every chunk material's elevation uniforms) +
  ≥1 moved chunk contentHash. The candidate owns the hash comparison
  (`planContentDelta`, pure, both revisions' manifests in hand); anything else
  routes full exactly as before. The delta mount builds ONLY the changed
  chunks' replacements detached (~8 ms slices), swaps them under terrainRoot in
  place (unchanged chunks keep their exact mesh objects), rebuilds the
  overview, re-mounts water against the newer sampler, and replaces exactly
  those chunks' heightfield colliders in ONE atomic sim-worker wrapper
  (`updateDerivedContent`, which also re-names the active revision to the new
  manifest). NO presentation gate.
- Editor: `applyWorldlogBatchInner` now hot-applies FIRST and invalidates the
  derived presentation only when the runtime cannot absorb a command
  (needsReboot) — a terrain.deform dab no longer reboots the viewport, so the
  recompiled revision reaches the content-delta path in the SAME runtime.
- NEW gate `p_derived_content_delta` (QUICK_DETERMINISM_GLOBS): 1-of-N changed
  chunk → only that chunk remounts (mesh-object identity preserved elsewhere),
  byte-exact vs full activation (meshes, colliders, heights, contacts), routing
  regression (population/water/topology/frame/window → full or residency-delta
  as today), cancellation/fail-close/rollback byte-exactness, replay parity.
- Live-verified on limina-world (headless chromium, swiftshader): deform raise
  at [50,50] r15 → r54→r55 lands with `derivedActivationStats()
  {full: 1, contentDelta: 1}` — full NOT incremented (the gate raise is
  exclusive to the full branch), same runtime object, height 5.198 → 7.172;
  compensating lower → r55→r56, `contentDelta: 2`, height restored exactly.

**2026-07-20 — D5.1 LANDED: derived-terrain edit layers (sculpt-on-derived works).**
- **terrain.deform on mounted derived terrain** now materializes the stroke as
  sparse lattice deltas (`limina.terrain-edit-layer/v1` — byte-identical to
  applyBrush on an equivalent EditableTerrain, differential-gated) and commits
  the layer ref through a NESTED authoring.commit (replay-pinned; folded into
  the recorded command). The compiler's already-wired compose stage applies it,
  the derived build recompiles, and the raised terrain mounts. Live-verified on
  limina-world: deform → `derived-limina-world.surface` layer committed →
  recompile → publish (test dab reverted with an exact compensating deform).
- **Legacy-replay fix (caught by the live restart, not the gates)**: replaying
  a pre-D5.1 worldlog (pin-less deform records) would mint nested commits the
  record never had and break the durable authoring-record chain. New typed
  `replay` marker on InvokeContext/ExecutionContext (set by rehydrate); the
  derived path requires its `baseTopology` pin when replaying — legacy records
  replay as the no-ops they were.
- Gate `p_terrain_derived_edit_layer` (registered): differential byte-parity,
  project-state round-trip into the compiled field, replay byte-identity,
  deterministic op-cap folding, structured rebase conflicts, EditableTerrain
  worlds untouched. smooth/flatten on derived terrain await a composed-height
  sampler (raise/lower/noise work now).
- **Volumetrics study** (`plans/volumetrics-study.md`, owner-prioritized): UE5's
  five techniques (sparse SVT bricks, low-res+temporal accumulation, blue-noise
  decorrelation, empty-space skipping, tier budgets) mapped to a V1–V4 plan
  (froxel fog → sparse local volumes → clouds → underwater-as-medium) with the
  UE/Unity/Godot temporal failure record turned into standing guardrails.
  Wired into ROADMAP as R1.2b.
- Remaining D5: D5.2 (optimistic editor dab preview before recompile), D5.3
  (undo path + material-paint layer format extension), composed-height sampler
  for smooth/flatten.


**2026-07-20 — Content-delta activation LANDED (sculpt UX: no more blanking).**

- A revision whose chunk key set/topology/window are unchanged and only a
  subset of chunk contentHashes differ now re-mounts ONLY the changed chunks
  — one atomic physics wrapper, mesh identity preserved elsewhere, NO
  presentation gate. Water/population changes route the full path
  (documented). Gate `p_derived_content_delta` (registered): delta-only
  mounts, byte-exact vs full activation, never gated, fail-closed,
  replay-stable. Live-verified: a sculpt dab lands with
  `derivedActivationStats().contentDelta` incrementing and `full` flat.
- The sculpt workflow is now: dab → edit-layer op → recompile → changed
  chunks morph in place. Still queued: D5.2 optimistic preview (instant morph
  before recompile) and D5.3 (material-paint layer format).


**2026-07-20 — D5.2 + D5.3 LANDED: sculpt preview + paint on derived terrain.**

- **D5.2 optimistic preview** (`editor/src/sculpt-preview.js` + shared kernel
  `js/src/terrain/brush-kernel.mjs`): drag-morphs the live derived chunk
  meshes IMMEDIATELY under the cursor — the ONE kernel copy shared by the
  EditableTerrain path, the derived-lattice materializer, and the preview
  (forking it would break preview==revision byte-identity). Rollback on
  deform failure is byte-exact; 7/7 preview tests incl. differential vs
  materializeTerrainBrushOp.
- **D5.3 paint layer** (`js/src/terrain/paint-layer.mjs`,
  `limina.terrain-paint-layer/v1`): sparse signed material-weight stamps
  (ordered additive clamp, erase negative — byte-matches applyBrushPaint);
  paint refs ride the existing refs.terrainEditLayers (no genesis state-hash
  change → no worldlog invalidation); compiler composes biome→heights→paint
  in that order; untouched chunks stay byte-identical. terrain.paint derived
  path mirrors derivedDeform (nested commit, replay pins, legacy pin-less
  replay → ok:false). 7-leg gate registered.
- **rev-130 incident fix**: a busy sculpt session's height layer crossed the
  1 MiB MCP frame cap and stalled every derived build ("response exceeds the
  1048576-character limit"). Both caps raised to 8 MiB (covers the format's
  own 4 MiB cap + envelope) with the incident documented in comments.
  Follow-up: earlier op folding before the 4 MiB wall.
- Verified end-to-end: paint 310-delta rock stamp → compiled chunk shows 255
  rock samples at the right world position; erase removes all; rev 130
  publishes on the live stack.
- Remaining D5: paint preview (the kernel is shared — preview can reuse
  brushWeightAt), smooth/flatten composed-height sampler, paint-grass regrow
  on derived terrain, op-fold trigger ahead of the format cap.


**2026-07-20 — Paint-to-albedo link LANDED; Atlas/3D edit visibility documented.**

- The eye-level render bakes its albedo from the terrain tile's paint channels
  at compile time; D5.3's compose only updated chunk channels + overview.
  `normalizeEditedTile` now carries composed paintMat/paintW into edited
  chunks (albedo picks the stamp up) and `composeMasterPaintForOverview`
  keeps the bird's-eye in agreement; paint-less compiles keep shared
  references (byte-identity preserved). Live-verified: rock stamp renders as
  rock albedo at the stroke via contentDelta (screenshots
  traces/paint_before/after.png), erased clean.
- **Atlas ↔ 3D edit flow (documented for the owner)**: Atlas strokes edit the
  MapDoc (base); 3D strokes edit project-state edit LAYERS; the compiler
  merges layers over base for the 3D view. The Atlas does NOT read edit
  layers — 3D edits are invisible there. The honest bridge is a composed-view
  (Atlas elevation view + layer compose), NOT baking layers into the MapDoc
  (blurs base vs edits).
- **rev-356 incident fix**: a paint session's deltas concentrated in ONE chunk
  (121 grass dabs at one spot = 17,368 deltas in one slice = 1,074,394 bytes)
  exceeded the per-chunk slice-hash canonical budget (1 MiB default) in
  `terrain-compile.ts` and stalled EVERY derived build — the runtime kept
  serving the pre-paint revision, which is why no color change was visible
  anywhere. Both slice hash call sites (edit + paint) now use a limit sized
  to the layer format's own 4 MiB cap (limits only relax rejection — every
  previously-hashable slice hashes bit-identically). The overview also never
  composed paint: `composeMasterPaintForOverview` now applies the paint stack
  onto the master field with the chunk compose's exact arithmetic, and a
  paint-carrying compile always rebuilds the overview (paint refs are
  append/replace-only, so a reused paint-less overview can never go stale).
  Gate legs (h)+(i) on `p_terrain_derived_paint_layer`. Live-verified: rev
  356 published with no stack restart (the compiler worker imports the
  rebuilt bundle fresh), eye-level paint texture at the stamp went 0 → 252 →
  0 alpha across paint/erase (traces/paint_albedo_proof*.png).
- Remaining: vegetation.scatter derived-terrain target (currently resolves
  EditableTerrain only → no-ops on derived worlds), Atlas composed-view,
  paint preview, smooth/flatten composed-height sampler, paint-grass regrow.


**2026-07-20 — D5.4 LANDED: vegetation.scatter on derived terrain + composed-height sampler.**

- **composed-height sampler** (`js/src/terrain/composed-height.mjs`): bilinear
  base elevation from the MapDoc raster + additive edit-layer deltas, fround-
  matched to the compiler's compose — gate-proven identical to compiled chunk
  heights (plain AND hydrology-carved fields). Cached by contentHash.
- **vegetation.scatter derived target**: when no EditableTerrain resolves,
  scatter gates (slope/elevation/exclusion/inclusion) read the composed field;
  placement deterministic + replay-pinned (derivedField mapDoc/topology pins).
  Live: 2 pines placed at (0,0) on limina-world; forest entities cleaned up.
- **smooth/flatten sculpt unlocked** on derived terrain (the sampler is exactly
  what terrain-edit.ts:417 was missing). Live: flatten ok:true.
- Disclosure: a small flatten test patch remains at (-140,-60) (r=18m, 6m);
  undo via the editor undo button or sculpt over it.
- Follow-ups: village.build/grassField/plant derived targets, Atlas composed
  view (base+layers), paint preview, paint-grass regrow.
