# Editor 2.0 Execution — Orchestration Tracker

Driving `plans/design-space-editor-2.0.md` + `plans/studio-unification.md` to a world-class
agent+user development surface (planning · design · Atlas · 3D editor, all interacting, agents
aware of project + app state). Team: **codex (sol)** implements; Claude subagents research +
independently verify; the orchestrator (Claude) writes specs, does high-risk/architectural work,
and **adversarially reviews every slice**.

## Non-negotiables (why the reviewer is strict)
NO HACK · NO TECH DEBT · NO REWARD HACKING. Enforced by review, not trust:
1. Every slice ships a **falsifiable gate** (proves it FAILS on the broken input — CLAUDE.md failure mode #5). No stdout-scraped or tautological verdicts.
2. The orchestrator **re-runs the gate himself** and reads the full diff — no accepting "done" on the implementer's word.
3. Every mutation flows **through the systems** (skills/commands/registry), never a hardcoded bypass. No TODO stubs, no weakened thresholds, no disabled tests, no silent truncation.
4. Vertical-slice commits (impl + gate + evidence). The orchestrator commits only after review passes.
5. Anything an honest description would call "workaround/bypass/for now/hack" is rejected and re-scoped.

## Review protocol (per slice)
1. Read the full working-tree diff.
2. Run the slice's gate(s) + `check:types` + `check:determinism` MYSELF.
3. Verify the gate is genuinely falsifiable (break the input → it fails).
4. Scan for hacks: hardcoded values, bypassed systems, forged verdicts, stubs, weakened gates.
5. Accept → commit as a vertical slice. Reject → return with specific defects. Never partially accept.

## Slice queue

### Phase 0 — Stabilize (foundation; the editor must survive real use)
- **0.1 Base checkpoint** — DONE (orchestrator). Committed `06a90f6` + pushed: baselined the 176-file uncommitted 2.0 program so it's backed up and codex builds on a clean, compiling base. Removed stale `sim-worker.ts}`.
- **Slice 1 — durable trace stops tracing read-only polls** — DONE (codex + review), committed 3c30a50. Root fix for the 195 MB-trace boot-OOM that killed UAT. Durable trace = authoring audit; read-effect skill executions → in-memory ring only, decided from `skillEffect` (same authority the recorder uses). Falsifiable gate `p_trace_reads_not_durable`.
- **Slice 2 — bounded boot-replay for pre-existing large traces** — QUEUED (integrity-sensitive; orchestrator specs carefully). Boot must not replay the whole durable file from offset 0; read only the tail needed for the ring + hash-chain continuation, without weakening `TraceIntegrityError`.

### Phase 1 — World-class editor foundations (highest feel-per-effort; code-verified gaps)
- **Slice 3 — wire `dock-layout.js` into the shell.** The rearrangeable split/tab dock engine is built + unit-tested but imported nowhere; the live shell is fixed accordion sections + a 3-tab switcher + one hard-coded split. Wiring it in is the #1 "pro-editor feel" win. Gate: dock rearrange/persist behavioral test in a real browser.
- **Slice 4 — unify the tool registry to ONE instance.** Today Atlas and viewport each build their own registry with disjoint tools; a cross-surface tool is declared twice. Move to one registry; tools declare `surfaces: ["atlas","viewport"]`. Gate: one registration renders in both surfaces.
- **Slice 5 — complete the Atlas↔3D live link (D3).** Atlas paint → derived recompile → 3D chunk remount within ~1s (push, not the current camera-reveal-only coupling). Gate `p_studio_live_link` (real-GPU UAT for pixels).

### Phase 2 — Plan feature sequence (design-space-editor-2.0 remaining, in plan priority)
- **D5 tail** — Atlas composed-view (base + 3D edit layers, currently invisible in Atlas); village.build/grassField derived targets; paint preview.
- **Ship** — `p_studio_ship` + `op_write_export`; needs the editor-runtime keyframe recorder that doesn't exist yet.
- **2.0-E** — caves (hole-mask channel, cave stamps, underground view) + roads-to-3D (P6, #1 tracked gap). Real-GPU UAT + replay byte-identity gates. Human-in-the-loop UAT slice.
- **2.0-F** — coordination surfaces: agent proposal ghosts in both surfaces, unified approval inbox, task board, chat router (context packs + streaming). `studio.suggest` + `context-pack.js` already exist as the seam.

### Cross-cutting — agents aware of project + app state, act on request (the user's core ask)
Threads through Phase 2 (esp. 2.0-F) + the SOTA plan's Pillars 4/5. The context-pack + studio-events
substrate exists; the work is: a live project/app-state context model the agent reads, and a request→
skill path so an agent can operate any surface on user request. Sequenced after Phase 1 stabilizes the surfaces.

## Honest horizon note
Finishing 2.0 yields a unified, agent-native editor — the *substrate* for world-class. True UE5/Unity
parity (WebGPU Atlas renderer, volumetric/SDF underground, full-catalog ribbon tools, material/anim
authoring) is a multi-phase program beyond 2.0-E, explicitly out of 2.0 scope (D6/WB-U3). The differentiator
is the deterministic-log + Atlas-compiles-to-3D spine — not a UE5 clone.
