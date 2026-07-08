# Limina — Operating Manual

Limina is an agent-native 3D engine: Rust host → V8 (`deno_core`) → Three.js WebGPU → native Rapier → bitECS, driven by typed, permissioned, **recorded** skills. A world is a pure function of `(seed + command log + snapshots)`. That sentence is load-bearing: almost every rule below exists to protect it.

Read this whole file before your first edit. The rules here override your defaults. When a rule here conflicts with what seems expedient, the rule wins; if you believe the rule itself is wrong for the task, stop and ask (see §7).

---

## 1. Orientation

| Where | What |
|---|---|
| `crates/` | 7 Rust crates (`limina-runtime/-ecs/-render/-physics/-audio/-ops/-sandbox`). `cargo build --release` → `./target/release/limina`. |
| `js/src/skills/` | The ~85-skill catalog. Every mutation flows through `skills/registry.ts` (`SkillRegistry.invoke`). |
| `js/src/kernel/` | `applyAuthorCommand` — the ONE apply seam for human/agent/replay commands. |
| `js/src/worldlog/` | Determinism machinery: seeded RNG, recorder, JSONL log, snapshots, replay. |
| `js/src/game/` | Game-director pipeline (GDS → plan → coordinator → gate → publish) + direct-path runtime. |
| `js/test/pNN_*.ts` | The functional gates (~267). Run one: `LIMINA_AUDIO=null ./target/release/limina js/test/pNN_x.ts`. |
| `gates/design/` | Executed design gates: asset-qc, silhouette (anti-oatmeal), style-conformance, GDS. |
| `tools/` | Host-side authoring (bun). Blender scripts, GPU screenshotter, director, QC, preview harnesses. Never imported by the engine. |
| `editor/` | Web editor. `editor/src/*.js` served un-bundled; the engine inside it is a **prebuilt bundle** (`editor/vendor/`, gitignored). |
| `brain/` | Design craft knowledge (vendored gamestack skills + limina overlay). `brain/shared/GATE.md` is the review-verdict contract. |
| `assets/`, `art-direction/` | GLBs + `.card.json` sidecars + `catalog.json`; reference-image library (untracked by design) + `fidelity-floor.json`. |
| `plans/`, `docs/` | Phase plans (authoritative: `plans/ROADMAP.md`, `plans/post-mvp-roadmap.md`). |

Environment facts:

- **No root `package.json`.** JS scripts: `js/package.json` (npm). Tools: `tools/package.json` (bun). Site: `site/` (npm, separate Astro app).
- **No tsconfig, no tsc, no eslint/prettier.** TS runs untranspiled on the host's V8. "Type-clean" means `deno check` reports no new errors anchored to files you changed.
- TS imports use explicit `.ts` extensions; `zod` and `three` come from `js/build/*.bundle.mjs`, not node_modules.
- Blender 5.1.2 lives at `~/blender-5.1.2-linux-x64/blender` (override with `BLENDER_BIN`). Asset-fetch API keys (`POLY_PIZZA_API_KEY`, `THREEDAI_API_KEY`) live in the gitignored root `.env`; the Bash tool's shell does not inherit exported vars — keys must be in `.env`.
- If Zaxy MCP memory tools are available, follow the activation ritual in `AGENTS.md` before substantial work. If they are not available, note that and proceed — do not block on it.

---

## 2. The paradigm — cardinal rules

These were each earned through a serious failure. Violating them is the worst thing you can do here.

1. **Everything through the engine — never hardcode around a system.** If the engine has a system that does X (`village.build`, `terrain.create/deform`, `vegetation.scatter`, the layout planner, `asset.place`), you author THROUGH it. Never replace a working system with hand-typed one-off calls or hardcoded coordinates. If the system lacks a capability, **extend the system** — that is in scope; sidestepping it is not.
2. **Agents author assets; the engine consumes them.** The engine must never become a modeler (no parameterized building generators — that shipped broken walls for every input). A build agent authors each asset as a whole bespoke artifact (Blender bpy script or bespoke Three.js) → bakes ONE GLB → the engine consumes it via `asset.place`.
3. **Build → bake → QC → import. Never assemble at placement.** Every asset is a standalone GLB *before* it enters any world, so it can be inspected and rejected as a discrete deliverable. Live assembly at placement time is how broken cottages slipped into worlds.
4. **Verify with eyes on the real GPU.** Visual claims require reading an actual render made with hardware GL (`--use-gl=angle`). SwiftShader is forbidden for pixel judgment — it cannot render shadows, caps instancing, and disagrees with the GPU. Never claim "verified" from a cropped or flattering angle; that lie has been told here twice and it destroyed trust.
5. **Every mutation goes through `SkillRegistry.invoke`** (directly or via an `AuthorCommand`). The recorder patches exactly that method; a bypass is an unrecorded, unreplayable mutation — a determinism bug by construction.
6. **Determinism is law in `js/src/skills/`.** No `Date.now()`, `new Date()`, `Math.random()`, `performance.now()` (lint: `js/scripts/check-determinism.mjs`; only `registry.ts` is allow-listed). `Math.random` is globally replaced by the seeded RNG. Nested skill invokes MUST forward `chainId: ctx.chainId`.
7. **Axis convention: NORTH = −z, EAST = +x** (right-handed, y-up). 2D map displays draw −z up. Vault files carry `"axes":"north-negz"`. A +z-north assumption renders maps mirrored — this shipped once.
8. **Ship capabilities as skills, not demo reels.** A one-off HTML harness that renders a pretty picture advances nothing. New capability = a registered, permissioned, recorded skill producing real world state, verified in the live engine. Preview harnesses are internal spikes only, never milestones.
9. **Asset authoring runs on the strongest model.** Craft judgment (proportion, silhouette, material read) IS the product. Delegate mechanical glue (cards, QC shots, test runs) to cheap tiers; never the modeling itself.
10. **Fidelity floor only ratchets up.** Target: modern Project Gorgon. Minimum for any render shown as progress: ≥ N64/Dreamcast (textured, detailed). `art-direction/fidelity-floor.json` never goes down without an explicit user override.

---

## 3. Conventions

### Code
- Match the local style: skill modules carry a top doc-comment banner stating their seam/invariant; zod schemas are the single source of truth for every skill's input/output; handlers are pure over `ctx`, side effects via `ctx.world.ops` and `ctx.emit`.
- Skill names: `system.verbCamelCase` (`asset.place`, `village.build`, `terrain.deform`).
- Adding a skill touches, in order: the skill module (`js/src/skills/<system>.ts`), registration in `js/src/skills/index.ts` (`registerCoreSkills`), permissions in `js/src/skills/permissions.ts`, discovery priority (or `DEFAULT_CORE` in `registry.ts`), and a `pNN` gate.
- Only `engine.ts` may touch `Deno.*` in browser-reachable code (one `typeof Deno` guard). `js/scripts/check-host-portability.mjs` enforces this.
- Comments state constraints code can't show. No narration, no "fixed by" notes.

### Commits & branches
- Format: `type(scope): subject` — `feat|fix|test|docs|chore|refactor`, scope = subsystem (`map`, `kernel`, `editor`, `village`, `npc`, …). Long subjects are fine; use `—` for a clarifying clause, `+` to bundle deliverables, trailing parens for phase/slice markers (`(Slice 5)`, `(Map Phase 3.1)`).
- Body: lead paragraph (problem → outcome), bulleted per-subsystem changes, closing `Gates green:` line naming the passing gates and any live-GPU verification. Co-author trailer per your model.
- **A commit is a vertical slice**: implementation + its gate/test + fixtures + proof assets (GLB + `.card.json`) + local READMEs together. Plans are updated in a separate `docs(...)` pass (append to the plan's `## Status & outcomes`).
- Branches: `feat/<slug>` `fix/<slug>` `docs/<slug>` `chore/<slug>`; `wf/<slug>` for integration branches. History is linear; the active trunk is a long-lived feature branch (currently `feat/gamestack-refactor`).
- Never commit: `art-direction/library/**` and `kit-evidence/` reference imagery, `.parked-*/` shelved subsystems, `quarantine/*.glb`, `traces/`, anything in a gitignored generated dir.

### Filing
- Shelve a whole in-progress subsystem → `.parked-<feature>/` at repo root (untracked).
- Research prototype → `spikes/<name>/` + a `plans/<name>-spike.md` write-up.
- Asset failing sanity/QC → move to `quarantine/`, log it in `quarantine/README.md` (asset, measured size, issue), repoint code.
- New phase plan → `plans/` using the house shape: Chunks A/B/C with rationale, `Sequencing (landable PRs)`, `Verification`, `Risks / open questions`, `Status & outcomes` (filled after).

### Writing voice & UI
- Plain and direct. No pitch-speak ("wedge", "moat", "bet"), no adjectives doing the work of evidence.
- UI: no explanatory clutter — no descriptor subtitles, exposed internal tool names, or jargon captions. The panel title carries the whole label.

---

## 4. Command crib sheet

```bash
# Build the engine (required before any gate/editor/tool that runs it)
cargo build --release

# Run ONE gate                       # Run the quick director set / everything
LIMINA_AUDIO=null ./target/release/limina js/test/p22_gate.ts
bash tools/director/run-gates.sh --quick        # p20–p27 + host gates
bash tools/director/run-gates.sh                # full sweep (long)

# Static guards (fast, no display)
npm --prefix js run check:determinism
npm --prefix js run check:portability
npm --prefix js run check:assets                # GLB sanity: DEGENERATE / OVERSIZE(>60m) / off-ground
node js/scripts/check-nested-invoke.mjs         # chainId threading

# THE AGENT'S EYES — real-GPU headless screenshot (never swiftshader for pixels)
node tools/shoot.mjs <web-root> <out.png> [wait-ms=4500] [selector=#limina-canvas]

# Blender authoring (offline build backend; engine only consumes the GLB)
~/blender-5.1.2-linux-x64/blender --background --factory-startup \
  --python tools/blender/<script>.py -- --out assets/<id>.glb
tools/rig/rig-character.sh <in.glb> <out.glb> [height]   # static humanoid → rigged Idle/Walk

# Asset fetch (library → generative fallback; judge results with a contact sheet, never the JSON)
bun run tools/asset-fetch.ts --kind <k> --prompt <p> --seed <n>

# Editor lifecycle (three different reload rules — see failure mode #8)
(cd js && npm run bundle:editor)                          # js/src changes → editor engine bundle
./target/release/limina editor/server/editor_host.ts      # restart host (prints auth token)
node tools/scaffold/scripts/serve.mjs editor 5173          # COOP/COEP static serve → localhost:5173
curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/assets/<some>.glb  # stale-server check
```

---

## 5. Named failure modes — and the rule that prevents each

Each of these has actually happened here. Check this list before acting; if what you're about to do resembles one, apply the rule.

**#1 The hand-placed village.** Replacing `village.build` with hand-typed `architecture.building` calls on a flattened disc → overlapping identical boxes, user furious.
*Rule: author through the system. If it lacks a capability, extend the system; never route around it.*

**#2 The engine-as-modeler.** Building a parameterized generator inside the engine to model buildings → broken walls for every input.
*Rule: a build agent authors each asset whole (bpy/Three.js → one GLB); the engine only consumes.*

**#3 The cropped hero shot.** Claiming "verified" from a flattering angle or a proxy metric (vertex counts), hiding see-through walls.
*Rule: full-frame renders, multiple angles, judged as shippable, on the real GPU. Report defects you see; showing a failure is cheap, shipping one is not.*

**#4 SwiftShader "verification."** Software rendering agrees with nothing: no shadows, capped instancing, false signals.
*Rule: pixel judgment requires `--use-gl=angle --use-angle=gl --enable-gpu --ignore-gpu-blocklist` (what `tools/shoot.mjs` does). SwiftShader is acceptable only for non-pixel logic/export gates.*

**#5 Gates built to pass.** Verdicts scraped from forgeable stdout; parity checks comparing only fields that are tautologically equal; error-text grepping that turned regressions into silent SKIPs.
*Rule: every new gate ships with a falsifiability check — prove it FAILS on a broken input (`gates/design/check.mjs` pattern, `p91`). Never weaken a threshold or edit a gate to make work pass.*

**#6 "ALL GATES GREEN" on a headless box.** `run-gates.sh --headless` (and CI) SKIPS the entire visual family — silhouette, design-gate, packager, dogfood, playable-smoke, browser gates.
*Rule: headless green proves logic, not look. Any visual claim additionally needs a real-GPU render you read.*

**#7 Editing generated files.** `js/build/*.bundle.mjs`, `editor/vendor/*`, `web/public/limina-runtime.js`, `bin/limina-mcp` are esbuild/install outputs.
*Rule: regenerate (`npm --prefix js run bundle:*`); never hand-edit. A fresh checkout has no `editor/vendor/` until you run `bundle:editor`.*

**#8 "My change didn't take effect."** Three reload rules: `js/src`/`editor/server` changes → restart `editor_host` (disk-loaded) AND `bundle:editor` + browser reload for the viewport; `editor/src/*.js` → browser reload only; Rust ops → `cargo build --release -p limina-runtime`; `js/00_bootstrap.js` is EMBEDDED in the binary → touch `crates/limina-render/src/lib.rs` to force the re-embed.
*Rule: identify which layer you changed before concluding the change is wrong.*

**#9 Wall-clock or RNG in a skill.** Fails `check:determinism`; worse, un-linted nondeterminism (the guard only scans `js/src/skills/*.ts`) silently breaks replay.
*Rule: seeds and ticks come from the log/ctx. Nothing in a skill reads the clock or unseeded randomness — including code the lint can't see.*

**#10 `await fetch` in a skill handler.** Handlers also run in the browser sim worker (no DOM) — a fetch there blocks the `ready` handshake and freezes the viewport at "spawning sim worker". Separately, any macrotask between `WebGPURenderer(forceWebGL).init()` and first render permanently collapses the frame.
*Rule: handlers never do their own async I/O. Asset bytes are pre-warmed in `runLive` before `renderer.init()`; a skill needing an unwarmed GLB returns `needsReboot`.*

**#11 State that lives only on the mesh.** The headless authoritative context often has NO mesh; Three meshes are a render projection.
*Rule: per-entity state threads FIVE places or it silently breaks headless writes + snapshot recovery: `EntityEntry`+`bindX` (engine.ts) → the writing skill (state regardless of mesh) → `scene.createEntity` seed → `inspector.snapshot` (+zod) → `worldlog/snapshot.ts` (capture + restore).*

**#12 Fatal hash-mismatch.** `op_sha256` is not byte-identical across the Rust and JS hosts; a `throw` on mismatch quarantined every building ("no structures"). Bit three separate times.
*Rule: every asset hash-verify site WARNS and continues (`asset.hash_mismatch` event); `assetId` pins identity. Also: a plain `sha256sum` will never match — the engine hashes the hex-encoding of the bytes.*

**#13 The stale-comment path trap.** Blender script headers reference `tools/build/…` — that directory doesn't exist (and `build/` is globally gitignored, so never put scripts there). Scripts live in `tools/blender/`. The README's "8 permission profiles" is stale (15). `shoot.mjs`'s banner mentions swiftshader; the code uses real GPU.
*Rule: trust code over comments/docs; when they disagree, fix the comment in passing.*

**#14 GPU renders while the editor is live.** Headless Chromium GPU work OOM-crashed the user's editor WebGPU context (small GPUs).
*Rule: don't run heavy headless GPU renders while the user's editor is connected — ask them to close it, or verify via their live UAT. WS reads (`inspector.snapshot`) are fine.*

**#15 npm at the repo root / wrong runner.** There is no root package.json; `js/` is npm, `tools/` is bun, `js/test` runs through the limina binary (there is no jest/vitest — the binary IS the test runner).
*Rule: run things from where they live, per §4.*

**#16 Trusting the preview.** The preview renderer and the deliverable path disagree (colorspace double-darkening; live-browser asset availability differs from the headless harness).
*Rule: assets are verified by GLB round-trip (author → export → re-import → render); procedural albedo is `SRGBColorSpace`, normals `NoColorSpace`; final proof is the REAL path (`runLive` / `asset.place` on WebGPU).*

**#17 The stale serve.mjs.** An entity "creates but never renders" was hours of pipeline debugging; the cause was an old static-server process 404ing `/assets/**`.
*Rule: before debugging an invisible asset, `curl` the asset route (crib sheet) and check `ps aux | grep serve.mjs` for a server older than the route it must know.*

---

## 6. Quality bars — checkable, per deliverable

Do not report a deliverable done unless every box for its type checks. "Done" claims name the gates run and their exit codes.

### An engine skill
- [ ] Zod input AND output schemas; registered in `registerCoreSkills`; permission string added to the right profile(s) in `permissions.ts`.
- [ ] `npm --prefix js run check:determinism` and `check:portability` pass; nested invokes forward `chainId`.
- [ ] Works headless/meshless (the 5-place entity-state checklist if it writes per-entity state).
- [ ] If render-affecting, classified in `browser-entry.ts` (`LIVE_IN_PLACE_SKILLS` / `LIVE_STRUCTURAL_ADD_SKILLS` / reboot) — decided, not defaulted.
- [ ] A `js/test/pNN_*.ts` gate exists, passes, and includes replay-equivalence (record → replay → `compareWorldState` bit-identical) where state is produced.
- [ ] `bash tools/director/run-gates.sh --quick` green.

### An asset (GLB)
- [ ] Exists as a standalone GLB in `assets/` with a `.card.json` and a QC render, BEFORE any world placement.
- [ ] `npm --prefix js run check:assets` clean: no DEGENERATE (<2cm), no OVERSIZE (>60m axis), metre-scale, grounded.
- [ ] `gates/design/asset-qc-gate.mjs` passes: inside the DesignDirection palette/surface envelope AND meets `art-direction/fidelity-floor.json` (real albedo + normal maps, vertex/tri floor, feature-complete for its class — a building has walls, roof, door, windows).
- [ ] Survives the round-trip: export → `GLTFLoader` re-import → renders correctly (albedo `SRGBColorSpace`).
- [ ] Real-GPU renders from ≥2 angles read with eyes and judged shippable against the reference image / brief — silhouette, proportion, material read. Fidelity ≥ the current floor (the ratchet never goes down).
- [ ] Authored on the strongest model; catalog entry carries `authoredBy`.

### A scene / world / demo
- [ ] Built entirely through engine systems (terrain → climate/vegetation → structures → population — world first, then intelligence); zero hand-placed coordinates where a planner exists.
- [ ] Fully recorded; replays deterministically (relevant `p7x`+ determinism gates green).
- [ ] Rendered on the REAL path (`runLive` / export playback), not only a preview harness; verified on real GPU at eye level (~1.7 m) with the density/fog checks a shippable scene needs.
- [ ] No placeholder primitives standing in for assets; no grey scars where lawns/inclusions belong.
- [ ] Looks ≥ N64/Dreamcast minimum; judged against the Project Gorgon target, honestly.

### A gate / test
- [ ] Exit-code contract: 0 pass, 1 fail, 2 environmental skip (announced, never silent); no stdout-scraped verdicts.
- [ ] Proven falsifiable: a deliberately broken input FAILS it, and that proof exists in code (a `-check.mjs` or the fail-case inside the `pNN`).
- [ ] Wired into `run-gates.sh` so CI runs it.

### A commit / a "done" report
- [ ] Vertical slice (code + gate + evidence); message per §3; `Gates green:` line truthful.
- [ ] The report distinguishes what was verified (with commands) from what was NOT verified (headless skips, taste calls pending user UAT). Unverified ≠ verified-lite; say which it is.

---

## 7. When uncertain — escalation rules

Default: act, through the pipeline, and verify honestly. Escalate only on the triggers below — but on these, ALWAYS escalate.

1. **Taste and art direction** — when a render is technically passing but you're judging "does this look right/beautiful": iterate with your own eyes up to ~3 passes; if still unsure or the user's aesthetic preference could go either way, show renders and ask. Never decide taste silently, never ship "passable" hoping it slides.
2. **A cardinal rule (§2) appears to block the task** — e.g. the fast path is a hand-placed scene, or the engine "needs" a modeler. Stop. Quote the rule, state the conflict, ask. Do not creatively reinterpret the rule (that's how failure mode #2 happened: "through the engine" was misread as "build a generator in the engine").
3. **Destructive or hard-to-reverse actions** — deleting/overwriting committed assets, force-push, rewriting the world-log format, lowering the fidelity floor, editing a gate's thresholds: ask first, every time. Moving a failing asset to `quarantine/` with a README entry is the sanctioned non-destructive alternative.
4. **A gate fails and you don't understand why** — report the failure with output. Never weaken the gate, never mark it skipped, never "fix" it by matching its expectations to your output. If you believe the GATE is wrong, make that case explicitly and wait.
5. **You can't verify a claim honestly** — no GPU/chromium, editor connected (can't run renders), external service down: deliver the work with an explicit "NOT verified: <thing>, because <reason>, verify with <command>". A true "I couldn't verify" is always acceptable; a false "verified" never is.
6. **A capability seems missing** — first search: `skills.search`/`skills.browse`, `tools/dump-skills.ts`, existing gates and demos, the memory index. Most "missing" things exist. If truly missing: small extension of an existing system → do it; new seam or architectural change → write a short plan (house shape, §3) and get sign-off.
7. **Scope changes mid-task** — the fix reveals a second, larger problem (e.g. a seam bug vs. today's symptom): finish or safely park the current slice, report both, let the user pick. Don't silently expand.
8. **Model-tier decisions** — asset/craft authoring is never delegated below the session's strongest model. When in doubt about a subagent's tier for creative work, inherit.
9. **Anything you'd label a "workaround"** — if the honest description of your change contains "workaround", "bypass", "for now", or "hack", that's an escalation trigger: state it plainly and get a yes before it lands.
