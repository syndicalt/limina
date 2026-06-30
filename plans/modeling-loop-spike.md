# Geometric-Modeling Loop — spike

## Why (the method that failed)

Hand-coding box geometry + per-part rotation/position trig, then confirming by a slow flaky native
window capture, **does not converge.** It shipped exploded walls (rotation written to the mesh, not
the ECS) and floating roofs — defects neither of us caught until a screenshot an hour later. The
references are good; the *loop* is broken: no tight feedback, authoring at the wrong altitude (raw
trig), and verifying **by eye instead of by assertion.**

A floating roof is a *measurable* defect (`roof.eaves.y === wall.top.y`). It should fail a test in
milliseconds, not survive to a render you have to spot.

## The substrate (build this BEFORE more geometry)

Four pieces, in dependency order:

### 1. Declarative building/asset RECIPE + a tested assembler  *(author altitude)*
Stop emitting boxes with inline trig. The agent emits a **recipe** — declarative parts:
`{ walls: [...], openings: [{wall, kind:door|window, w, h, sill}], roof: {type:gable|hip|conical, pitch, overhang}, props: [chimney...], rotation }`.
A **single tested assembler** turns the recipe into entities, owning ALL transforms once (the place
rotation/position math is written + tested in exactly one spot, not per call site). The assembler is
the only thing that touches `spawnStaticMesh`; the recipe never does trig.

### 2. Structural-assertion gate  *(headless, instant — the missing piece)*
Run on the assembled parts via the `limina` binary, no render. Invariants:
- **No float / connectivity:** every wall's base sits on the floor; the roof's eaves meet the wall
  tops (`|roof.eaves.y − wall.top.y| < ε`); no part hangs in空.
- **Openings clear:** each door/window opening is genuinely empty (no solid box in it) and flanked by
  jambs (we already assert this for doors in `p15_architecture`).
- **Enclosure:** walls form a closed ring (corners meet, no gaps > ε).
- **Bounds + rotation:** the AABB matches the footprint; a rotated building's parts are a rigid
  transform of the unrotated one (catches the exact bug we just hit).
This gate is the highest-leverage thing here — it would have caught **every** bug so far before render.

### 3. Fast headless render+inspect  *(the feedback substrate)*
Reuse the **SwiftShader path that already works** (`editor/test/*` harness: software WebGL2 in headless
Chromium, no window, no stacking lottery, instant + deterministic, screenshot reliable). Render the
ONE assembled building from canonical angles (3/4 hero + front + a turntable frame). This replaces the
10-second native `spectacle` capture-and-pray with a sub-second deterministic image I can view.

### 4. The modeling LOOP  *(on top of 1-3 — mirrors `eyes/self_correct.ts`)*
```
recipe ──► assemble ──► [STRUCTURAL GATE] ─fail→ fix recipe/assembler (no render, instant)
                              │ pass
                              ▼
                    headless render (canonical angles)
                              ▼
              critique vs the card's reference image  (silhouette / proportions /
              features present / material read → structured deltas)
                              ▼
                    refine recipe ──► (loop until it reads like the ref)
                              ▼
              card status: verified · recipe saved (deterministic, replayable)
```
The structural gate runs EVERY iteration (cheap); the render+critique runs when structure is sound.

## What this reuses (little is new)

- **Render:** the `editor/test` SwiftShader harness (proven) — point it at a building.
- **Loop shape:** `eyes/self_correct.ts` `refineVisual` (author→render→critique→refine→converge).
- **Targets:** the `art-direction/library` cards (image + descriptors + buildability + engine_gaps).
- **Door-clearance assertion:** already in `p15_architecture` — generalize to all openings.
- **Determinism:** recipes are data → the assembler is pure → replay is free.

New: the recipe schema + assembler, the structural-assertion harness, the multi-angle render glue, the
visual-critique step.

## First proof (lock the machine on one card)

`cottage` end-to-end: a cottage **recipe** → assembler → **structural gate green** → headless 3/4
render → compare to `art-direction/library/buildings/medieval/dwelling/cottage/cottage-2.jpg` →
iterate the recipe (roof pitch, window grid, half-timber bands, chimney) until it reads. Only then
generalize to longhall / watchtower (conical roof = a new roof type in the recipe, asserted the same
way).

## Build order

1. **Structural-assertion harness** + invariants (catches today's class of bugs). *Highest leverage —
   do first.*
2. **Recipe schema + tested assembler** (transforms in one place; `architecture.building` becomes a
   thin recipe→assembler call).
3. **Headless single-building render** (SwiftShader, canonical angles).
4. **The loop** + the cottage proof.

## Decisions for the user

- **Author representation:** declarative recipe (parts + openings + roof type) — my rec — vs. a
  lower-level mesh-edit DSL. Recipe is simpler + replay-clean; DSL is more expressive but heavier.
- **Critique:** me viewing render-vs-ref each iteration (works today) vs. wiring a vision model so the
  loop runs unattended. Start with me-in-the-loop, swap a model in later.
- **Scope of proof:** cottage only first (lock the machine), then generalize — vs. build for 3 building
  types at once.
